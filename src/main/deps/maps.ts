// Map resolution: configured map folders -> BAR's file search API -> BAR's public Google Drive maps folder.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { downloadFile, fetchOk, type Progress } from './download'

export const MAP_SEARCH_URL = 'https://files-cdn.beyondallreason.dev/find'
export const DRIVE_MAPS_FOLDER = '16eBcMpkgMTV9mlKxYmNda64X_dmCFdkk'
const MAP_EXTS = ['.sd7', '.sdz']

export interface RemoteMap {
  fileName: string
  md5?: string
  size?: number
  urls: string[]
  source: 'bar-cdn' | 'google-drive'
}

/** "Death Valley v1.0.1" -> "death_valley_v1.0.1" (BAR's archive naming convention) */
export function mapFileStem(mapName: string): string {
  return mapName.trim().toLowerCase().replace(/\s+/g, '_')
}

/** Finds a map archive in the folders, by exact file name (if known) or by the naming convention. */
export function findLocalMap(mapName: string, mapDirs: string[], knownFileName?: string): string | null {
  const wanted = new Set<string>()
  if (knownFileName) wanted.add(knownFileName.toLowerCase())
  const stem = mapFileStem(mapName)
  for (const ext of MAP_EXTS) wanted.add(stem + ext)
  for (const dir of mapDirs) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    const hit = names.find((n) => wanted.has(n.toLowerCase()))
    if (hit) return join(dir, hit)
  }
  return null
}

export async function lookupMapBarCdn(mapName: string, signal?: AbortSignal): Promise<RemoteMap | null> {
  const url = `${MAP_SEARCH_URL}?category=map&springname=${encodeURIComponent(mapName)}`
  let res: Response
  try {
    res = await fetchOk(url, signal)
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null
    throw e
  }
  const hits = (await res.json()) as { filename: string; springname: string; md5: string; size: number; mirrors: string[] }[]
  const hit = hits.find((h) => h.springname === mapName) ?? hits[0]
  if (!hit || !hit.mirrors?.length) return null
  return { fileName: hit.filename, md5: hit.md5, size: hit.size, urls: hit.mirrors, source: 'bar-cdn' }
}

/** Google Drive API v3: look for the archive by file name in BAR's public maps folder (needs an API key). */
export async function lookupMapDrive(mapName: string, apiKey: string, signal?: AbortSignal): Promise<RemoteMap | null> {
  if (!apiKey) return null
  const stem = mapFileStem(mapName)
  for (const ext of MAP_EXTS) {
    const q = `'${DRIVE_MAPS_FOLDER}' in parents and name = '${(stem + ext).replace(/'/g, "\\'")}' and trashed = false`
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,size,md5Checksum)&pageSize=10&key=${encodeURIComponent(apiKey)}`
    const res = (await (await fetchOk(url, signal)).json()) as {
      files: { id: string; name: string; size?: string; md5Checksum?: string }[]
    }
    const f = res.files?.[0]
    if (f)
      return {
        fileName: f.name,
        md5: f.md5Checksum,
        size: f.size ? Number(f.size) : undefined,
        urls: [`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media&key=${encodeURIComponent(apiKey)}`],
        source: 'google-drive'
      }
  }
  return null
}

/** Downloads a map into destDir, trying each mirror; returns the final path. */
export async function downloadMap(
  remote: RemoteMap,
  destDir: string,
  opts: { signal?: AbortSignal; onProgress?(p: Progress): void } = {}
): Promise<string> {
  const dest = join(destDir, remote.fileName)
  if (existsSync(dest)) return dest
  let lastErr: unknown
  for (const url of remote.urls) {
    try {
      await downloadFile(url, dest, { ...opts, md5: remote.md5 })
      return dest
    } catch (e) {
      if (opts.signal?.aborted) throw e
      lastErr = e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Could not download ${remote.fileName}`)
}
