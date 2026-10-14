// Persistent simulation queue: jobs live in SQLite, so they survive app restarts. Runs up to N sims in parallel,
// each: resolve dependencies -> headless sim -> move the recording into <work>/recordings/replay-<id>/.
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { cpus, totalmem } from 'node:os'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isResumedGame } from '@shared/sim-status'
import type { JobInfo, JobStage, JobStatus, Settings } from '@shared/types'
import type { Db } from '../db'
import type { DepsResolver } from '../deps/resolver'
import type { Library } from '../library'
import convertWorkerPath from '../stream/convert-worker?modulePath'
import type { ConvertJob, ConvertMessage } from '../stream/convert-worker'
import type { ConvertResult } from '../stream/convert'
import { Worker } from 'node:worker_threads'
import { runSim, SimError } from './runner'

const PROJECTILE_INTERVAL = 5
/** a big team game peaked at ~5 GB in spring-headless */
const RAM_PER_SIM = 6 * 1024 ** 3

/** Kills a leftover engine from a crashed app session; checks the image name so a reused pid is left alone. */
function killIfEngine(pid: number): void {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
      if (!/spring-headless/i.test(out)) return
    }
    process.kill(pid)
  } catch {
    // already gone
  }
}

/** Raw recordings are 70–180 MB of text; set BRV_KEEP_RAW=1 to keep them after conversion (debugging). */
const KEEP_RAW = process.env.BRV_KEEP_RAW === '1'

function convertInWorker(job: ConvertJob): Promise<ConvertResult> {
  return new Promise((resolve, reject) => {
    const w = new Worker(convertWorkerPath, { workerData: job })
    w.once('message', (m: ConvertMessage) => (m.ok ? resolve(m.result) : reject(new Error(`Conversion failed: ${m.error}`))))
    w.once('error', reject)
    w.once('exit', (code) => code !== 0 && reject(new Error(`Converter exited with code ${code}`)))
  })
}

export function autoConcurrency(): number {
  return Math.max(1, Math.min(cpus().length - 1, Math.floor(totalmem() / RAM_PER_SIM)))
}

interface JobRow {
  id: number
  replay_id: number
  status: JobStatus
  stage: JobStage | null
  frame: number
  total_frames: number
  error: string | null
  warning: string | null
  log_tail: string | null
  end_reason: string | null
  raw_path: string | null
  stream_path: string | null
  work_dir: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
  pid: number | null
}

function toInfo(r: JobRow): JobInfo {
  return {
    jobId: r.id,
    replayId: r.replay_id,
    status: r.status,
    stage: r.stage,
    frame: r.frame,
    totalFrames: r.total_frames,
    error: r.error,
    warning: r.warning,
    logTail: r.log_tail,
    endReason: r.end_reason,
    rawPath: r.raw_path,
    streamPath: r.stream_path,
    workDir: r.work_dir,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at
  }
}

export class SimQueue extends EventEmitter {
  private running = new Map<number, AbortController>() // jobId -> abort
  private lastDbWrite = new Map<number, number>()
  private stopped = false

  constructor(
    private readonly db: Db,
    private readonly library: Library,
    private readonly deps: DepsResolver,
    private readonly settings: () => Settings
  ) {
    super()
  }

  /** Jobs left 'running' by a previous app session are re-queued; their orphaned engines are killed. */
  start(): void {
    const stale = this.db.prepare(`SELECT pid FROM sim_jobs WHERE status = 'running' AND pid IS NOT NULL`).all() as {
      pid: number
    }[]
    for (const { pid } of stale) killIfEngine(pid)
    this.db.prepare(`UPDATE sim_jobs SET status = 'queued', stage = NULL, frame = 0, pid = NULL WHERE status = 'running'`).run()
    // recordings made before the stream converter existed (or interrupted during conversion) only need converting
    this.db
      .prepare(`UPDATE sim_jobs SET status = 'queued' WHERE status = 'done' AND stream_path IS NULL AND raw_path IS NOT NULL`)
      .run()
    this.pump()
  }

  stop(): void {
    this.stopped = true
    for (const ac of this.running.values()) ac.abort()
  }

  concurrency(): number {
    return this.settings().concurrency > 0 ? this.settings().concurrency : autoConcurrency()
  }

