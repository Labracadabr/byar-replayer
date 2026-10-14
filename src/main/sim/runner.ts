// Runs one headless re-simulation: prepares an isolated write dir with the recorder widget, spawns
// spring-headless, tracks progress from stdout, enforces watchdogs and decides success from the DONE marker.
// See docs/headless.md for why each step is needed.
import { spawn } from 'node:child_process'
import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ResolvedDeps } from '../deps/resolver'
import recorderSource from '../../../resources/widget/brv_recorder.lua?raw'

export const RECORDER_NAME = 'BRV Recorder'
const LOAD_TIMEOUT_MS = 15 * 60_000 // cold archive checksums can take minutes
const STALL_TIMEOUT_MS = 3 * 60_000
const OVERRUN_FRAMES = 30 * 120 // past the demo's last keyframe: the end-of-demo signal was missed
const LOG_TAIL_LINES = 80
/** Errors every headless run prints (no GL, no sound): never the reason a run failed */
const HEADLESS_NOISE = /DrawScreen|Draw\w*\(\)|RenderToTexture|shader|GL4|GLSL|LoadSoundFile|sound|texture atlas|FeatureDef|SSAO|LuaMenu/i

export interface SimRunOptions {
  jobDir: string
  demoPath: string
  deps: ResolvedDeps
  /** ASCII-only folder used as HOME/APPDATA for the engine */
  asciiHome: string
  /** shared engine archive cache (ArchiveCache*.lua), copied in and back */
  archiveCacheDir: string
  sampleInterval: number
  projectileInterval: number
  totalFrames: number
  /** write UnitDefs/WeaponDefs to this path (skip if empty: already cached) */
  unitDefsPath: string
  signal: AbortSignal
  onProgress(stage: 'loading' | 'simulating', frame: number): void
  onSpawn?(pid: number): void
}

export interface SimResult {
  rawPath: string
  endReason: string
  lastFrame: number
  warning: string | null
  elapsedMs: number
}

export class SimError extends Error {
  constructor(
    message: string,
    readonly logTail: string
  ) {
    super(message)
  }
}

export function recorderWidget(config: Record<string, string | number>): string {
  const lua =
    'local CONFIG = { ' +
    Object.entries(config)
      .map(([k, v]) => `${k} = ${typeof v === 'number' ? v : JSON.stringify(v.replace(/\\/g, '/'))}`)
      .join(', ') +
    ' }'
  const out = recorderSource.replace(/^local CONFIG = .*-- @@CONFIG@@$/m, lua)
  if (out === recorderSource) throw new Error('recorder template has no CONFIG marker')
  return out
}

/** Last `maxLines` lines of a (possibly huge) text file. */
export function tailFile(path: string, maxLines: number, maxBytes = 256 * 1024): string {
  if (!existsSync(path)) return ''
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const len = Math.min(size, maxBytes)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    return buf.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-maxLines).join('\n')
  } finally {
    closeSync(fd)
  }
}

function linkOrCopy(src: string, dest: string): void {
  try {
    linkSync(src, dest)
  } catch {
    copyFileSync(src, dest)
  }
}

function copyArchiveCache(fromDir: string, toDir: string): void {
  if (!existsSync(fromDir)) return
  mkdirSync(toDir, { recursive: true })
  for (const f of readdirSync(fromDir)) {
    if (!/^ArchiveCache.*\.lua$/.test(f)) continue
    const tmp = join(toDir, f + '.tmp')
    copyFileSync(join(fromDir, f), tmp)
    renameSync(tmp, join(toDir, f)) // atomic: parallel jobs may copy back at the same time
  }
}

