// Resolves the exact engine + game + map a replay needs (a mismatch desyncs the sim), downloading what's missing.
// The BAR install is only read; downloads go to the work dir, except maps, which go into the first map folder.
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { DepKind, DepState, ReplayDeps, Settings } from '@shared/types'
import { barEngineLacksHeadless, downloadEngine, findEngine, HEADLESS_EXE, isRecoilVersion } from './engine'
import { downloadMap, findLocalMap, lookupMapBarCdn, lookupMapDrive } from './maps'
import { downloadGame, findInstalledGame } from './rapid'

export interface DepsRequest {
  engineVersion: string
  gameVersion: string
  mapName: string
}

/** Everything the sim runner needs. */
export interface ResolvedDeps {
  engineDir: string
  headlessExe: string
  /** Data dirs for SPRING_DATADIR, ours first */
  dataDirs: string[]
  /** Data dir holding the game package */
  gameDataDir: string
  mapFile: string
}

export function ourDataDir(s: Settings): string {
  return join(s.workDir, 'data')
}

export class DepsResolver extends EventEmitter {
  /** in-flight downloads keyed by kind:name, shared between replays that need the same thing */
  private inflight = new Map<string, Promise<string>>()
  private states = new Map<string, DepState>()

  constructor(private readonly settings: () => Settings) {
    super()
  }

  private dataDirs(): string[] {
    const s = this.settings()
    return [ourDataDir(s), s.barDataDir]
  }

  /** Offline check of what's installed. */
  check(req: DepsRequest): ReplayDeps {
    const s = this.settings()
    const live = (kind: DepKind, name: string): DepState | undefined => {
      const st = this.states.get(`${kind}:${name}`)
      return st && st.status === 'downloading' ? st : undefined
    }

    const engineDir = findEngine(req.engineVersion, s.barDataDir, s.engineCacheDir)
    const engine: DepState = engineDir
      ? { kind: 'engine', name: req.engineVersion, status: 'ok', path: engineDir }
      : (live('engine', req.engineVersion) ?? {
          kind: 'engine',
          name: req.engineVersion,
          status: isRecoilVersion(req.engineVersion) ? 'missing' : 'unavailable',
          message: !isRecoilVersion(req.engineVersion)
            ? 'Pre-Recoil engine: automatic download not supported.'
            : barEngineLacksHeadless(req.engineVersion, s.barDataDir)
              ? `BAR's copy has no ${HEADLESS_EXE}; will download the full build from GitHub.`
              : 'Will download from the Recoil GitHub releases.'
        })

    const installed = findInstalledGame(req.gameVersion, this.dataDirs())
    const game: DepState = installed
      ? { kind: 'game', name: req.gameVersion, status: 'ok', path: installed.dataDir }
      : (live('game', req.gameVersion) ?? {
          kind: 'game',
          name: req.gameVersion,
          status: 'missing',
          message: 'Will download from the BAR rapid repository.'
        })

    const mapFile = findLocalMap(req.mapName, s.mapDirs)
    const map: DepState = mapFile
      ? { kind: 'map', name: req.mapName, status: 'ok', path: mapFile }
      : (live('map', req.mapName) ?? {
          kind: 'map',
          name: req.mapName,
          status: 'missing',
          message: 'Not in your map folders. Add a folder, or download it from the BAR file server.'
        })

    for (const d of [engine, game, map]) {
      const prev = this.states.get(`${d.kind}:${d.name}`)
      if (prev?.status === 'failed' && d.status === 'missing') Object.assign(d, { status: 'failed', message: prev.message })
    }
    return { engine, game, map }
  }

  /** Downloads whatever is missing; resolves when all three are present. */
  async ensure(req: DepsRequest, signal?: AbortSignal): Promise<ResolvedDeps> {
    const [engineDir, gameDataDir, mapFile] = await Promise.all([
      this.shared('engine', req.engineVersion, () => this.ensureEngine(req.engineVersion, signal)),
      this.shared('game', req.gameVersion, () => this.ensureGame(req.gameVersion, signal)),
      this.shared('map', req.mapName, () => this.ensureMap(req.mapName, signal))
    ])
    return {
      engineDir,
      headlessExe: join(engineDir, HEADLESS_EXE),
      dataDirs: this.dataDirs(),
      gameDataDir,
      mapFile
    }
  }