  latestJob(replayId: number): JobInfo | null {
    const r = this.db.prepare('SELECT * FROM sim_jobs WHERE replay_id = ? ORDER BY id DESC LIMIT 1').get(replayId) as
      | JobRow
      | undefined
    return r ? toInfo(r) : null
  }

  enqueue(replayId: number): JobInfo {
    const cur = this.latestJob(replayId)
    if (cur && (cur.status === 'queued' || cur.status === 'running')) return cur
    const replay = this.library.get(replayId)
    if (!replay) throw new Error(`Unknown replay ${replayId}`)
    if (replay.parseError) throw new Error(`Replay can't be read: ${replay.parseError}`)
    if (replay.lastFrame < 0) throw new Error('This game never started; there is nothing to simulate.')
    if (isResumedGame(replay))
      throw new Error(
        "This replay continues a saved game. The saved game state isn't stored in the replay, so it can't be re-simulated."
      )
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO sim_jobs (replay_id, status, total_frames, created_at) VALUES (?, 'queued', ?, ?)`)
      .run(replayId, replay.lastFrame, Date.now())
    const job = this.get(Number(lastInsertRowid))
    this.emitJob(job)
    this.pump()
    return job
  }

  cancel(replayId: number): void {
    const job = this.latestJob(replayId)
    if (!job) return
    if (job.status === 'queued') {
      this.update(job.jobId, { status: 'cancelled', finished_at: Date.now() })
    } else if (job.status === 'running') {
      this.running.get(job.jobId)?.abort()
    }
  }

  /** Deletes recordings, leftover engine dirs and the job history of a replay. */
  deleteData(replayId: number): void {
    const job = this.latestJob(replayId)
    if (job && (job.status === 'running' || job.status === 'queued'))
      throw new Error('Cancel the simulation before deleting its data.')
    const rows = this.db.prepare('SELECT work_dir FROM sim_jobs WHERE replay_id = ?').all(replayId) as { work_dir: string | null }[]
    for (const r of rows) if (r.work_dir) rmSync(r.work_dir, { recursive: true, force: true })
    rmSync(this.recordingDir(replayId), { recursive: true, force: true })
    this.db.prepare('DELETE FROM sim_jobs WHERE replay_id = ?').run(replayId)
    this.emit('changed', replayId)
  }

  recordingDir(replayId: number): string {
    return join(this.settings().workDir, 'recordings', `replay-${replayId}`)
  }

  unitDefsPath(gameVersion: string): string {
    return join(this.settings().workDir, 'cache', 'unitdefs', gameVersion.replace(/[^\w.-]+/g, '_') + '.txt')
  }

  private get(jobId: number): JobInfo {
    return toInfo(this.db.prepare('SELECT * FROM sim_jobs WHERE id = ?').get(jobId) as unknown as JobRow)
  }

  private update(jobId: number, fields: Partial<Omit<JobRow, 'id'>>): JobInfo {
    const cols = Object.keys(fields)
    this.db
      .prepare(`UPDATE sim_jobs SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...(Object.values(fields) as (string | number | null)[]), jobId)
    const job = this.get(jobId)
    this.emitJob(job)
    return job
  }

  private emitJob(job: JobInfo): void {
    this.emit('job', job)
  }

  private pump(): void {
    if (this.stopped) return
    while (this.running.size < this.concurrency()) {
      const next = this.db
        .prepare(`SELECT id FROM sim_jobs WHERE status = 'queued' ORDER BY priority DESC, id ASC LIMIT 1`)
        .get() as { id: number } | undefined
      if (!next) return
      const ac = new AbortController()
      this.running.set(next.id, ac)
      this.update(next.id, { status: 'running', stage: 'deps', started_at: Date.now(), error: null, warning: null })
      void this.run(next.id, ac).finally(() => {
        this.running.delete(next.id)
        this.lastDbWrite.delete(next.id)
        this.pump()
      })
    }
  }

  private async run(jobId: number, ac: AbortController): Promise<void> {
    const job = this.get(jobId)
    const replay = this.library.get(job.replayId)
    const s = this.settings()
    const jobDir = join(s.workDir, 'simwork', `job-${jobId}`)
    try {
      if (!replay) throw new Error('Replay no longer in the library.')
      if (!existsSync(replay.path)) throw new Error(`Replay file is missing: ${replay.path}`)
      const outDir = this.recordingDir(job.replayId)
      let raw = job.rawPath && existsSync(job.rawPath) ? job.rawPath : null
      let endReason = job.endReason ?? 'unknown'
      let warning = job.warning
      let lastFrame = job.frame
      if (!raw) {
        const deps = await this.deps.ensure(
          { engineVersion: replay.engineVersion, gameVersion: replay.gameVersion, mapName: replay.mapName },
          ac.signal
        )
        if (ac.signal.aborted) throw new SimError('Cancelled', '')
        this.update(jobId, { stage: 'loading', work_dir: jobDir })
        const unitDefsPath = this.unitDefsPath(replay.gameVersion)
        const result = await runSim({
          jobDir,
          demoPath: replay.path,
          deps,
          asciiHome: join(s.workDir, 'home'),
          archiveCacheDir: join(s.workDir, 'cache', 'engine'),
          sampleInterval: s.sampleInterval,
          projectileInterval: PROJECTILE_INTERVAL,
          totalFrames: replay.lastFrame,
          unitDefsPath: existsSync(unitDefsPath) ? '' : unitDefsPath,
          signal: ac.signal,
          onProgress: (stage, frame) => this.progress(jobId, stage, frame),
          onSpawn: (pid) => this.db.prepare('UPDATE sim_jobs SET pid = ? WHERE id = ?').run(pid, jobId)
        })
        rmSync(outDir, { recursive: true, force: true })
        mkdirSync(outDir, { recursive: true })
        raw = join(outDir, 'raw.txt')
        renameSync(result.rawPath, raw)
        rmSync(jobDir, { recursive: true, force: true })
        this.clearOldWorkDirs(job.replayId, jobId)
        endReason = result.endReason
        warning = result.warning
        lastFrame = result.lastFrame
        this.emit('log', `job ${jobId} simulated in ${(result.elapsedMs / 1000).toFixed(0)}s (${result.endReason})`)
      }
      // the raw recording is kept until the stream exists, so a crash here only repeats the conversion
      this.update(jobId, { stage: 'finalizing', raw_path: raw, end_reason: endReason, warning, frame: lastFrame, work_dir: null, pid: null })
      const streamPath = join(outDir, 'game.brvs')
      const conv = await convertInWorker({
        demoPath: replay.path,
        rawPath: raw,
        unitDefsPath: this.unitDefsPath(replay.gameVersion),
        outPath: streamPath,
        gameId: replay.gameId
      })
      if (!KEEP_RAW) rmSync(raw, { force: true })
      this.update(jobId, {
        status: 'done',
        stage: null,
        stream_path: streamPath,
        raw_path: KEEP_RAW ? raw : null,
        finished_at: Date.now()
      })
      this.emit('log', `job ${jobId}: stream ${(conv.bytes / 1024 / 1024).toFixed(1)} MB in ${conv.elapsedMs} ms`)
    } catch (e) {
      const cancelled = ac.signal.aborted
      const message = e instanceof Error ? e.message : String(e)
      if (cancelled) rmSync(jobDir, { recursive: true, force: true })
      this.update(jobId, {
        status: cancelled ? 'cancelled' : 'failed',
        stage: null,
        error: cancelled ? null : message,
        log_tail: e instanceof SimError ? e.logTail : null,
        work_dir: cancelled ? null : existsSync(jobDir) ? jobDir : null,
        pid: null,
        finished_at: Date.now()
      })
    }
  }

  /** Engine dirs kept from earlier failed attempts are no longer interesting once a run succeeds. */
  private clearOldWorkDirs(replayId: number, exceptJobId: number): void {
    const rows = this.db
      .prepare('SELECT id, work_dir FROM sim_jobs WHERE replay_id = ? AND id <> ? AND work_dir IS NOT NULL')
      .all(replayId, exceptJobId) as { id: number; work_dir: string }[]
    for (const r of rows) {
      rmSync(r.work_dir, { recursive: true, force: true })
      this.db.prepare('UPDATE sim_jobs SET work_dir = NULL WHERE id = ?').run(r.id)
    }
  }

  private progress(jobId: number, stage: JobStage, frame: number): void {
    const now = Date.now()
    // UI gets every update; the db at most once a second
    if (now - (this.lastDbWrite.get(jobId) ?? 0) > 1000) {
      this.lastDbWrite.set(jobId, now)
      this.update(jobId, { stage, frame })
    } else {
      const job = this.get(jobId)
      this.emitJob({ ...job, stage, frame })
    }
  }
}
