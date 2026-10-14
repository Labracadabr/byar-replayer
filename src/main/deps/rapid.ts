// Minimal rapid client: resolves a game name ("Beyond All Reason test-29253-bcb13f6") to an .sdp package and
// downloads it into our own data dir. Pool files BAR already has are hardlinked (no copy, BAR stays untouched).
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { fetchOk, type Progress } from './download'

export const REPO_MASTER = 'https://repos-cdn.beyondallreason.dev/repos.gz'
const VERSIONS_MAX_AGE_MS = 60 * 60 * 1000

export interface RapidEntry {
  tag: string
  md5: string // sdp name
  name: string // full game name
  repoUrl: string // e.g. https://repos-cdn.beyondallreason.dev/byar
}

export interface SdpFile {
  name: string
  md5: string
  size: number
}

export function parseSdp(gz: Buffer): SdpFile[] {
  const data = gunzipSync(gz)
  const out: SdpFile[] = []
  let i = 0
  while (i < data.length) {
    const n = data[i++]
    const name = data.subarray(i, i + n).toString('utf8')
    i += n
    const md5 = data.subarray(i, i + 16).toString('hex')
    i += 16
    i += 4 // crc32
    const size = data.readUInt32BE(i)
    i += 4
    out.push({ name, md5, size })
  }
  return out
}

export function parseVersions(gz: Buffer, repoUrl: string): RapidEntry[] {
  return gunzipSync(gz)
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [tag, md5, , ...rest] = line.split(',')
      return { tag, md5, name: rest.join(','), repoUrl }
    })
}

export function poolPath(dataDir: string, md5: string): string {
  return join(dataDir, 'pool', md5.slice(0, 2), md5.slice(2) + '.gz')
}

/** All versions.gz files under <dataDir>/rapid/<host>/<repo>/ */
function localVersionFiles(dataDir: string): { file: string; repoUrl: string }[] {
  const root = join(dataDir, 'rapid')
  const out: { file: string; repoUrl: string }[] = []
  if (!existsSync(root)) return out
  for (const host of readdirSync(root)) {
    const hostDir = join(root, host)
    if (!statSync(hostDir).isDirectory()) continue
    for (const repo of readdirSync(hostDir)) {
      const file = join(hostDir, repo, 'versions.gz')
      if (existsSync(file)) out.push({ file, repoUrl: `https://${host}/${repo}` })
    }
  }
  return out
}

/** Games we downloaded, so they stay findable even when no versions.gz in that dir lists them. */
const INSTALLED_INDEX = 'brv-installed-games.json'

function readInstalledIndex(dataDir: string): RapidEntry[] {
  try {
    return JSON.parse(readFileSync(join(dataDir, INSTALLED_INDEX), 'utf8')) as RapidEntry[]
  } catch {
    return []
  }
}

function recordInstalled(dataDir: string, entry: RapidEntry): void {
  const list = readInstalledIndex(dataDir).filter((e) => e.md5 !== entry.md5)
  list.push(entry)
  writeFileSync(join(dataDir, INSTALLED_INDEX), JSON.stringify(list, null, 1))
}

export function findEntryLocally(name: string, dataDirs: string[]): RapidEntry | null {
  for (const dir of dataDirs) {
    const own = readInstalledIndex(dir).find((e) => e.name === name || e.tag === name)
    if (own) return own
    for (const { file, repoUrl } of localVersionFiles(dir)) {
      try {
        const hit = parseVersions(readFileSync(file), repoUrl).find((e) => e.name === name || e.tag === name)
        if (hit) return hit
      } catch {
        // corrupt / partial file: ignore
      }
    }
  }
  return null
}

/** Data dir (from the list) that has this game's .sdp, or null. */
export function findInstalledGame(name: string, dataDirs: string[]): { dataDir: string; entry: RapidEntry } | null {
  const entry = findEntryLocally(name, dataDirs)
  if (!entry) return null
  for (const dir of dataDirs) if (existsSync(join(dir, 'packages', entry.md5 + '.sdp'))) return { dataDir: dir, entry }
  return null
}