export async function runSim(o: SimRunOptions): Promise<SimResult> {
  const t0 = Date.now()
  rmSync(o.jobDir, { recursive: true, force: true })
  mkdirSync(join(o.jobDir, 'LuaUI', 'Widgets'), { recursive: true })
  mkdirSync(join(o.jobDir, 'LuaUI', 'Config'), { recursive: true })
  mkdirSync(o.asciiHome, { recursive: true })

  const rawPath = join(o.jobDir, 'brv_raw.txt')
  writeFileSync(
    join(o.jobDir, 'LuaUI', 'Widgets', 'brv_recorder.lua'),
    recorderWidget({
      sampleInterval: o.sampleInterval,
      projectileInterval: o.projectileInterval,
      output: 'brv_raw.txt',
      unitDefsOutput: o.unitDefsPath ? 'brv_unitdefs.txt' : '',
      progressEvery: 300
    })
  )
  // a widget the handler hasn't seen is loaded disabled unless it ships in the game: pre-enable it
  writeFileSync(
    join(o.jobDir, 'LuaUI', 'Config', 'BYAR.lua'),
    `return { allowUserWidgets = true, order = { ["${RECORDER_NAME}"] = 1 }, data = {} }\n`
  )
  writeFileSync(join(o.jobDir, 'springsettings.cfg'), '')
  const demo = join(o.jobDir, 'demo.sdfz') // engine needs an ASCII path
  copyFileSync(o.demoPath, demo)
  copyArchiveCache(o.archiveCacheDir, join(o.jobDir, 'cache'))

  // the engine only scans <datadir>/maps: use the map's data dir if it has that layout, else link it into ours
  const dataDirs = [...o.deps.dataDirs]
  const mapParent = dirname(o.deps.mapFile)
  if (basename(mapParent).toLowerCase() === 'maps') {
    if (!dataDirs.includes(dirname(mapParent))) dataDirs.push(dirname(mapParent))
  } else {
    mkdirSync(join(o.jobDir, 'maps'), { recursive: true })
    linkOrCopy(o.deps.mapFile, join(o.jobDir, 'maps', basename(o.deps.mapFile)))
  }

  const env: NodeJS.ProcessEnv = { ...process.env, SPRING_DATADIR: dataDirs.join(process.platform === 'win32' ? ';' : ':') }
  // non-ASCII profile paths crash the engine at startup (std::filesystem "Illegal byte sequence")
  for (const k of ['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA']) env[k] = o.asciiHome
  env.HOMEPATH = o.asciiHome.replace(/^[A-Za-z]:/, '')
  env.HOMEDRIVE = o.asciiHome.slice(0, 2)

  const args = ['--write-dir', o.jobDir, '--config', join(o.jobDir, 'springsettings.cfg'), '--only-local', '--nocolor', demo]
  const child = spawn(o.deps.headlessExe, args, { cwd: o.jobDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  if (child.pid) o.onSpawn?.(child.pid)

  let frame = -1
  let lastFrameAt = Date.now()
  let killedFor: string | null = null
  let warning: string | null = null
  let desync: string | null = null
  let finishReason: string | null = null
  const kill = (why: string): void => {
    if (killedFor) return
    killedFor = why
    child.kill()
  }

  const recent: string[] = [] // stdout ring buffer: infolog.txt is buffered and lost when the engine dies
  const onLine = (line: string): void => {
    recent.push(line)
    if (recent.length > LOG_TAIL_LINES) recent.shift()
    const m = line.match(/\[f=(-?\d+)\]/)
    if (m) {
      const f = Number(m[1])
      if (f > frame) {
        frame = f
        lastFrameAt = Date.now()
        o.onProgress(f < 0 ? 'loading' : 'simulating', Math.max(0, f))
      }
    }
    const fin = line.match(/\[BRV\] finish reason=(\w+)/)
    if (fin) finishReason = fin[1]
    if (!desync && /desync|sync error|syncerror/i.test(line)) {
      // the sim no longer matches the recorded game: everything after this point would be wrong
      desync = `frame ${Math.max(frame, 0)}: ${line.replace(/^\[t=[^\]]*\](\[f=[^\]]*\])?\s*/, '').trim().slice(0, 240)}`
      kill('desync')
    }
    if (frame > o.totalFrames + OVERRUN_FRAMES && o.totalFrames > 0) kill('overrun')
  }
  let pending = ''
  const onData = (chunk: Buffer): void => {
    pending += chunk.toString('utf8')
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''
    for (const l of lines) onLine(l)
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  const watchdog = setInterval(() => {
    const idle = Date.now() - lastFrameAt
    if (frame < 0 ? idle > LOAD_TIMEOUT_MS : idle > STALL_TIMEOUT_MS) kill('stalled')
  }, 5000)
  const onAbort = (): void => kill('cancelled')
  o.signal.addEventListener('abort', onAbort)

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('error', (e) => {
      warning = String(e)
      resolve(null)
    })
    child.on('exit', (code) => resolve(code))
  })
  clearInterval(watchdog)
  o.signal.removeEventListener('abort', onAbort)

  const infolog = join(o.jobDir, 'infolog.txt')
  const logTail = recent.length > 0 ? recent.join('\n') : tailFile(infolog, LOG_TAIL_LINES)
  const rawTail = tailFile(rawPath, 1)
  const done = rawTail.match(/^DONE (\w+) (\d+)/)

  if (killedFor === 'cancelled') throw new SimError('Cancelled', logTail)
  if (desync)
    throw new SimError(
      `The simulation desynced from the replay at ${desync}. This usually means the engine, game or map doesn't exactly match the original game.`,
      logTail
    )
  if (done || killedFor === 'overrun') {
    copyArchiveCache(join(o.jobDir, 'cache'), o.archiveCacheDir)
    if (o.unitDefsPath && existsSync(join(o.jobDir, 'brv_unitdefs.txt'))) {
      mkdirSync(dirname(o.unitDefsPath), { recursive: true })
      copyFileSync(join(o.jobDir, 'brv_unitdefs.txt'), o.unitDefsPath)
    }
    return {
      rawPath,
      endReason: done ? done[1] : 'overrun',
      lastFrame: done ? Number(done[2]) : frame,
      warning:
        warning ?? (killedFor === 'overrun' ? 'The engine kept running past the end of the demo; recording was cut there.' : null),
      elapsedMs: Date.now() - t0
    }
  }

  let message: string
  if (killedFor === 'stalled')
    message = frame < 0 ? 'Engine did not finish loading in time.' : `Simulation stalled at frame ${frame}.`
  else if (/has crashed|Unhandled exception|Access violation/i.test(logTail))
    message = `Engine crashed at frame ${Math.max(frame, 0)} (exit code ${exitCode}).`
  else if (frame < 0) message = `Engine exited during loading (exit code ${exitCode}).`
  else message = `Engine exited at frame ${frame} without finishing the recording (exit code ${exitCode}).`
  const errLine = logTail
    .split('\n')
    .reverse()
    .find((l) => /Error|Fatal|crash/i.test(l) && !HEADLESS_NOISE.test(l))
  if (errLine && !message.includes('crashed')) message += ' ' + errLine.replace(/^\[t=[^\]]*\](\[f=[^\]]*\])?\s*/, '').slice(0, 200)
  if (!existsSync(infolog)) message += ' (no engine log written)'
  throw new SimError(message, logTail)
}
