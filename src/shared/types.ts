// Types shared between the main process, preload and renderer.

export interface Settings {
  /** BAR data dir, e.g. D:\Beyond-All-Reason\data (contains engine/, maps/, packages/, demos/) */
  barDataDir: string
  /** Folders scanned for .sdfz replays */
  demoDirs: string[]
  /** Folders searched for map archives (.sd7/.sdz) */
  mapDirs: string[]
  /** App work dir: library db, sim jobs, state streams, caches. Must be an ASCII-only path (engine limitation). */
  workDir: string
  /** Where downloaded engine builds are cached */
  engineCacheDir: string
  /** Max simultaneous headless sims */
  concurrency: number
  /** Sim frames between unit samples (30 frames = 1 s) */
  sampleInterval: number
  /** Optional Google API key for the Drive map fallback */
  googleApiKey: string
}

export type SettingsProblemField = 'barDataDir' | 'demoDirs' | 'mapDirs' | 'workDir'

export interface SettingsProblem {
  field: SettingsProblemField
  message: string
}

export interface SettingsState {
  settings: Settings
  problems: SettingsProblem[]
}

export type Preset = 'duel' | 'team' | 'ffa' | 'teamffa' | 'pve' | 'unknown'

export type SimStatus = 'none' | 'queued' | 'running' | 'ready' | 'failed'

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
export type JobStage = 'deps' | 'loading' | 'simulating' | 'finalizing'

export interface JobInfo {
  jobId: number
  replayId: number
  status: JobStatus
  stage: JobStage | null
  frame: number
  totalFrames: number
  error: string | null
  warning: string | null
  /** last lines of the engine infolog, for failed jobs */
  logTail: string | null
  endReason: string | null
  rawPath: string | null
  /** compact state stream for the player (docs/format.md) */
  streamPath: string | null
  workDir: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export interface ReplayPlayer {
  name: string
  teamId: number
  allyTeamId: number
  color: string // #rrggbb
  isAI: boolean
  faction?: string
  skill?: string
}

export interface ReplaySummary {
  id: number
  path: string
  fileName: string
  fileSize: number
  gameId: string
  engineVersion: string
  gameVersion: string
  mapName: string
  /** ms since epoch */
  startTime: number
  /** ms of actual game time (from last keyframe; works for aborted games) */
  durationMs: number
  lastFrame: number
  /** > 0 when the replay continues a saved game: such games can't be re-simulated */
  firstFrame: number
  preset: Preset
  winners: number[]
  players: ReplayPlayer[]
  spectatorCount: number
  parseError: string | null
  favorite: boolean
  note: string
  simStatus: SimStatus
  simStage: JobStage | null
  simProgress: number
}

export interface ReplayDetail extends ReplaySummary {
  gameSettings: Record<string, string>
  mapSettings: Record<string, string>
}

export interface ScanProgress {
  running: boolean
  done: number
  total: number
  current?: string
}

export type DepKind = 'engine' | 'game' | 'map'

/** ok: installed · missing: can be downloaded · downloading · failed: download failed · unavailable: can't be fetched */
export type DepStatus = 'ok' | 'missing' | 'downloading' | 'failed' | 'unavailable'

export interface DepState {
  kind: DepKind
  name: string
  status: DepStatus
  path?: string
  message?: string
  /** 0..1, or -1 when unknown */
  progress?: number
}

export interface ReplayDeps {
  engine: DepState
  game: DepState
  map: DepState
}

/** API exposed to the renderer on window.api */
export interface Api {
  getSettings(): Promise<SettingsState>
  saveSettings(patch: Partial<Settings>): Promise<SettingsState>
  pickFolder(title: string, defaultPath?: string): Promise<string | null>
  listReplays(): Promise<ReplaySummary[]>
  getReplay(id: number): Promise<ReplayDetail | null>
  setFavorite(id: number, favorite: boolean): Promise<void>
  setNote(id: number, note: string): Promise<void>
  rescan(): Promise<void>
  showInFolder(path: string): Promise<void>
  /** Offline check of engine/game/map for a replay */
  checkDeps(id: number): Promise<ReplayDeps>
  /** Download whatever is missing; resolves with the final state (failures are reported in the states) */
  ensureDeps(id: number): Promise<ReplayDeps>
  /** Lets the user add a folder that contains the missing map */
  addMapFolder(): Promise<SettingsState | null>
  onDepProgress(cb: (st: DepState) => void): () => void
  /** Queue a (re-)simulation; returns the job */
  simulate(id: number): Promise<JobInfo>
  cancelSim(id: number): Promise<void>
  /** Remove recordings and job history for a replay */
  deleteSimData(id: number): Promise<void>
  getJob(id: number): Promise<JobInfo | null>
  onJobUpdate(cb: (job: JobInfo) => void): () => void
  onLibraryChanged(cb: () => void): () => void
  onScanProgress(cb: (p: ScanProgress) => void): () => void
}