/** Refreshes the rapid index (repos.gz + every repo's versions.gz) into ourDataDir; cached for an hour. */
export async function refreshIndex(ourDataDir: string, signal?: AbortSignal): Promise<void> {
  const host = new URL(REPO_MASTER).host
  const marker = join(ourDataDir, 'rapid', host, 'repos.gz')
  if (existsSync(marker) && Date.now() - statSync(marker).mtimeMs < VERSIONS_MAX_AGE_MS) return
  const reposGz = Buffer.from(await (await fetchOk(REPO_MASTER, signal)).arrayBuffer())
  const repos = gunzipSync(reposGz)
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(',')[1])
  for (const repoUrl of repos) {
    const u = new URL(repoUrl)
    const dest = join(ourDataDir, 'rapid', u.host, u.pathname.replace(/^\/+/, ''), 'versions.gz')
    mkdirSync(join(dest, '..'), { recursive: true })
    const buf = Buffer.from(await (await fetchOk(`${repoUrl}/versions.gz`, signal)).arrayBuffer())
    writeFileSync(dest, buf)
  }
  mkdirSync(join(marker, '..'), { recursive: true })
  writeFileSync(marker, reposGz) // written last: its mtime marks a complete refresh
}

export interface GameDownloadStats {
  files: number
  linked: number
  copied: number
  downloaded: number
  downloadedBytes: number
}

/** Places one pool file into ourDataDir: already there / hardlink from a donor pool / download. */
async function placePoolFile(
  f: SdpFile,
  entry: RapidEntry,
  ourDataDir: string,
  donorDirs: string[],
  stats: GameDownloadStats,
  signal?: AbortSignal
): Promise<void> {
  const dest = poolPath(ourDataDir, f.md5)
  if (existsSync(dest)) return
  mkdirSync(join(dest, '..'), { recursive: true })
  for (const donor of donorDirs) {
    const src = poolPath(donor, f.md5)
    if (!existsSync(src)) continue
    try {
      linkSync(src, dest)
      stats.linked++
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return
      copyFileSync(src, dest) // different volume: fall back to a copy
      stats.copied++
    }
    return
  }
  const url = `${entry.repoUrl}/pool/${f.md5.slice(0, 2)}/${f.md5.slice(2)}.gz`
  for (let attempt = 1; ; attempt++) {
    try {
      const buf = Buffer.from(await (await fetchOk(url, signal)).arrayBuffer())
      const actual = createHash('md5').update(gunzipSync(buf)).digest('hex')
      if (actual !== f.md5) throw new Error(`checksum mismatch for ${f.name}`)
      const part = dest + '.part'
      writeFileSync(part, buf)
      renameSync(part, dest)
      stats.downloaded++
      stats.downloadedBytes += buf.length
      return
    } catch (e) {
      if (signal?.aborted || attempt >= 3) throw e
      await new Promise((r) => setTimeout(r, 1000 * attempt))
    }
  }
}

/**
 * Downloads game `name` into ourDataDir (packages/ + pool/). The .sdp is written last, so its presence means the
 * package is complete. donorDirs are other data dirs (BAR's) whose pool files get hardlinked instead of downloaded.
 */
export async function downloadGame(
  name: string,
  ourDataDir: string,
  donorDirs: string[],
  opts: { signal?: AbortSignal; onProgress?(p: Progress & { stage: string }): void; concurrency?: number } = {}
): Promise<GameDownloadStats> {
  let entry = findEntryLocally(name, [ourDataDir, ...donorDirs])
  if (!entry) {
    await refreshIndex(ourDataDir, opts.signal)
    entry = findEntryLocally(name, [ourDataDir])
  }
  if (!entry) throw new Error(`Game version "${name}" is not in the BAR rapid repository (too old or removed).`)

  const sdpUrl = `${entry.repoUrl}/packages/${entry.md5}.sdp`
  let sdpBuf: Buffer
  try {
    sdpBuf = Buffer.from(await (await fetchOk(sdpUrl, opts.signal)).arrayBuffer())
  } catch (e) {
    if ((e as { status?: number }).status === 404)
      throw new Error(`Game version "${name}" is listed but its package is no longer downloadable.`)
    throw e
  }
  const files = parseSdp(sdpBuf)
  const stats: GameDownloadStats = { files: files.length, linked: 0, copied: 0, downloaded: 0, downloadedBytes: 0 }
  let done = 0
  let next = 0
  const report = (): void => opts.onProgress?.({ stage: 'files', bytes: done, totalBytes: files.length })
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const f = files[next++]
      await placePoolFile(f, entry!, ourDataDir, donorDirs, stats, opts.signal)
      done++
      if (done % 200 === 0) report()
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency ?? 16 }, worker))
  report()
  const sdpDest = join(ourDataDir, 'packages', entry.md5 + '.sdp')
  mkdirSync(join(sdpDest, '..'), { recursive: true })
  writeFileSync(sdpDest + '.part', sdpBuf)
  renameSync(sdpDest + '.part', sdpDest)
  recordInstalled(ourDataDir, entry)
  return stats
}
