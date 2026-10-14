// Auto-detection and validation of BAR folders and the app work dir.
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, parse } from 'node:path'
import type { Settings, SettingsProblem } from '@shared/types'

export function isAscii(s: string): boolean {
  return /^[\x00-\x7f]*$/.test(s)
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** A BAR data dir has an engine/ folder plus at least one of maps/, packages/, demos/. */
export function isBarDataDir(p: string): boolean {
  return isDir(join(p, 'engine')) && ['maps', 'packages', 'demos'].some((d) => isDir(join(p, d)))
}

/** Install dirs registered by the BAR installer (Windows uninstall entries). */
function installDirsFromRegistry(): string[] {
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  ]
  const found: string[] = []
  for (const root of roots) {
    let out: string
    try {
      out = execFileSync('reg', ['query', root, '/s', '/f', 'Beyond-All-Reason', '/d'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      continue
    }
    for (const m of out.matchAll(/^\s*(InstallLocation|UninstallString|DisplayIcon)\s+REG_\w+\s+(.+)$/gm)) {
      let v = m[2].trim()
      const quoted = v.match(/^"([^"]+)"/)
      v = quoted ? quoted[1] : v.split(/\s+\//)[0]
      if (!v) continue
      found.push(m[1] === 'InstallLocation' ? v : dirname(v))
    }
  }
  return found
}

export function detectBarDataDir(): string | null {
  const candidates: string[] = []
  if (process.platform === 'win32') {
    candidates.push(...installDirsFromRegistry().map((d) => join(d, 'data')))
    const local = process.env.LOCALAPPDATA
    if (local) candidates.push(join(local, 'Programs', 'Beyond-All-Reason', 'data'))
    for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (pf) candidates.push(join(pf, 'Beyond-All-Reason', 'data'))
    }
    for (let c = 67; c <= 90; c++) {
      const drive = String.fromCharCode(c) + ':\\'
      candidates.push(join(drive, 'Beyond-All-Reason', 'data'), join(drive, 'Games', 'Beyond-All-Reason', 'data'))
    }
  } else {
    const home = process.env.HOME ?? ''
    candidates.push(join(home, '.local', 'state', 'Beyond All Reason'), join(home, 'Documents', 'Beyond All Reason'))
  }
  return candidates.find(isBarDataDir) ?? null
}

/**
 * Default work dir: next to the BAR install (e.g. D:\Dmitrii\bar-replay-viewer for D:\Dmitrii\Beyond-All-Reason),
 * because the engine needs ASCII-only paths and user profile dirs may not be.
 */
export function defaultWorkDir(barDataDir: string | null): string {
  if (barDataDir) {
    const installDir = dirname(barDataDir)
    const candidate = join(dirname(installDir), 'bar-replay-viewer')
    if (isAscii(candidate)) return candidate
  }
  if (process.platform === 'win32') return join(process.env.ProgramData ?? 'C:\\ProgramData', 'bar-replay-viewer')
  return join(process.env.HOME ?? '/tmp', '.bar-replay-viewer')
}

export function defaultSettings(): Settings {
  const bar = detectBarDataDir()
  const workDir = defaultWorkDir(bar)
  return {
    barDataDir: bar ?? '',
    demoDirs: bar ? [join(bar, 'demos')] : [],
    mapDirs: bar ? [join(bar, 'maps')] : [],
    workDir,
    engineCacheDir: join(workDir, 'engines'),
    concurrency: 0, // 0 = auto (cores - 1)
    sampleInterval: 15,
    googleApiKey: ''
  }
}

export function validateSettings(s: Settings): SettingsProblem[] {
  const problems: SettingsProblem[] = []
  if (!s.barDataDir) problems.push({ field: 'barDataDir', message: 'BAR data folder not found. Please select it.' })
  else if (!isAbsolute(s.barDataDir) || !isBarDataDir(s.barDataDir))
    problems.push({ field: 'barDataDir', message: `Not a BAR data folder (no engine/ + maps/packages/demos): ${s.barDataDir}` })
  if (s.demoDirs.length === 0) problems.push({ field: 'demoDirs', message: 'No replay folder configured.' })
  for (const d of s.demoDirs)
    if (!isDir(d)) problems.push({ field: 'demoDirs', message: `Replay folder does not exist: ${d}` })
  for (const d of s.mapDirs) if (!isDir(d)) problems.push({ field: 'mapDirs', message: `Map folder does not exist: ${d}` })
  if (!s.workDir) problems.push({ field: 'workDir', message: 'Work folder not set.' })
  else if (!isAbsolute(s.workDir)) problems.push({ field: 'workDir', message: `Work folder must be an absolute path: ${s.workDir}` })
  else if (!isAscii(s.workDir))
    problems.push({
      field: 'workDir',
      message: 'Work folder must contain only ASCII characters (the Recoil engine crashes on non-ASCII paths).'
    })
  else if (!existsSync(parse(s.workDir).root))
    problems.push({ field: 'workDir', message: `Drive does not exist: ${parse(s.workDir).root}` })
  return problems
}
