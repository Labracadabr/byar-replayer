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
  preset: Preset
  winners: number[]
  players: ReplayPlayer[]
  spectatorCount: number
  parseError: string | null
  favorite: boolean
  note: string
  simStatus: SimStatus
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
  onLibraryChanged(cb: () => void): () => void
  onScanProgress(cb: (p: ScanProgress) => void): () => void
}
