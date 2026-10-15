// Replay library: scans demo folders, keeps the SQLite index in sync, watches for new files.
import { EventEmitter } from 'node:events'
import { readdirSync, realpathSync, statSync, watch, type FSWatcher } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { simStatusOf } from '@shared/sim-status'
import type { JobInfo, JobStage, Preset, ReplayDetail, ReplayPlayer, ReplaySummary, ScanProgress } from '@shared/types'
import type { Db } from './db'
import { PARSER_VERSION, readDemoMeta } from './demo-meta'

interface ReplayRow {
  id: number
  path: string
  file_name: string
  file_size: number
  file_mtime: number
  source: string
  game_id: string
  engine_version: string
  game_version: string
  map_name: string
  start_time: number
  duration_ms: number
  last_frame: number
  first_frame: number
  preset: string
  winners_json: string
  players_json: string
  spectator_count: number
  settings_json: string
  parse_error: string | null
  favorite: number
  note: string
  job_status: string | null
  job_frame: number | null
  job_total: number | null
  job_stage: string | null
}

const SELECT = `
  SELECT r.*, j.status AS job_status, j.frame AS job_frame, j.total_frames AS job_total, j.stage AS job_stage
  FROM replays r
  LEFT JOIN sim_jobs j ON j.id = (SELECT id FROM sim_jobs WHERE replay_id = r.id ORDER BY id DESC LIMIT 1)
  WHERE r.missing = 0`


function toSummary(row: ReplayRow): ReplaySummary {
  const sim = simStatusOf(
    row.job_status ? { status: row.job_status as JobInfo['status'], frame: row.job_frame ?? 0, totalFrames: row.job_total ?? 0 } : null
  )
  return {
    id: row.id,
    path: row.path,
    fileName: row.file_name,
    fileSize: row.file_size,
    source: row.source === 'manual' ? 'manual' : 'scan',
    gameId: row.game_id,
    engineVersion: row.engine_version,
    gameVersion: row.game_version,
    mapName: row.map_name,
    startTime: row.start_time,
    durationMs: row.duration_ms,
    lastFrame: row.last_frame,
    firstFrame: row.first_frame,
    preset: row.preset as Preset,
    winners: JSON.parse(row.winners_json) as number[],
    players: JSON.parse(row.players_json) as ReplayPlayer[],
    spectatorCount: row.spectator_count,
    parseError: row.parse_error,
    favorite: row.favorite === 1,
    note: row.note,
    simStatus: sim.status,
    simStage: row.job_status === 'running' ? (row.job_stage as JobStage | null) : null,
    simProgress: sim.progress
  }
}

/** Start time from the demo file name (YYYY-MM-DD_HH-MM-SS-mmm_...), used when the file can't be parsed. */
function timeFromFileName(name: string): number {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/)
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0
}

export class Library extends EventEmitter {
  private watchers: FSWatcher[] = []
  private pending = new Set<string>()
  private debounce: NodeJS.Timeout | null = null
  private scanning: Promise<void> | null = null
  private progress: ScanProgress = { running: false, done: 0, total: 0 }

  constructor(
    private readonly db: Db,
    private demoDirs: string[]
  ) {
    super()
  }

  list(): ReplaySummary[] {
    const rows = this.db.prepare(SELECT + ' ORDER BY r.start_time DESC').all() as unknown as ReplayRow[]
    return rows.map(toSummary)
  }

  get(id: number): ReplayDetail | null {
    const row = this.db.prepare(SELECT + ' AND r.id = ?').get(id) as unknown as ReplayRow | undefined
    if (!row) return null
    const s = JSON.parse(row.settings_json) as { gameSettings?: Record<string, string>; mapSettings?: Record<string, string> }
    return { ...toSummary(row), gameSettings: s.gameSettings ?? {}, mapSettings: s.mapSettings ?? {} }
  }

  setFavorite(id: number, favorite: boolean): void {
    this.db.prepare('UPDATE replays SET favorite = ? WHERE id = ?').run(favorite ? 1 : 0, id)
  }

  /** Removes a replay row (and, via foreign keys, its jobs). The replay file is not touched. */
  remove(id: number): void {
    this.db.prepare('DELETE FROM replays WHERE id = ?').run(id)
    this.emit('changed')
  }

  setNote(id: number, note: string): void {
    this.db.prepare('UPDATE replays SET note = ? WHERE id = ?').run(note, id)
  }

  setDemoDirs(dirs: string[]): void {
    this.demoDirs = dirs
    this.startWatching()
  }

  /** Full scan of all demo folders: index new/changed files, mark vanished ones missing. */
  scan(): Promise<void> {
    this.scanning ??= this.doScan().finally(() => (this.scanning = null))
    return this.scanning
  }

  /** Add replays outside the configured folders (drag & drop / file picker); returns their ids. */
  async addManual(paths: string[]): Promise<number[]> {
    const ids: number[] = []
    for (const p of paths) {
      const path = resolve(p)
      if (!path.toLowerCase().endsWith('.sdfz') || !this.exists(path)) continue
      // files inside a scanned folder keep their 'scan' source; anything else is remembered as manual
      const inScanned = this.demoDirs.some((d) => resolve(d).toLowerCase() === resolve(path, '..').toLowerCase())
      await this.indexFile(path, inScanned ? 'scan' : 'manual')
      const row = this.db.prepare('SELECT id FROM replays WHERE path = ?').get(path) as { id: number } | undefined
      if (row) ids.push(row.id)
    }
    this.emit('changed')
    return ids
  }