  private setState(st: DepState): void {
    this.states.set(`${st.kind}:${st.name}`, st)
    this.emit('progress', st)
  }

  private shared(kind: DepKind, name: string, fn: () => Promise<string>): Promise<string> {
    const key = `${kind}:${name}`
    let p = this.inflight.get(key)
    if (!p) {
      p = fn()
        .then((path) => {
          this.setState({ kind, name, status: 'ok', path })
          return path
        })
        .catch((e: unknown) => {
          const message = e instanceof Error ? e.message : String(e)
          this.setState({ kind, name, status: 'failed', message })
          throw new Error(`${kind} "${name}": ${message}`)
        })
        .finally(() => this.inflight.delete(key))
      this.inflight.set(key, p)
    }
    return p
  }

  private progress(kind: DepKind, name: string, message: string, progress: number): void {
    this.setState({ kind, name, status: 'downloading', message, progress })
  }

  private async ensureEngine(version: string, signal?: AbortSignal): Promise<string> {
    const s = this.settings()
    const found = findEngine(version, s.barDataDir, s.engineCacheDir)
    if (found) return found
    this.progress('engine', version, 'Downloading engine…', -1)
    const dir = await downloadEngine(version, s.engineCacheDir, {
      signal,
      onProgress: (p) =>
        this.progress('engine', version, `Downloading engine… ${mb(p.bytes)}`, p.totalBytes ? p.bytes / p.totalBytes : -1)
    })
    return dir
  }

  private async ensureGame(name: string, signal?: AbortSignal): Promise<string> {
    const s = this.settings()
    const found = findInstalledGame(name, this.dataDirs())
    if (found) return found.dataDir
    this.progress('game', name, 'Resolving game version…', -1)
    const stats = await downloadGame(name, ourDataDir(s), [s.barDataDir], {
      signal,
      onProgress: (p) =>
        this.progress('game', name, `Fetching game files ${p.bytes}/${p.totalBytes}`, p.totalBytes ? p.bytes / p.totalBytes : -1)
    })
    this.emit('log', `game ${name}: ${stats.files} files, ${stats.linked} linked, ${stats.copied} copied, ${stats.downloaded} downloaded (${mb(stats.downloadedBytes)})`)
    return ourDataDir(s)
  }

  private async ensureMap(mapName: string, signal?: AbortSignal): Promise<string> {
    const s = this.settings()
    const local = findLocalMap(mapName, s.mapDirs)
    if (local) return local
    if (s.mapDirs.length === 0) throw new Error('No map folder configured to download into.')
    this.progress('map', mapName, 'Looking up map…', -1)
    let remote = await lookupMapBarCdn(mapName, signal).catch(() => null)
    // the CDN may know the exact file name even if our naming guess missed it locally
    if (remote) {
      const again = findLocalMap(mapName, s.mapDirs, remote.fileName)
      if (again) return again
    }
    remote ??= await lookupMapDrive(mapName, s.googleApiKey, signal)
    if (!remote)
      throw new Error(
        s.googleApiKey
          ? 'Map not found on the BAR file server or in the BAR Google Drive folder.'
          : 'Map not found on the BAR file server. Add a Google API key in Settings to also search the BAR Google Drive folder.'
      )
    const src = remote.source === 'bar-cdn' ? 'BAR file server' : 'Google Drive'
    return downloadMap(remote, s.mapDirs[0], {
      signal,
      onProgress: (p) =>
        this.progress(
          'map',
          mapName,
          `Downloading from ${src}… ${mb(p.bytes)}${p.totalBytes ? ' / ' + mb(p.totalBytes) : ''}`,
          p.totalBytes ? p.bytes / p.totalBytes : -1
        )
    })
  }
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