  startWatching(): void {
    this.stopWatching()
    for (const configured of this.demoDirs) {
      try {
        // Windows: watching an 8.3 short path (C:\Users\ABCD~1\...) trips a libuv assertion that kills the
        // process when an event arrives, so always watch the canonical long path.
        const dir = realpathSync.native(configured)
        const w = watch(dir, (_event, name) => {
          if (!name || !name.toString().toLowerCase().endsWith('.sdfz')) return
          this.pending.add(join(dir, name.toString()))
          if (this.debounce) clearTimeout(this.debounce)
          // BAR writes demos incrementally during a game; wait for the writes to settle
          this.debounce = setTimeout(() => void this.flushPending(), 3000)
        })
        w.on('error', () => w.close())
        this.watchers.push(w)
      } catch {
        // folder missing: reported through settings validation
      }
    }
  }

  stopWatching(): void {
    for (const w of this.watchers) w.close()
    this.watchers = []
  }

  scanProgress(): ScanProgress {
    return this.progress
  }

  private setProgress(p: ScanProgress): void {
    this.progress = p
    this.emit('progress', p)
  }

  private async flushPending(): Promise<void> {
    const files = [...this.pending]
    this.pending.clear()
    for (const f of files) {
      try {
        statSync(f)
        await this.indexFile(f, 'scan')
      } catch {
        this.db.prepare('UPDATE replays SET missing = 1 WHERE path = ?').run(f)
      }
    }
    this.emit('changed')
  }

  private async doScan(): Promise<void> {
    const files: string[] = []
    for (const dir of this.demoDirs) {
      try {
        for (const name of readdirSync(dir)) if (name.toLowerCase().endsWith('.sdfz')) files.push(join(dir, name))
      } catch {
        // missing folder: reported through settings validation
      }
    }
    const seen = new Set(files)
    // scanned rows whose file vanished => missing; manual rows are checked individually
    const known = this.db.prepare('SELECT path, source FROM replays WHERE missing = 0').all() as { path: string; source: string }[]
    for (const k of known) {
      if (k.source === 'scan' ? !seen.has(k.path) : !this.exists(k.path))
        this.db.prepare('UPDATE replays SET missing = 1 WHERE path = ?').run(k.path)
    }
    this.setProgress({ running: true, done: 0, total: files.length })
    let changed = false
    for (let i = 0; i < files.length; i++) {
      this.setProgress({ running: true, done: i, total: files.length, current: basename(files[i]) })
      if (await this.indexFile(files[i], 'scan')) changed = true
      if (changed && i % 20 === 19) this.emit('changed')
      await new Promise((r) => setImmediate(r)) // keep the main process responsive
    }
    this.setProgress({ running: false, done: files.length, total: files.length })
    this.emit('changed')
  }

  private exists(p: string): boolean {
    try {
      statSync(p)
      return true
    } catch {
      return false
    }
  }

  /** Returns true if the row was inserted or updated. */
  private async indexFile(path: string, source: 'scan' | 'manual'): Promise<boolean> {
    const st = statSync(path)
    const mtime = Math.floor(st.mtimeMs)
    const existing = this.db
      .prepare('SELECT id, file_size, file_mtime, parser_version, missing FROM replays WHERE path = ?')
      .get(path) as { id: number; file_size: number; file_mtime: number; parser_version: number; missing: number } | undefined
    if (
      existing &&
      existing.file_size === st.size &&
      existing.file_mtime === mtime &&
      existing.parser_version === PARSER_VERSION &&
      existing.missing === 0
    )
      return false

    const fileName = basename(path)
    let fields: Record<string, string | number | null>
    try {
      const m = await readDemoMeta(path)
      const search = [m.mapName, ...m.players.map((p) => p.name)].join(' ').toLowerCase()
      fields = {
        game_id: m.gameId,
        engine_version: m.engineVersion,
        game_version: m.gameVersion,
        map_name: m.mapName,
        start_time: m.startTime,
        duration_ms: m.durationMs,
        last_frame: m.lastFrame,
        first_frame: Math.max(0, m.firstFrame),
        preset: m.preset,
        winners_json: JSON.stringify(m.winners),
        players_json: JSON.stringify(m.players),
        spectator_count: m.spectatorCount,
        settings_json: JSON.stringify({ gameSettings: m.gameSettings, mapSettings: m.mapSettings }),
        search_text: search,
        parse_error: null
      }
    } catch (e) {
      fields = {
        start_time: timeFromFileName(fileName),
        search_text: fileName.toLowerCase(),
        parse_error: e instanceof Error ? e.message : String(e)
      }
    }
    const common = { file_name: fileName, file_size: st.size, file_mtime: mtime, parser_version: PARSER_VERSION, missing: 0, ...fields }
    const cols = Object.keys(common)
    const vals = Object.values(common)
    if (existing) {
      this.db.prepare(`UPDATE replays SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...vals, existing.id)
    } else {
      this.db
        .prepare(`INSERT INTO replays (path, source, added_at, ${cols.join(', ')}) VALUES (?, ?, ?, ${cols.map(() => '?').join(', ')})`)
        .run(path, source, Date.now(), ...vals)
    }
    return true
  }
}
