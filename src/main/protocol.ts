// brv:// protocol: serves recordings and minimaps to the renderer (and its Web Worker) without exposing file paths.
//   brv://stream/<replayId>   the replay's state stream (.brvs)
//   brv://minimap/<replayId>[?thumb=1]     the map's minimap PNG (extracted and cached on first request)
//   brv://overlay/<replayId>/height|metal  shaded height map / metal map PNGs
//   brv://game/<replayId>/<path>           in-game artwork of the replay's game version (icons, ranks, icontypes.json)
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { nativeImage, protocol } from 'electron'
import { findLocalMap } from './deps/maps'
import { ourDataDir } from './deps/resolver'
import { ensureGameAssets } from './game-assets'
import { join, normalize } from 'node:path'
import { ensureMapImages, type MapImage, mapImagePath } from './maps/minimap'
import type { Library } from './library'
import type { SimQueue } from './sim/queue'
import type { Settings } from '@shared/types'

export const SCHEME = 'brv'

/** Must run before app 'ready'. */
export function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
  ])
}

function rgbaToPng(rgba: Uint8Array, width: number, height: number): Buffer {
  const bgra = Buffer.alloc(rgba.length)
  for (let i = 0; i < rgba.length; i += 4) {
    bgra[i] = rgba[i + 2]
    bgra[i + 1] = rgba[i + 1]
    bgra[i + 2] = rgba[i]
    bgra[i + 3] = rgba[i + 3]
  }
  return nativeImage.createFromBitmap(bgra, { width, height }).toPNG()
}

const CORS = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' }
const IMAGE = { 'access-control-allow-origin': '*', 'cache-control': 'max-age=3600', 'content-type': 'image/png' }
const THUMB_WIDTH = 128

function notFound(msg: string): Response {
  return new Response(msg, { status: 404, headers: { ...CORS, 'content-type': 'text/plain' } })
}

export function handleProtocol(deps: {
  library: () => Library | null
  queue: () => SimQueue | null
  settings: () => Settings
}): void {
  const imageJobs = new Map<string, Promise<void>>()

  /** Path of a map image for a replay, extracting the map's images on first use. */
  const mapImage = async (library: Library, replayId: number, kind: MapImage): Promise<string | null> => {
    const replay = library.get(replayId)
    if (!replay) return null
    const s = deps.settings()
    const mapFile = findLocalMap(replay.mapName, s.mapDirs)
    if (!mapFile) return null
    const png = mapImagePath(s.workDir, mapFile, kind)
    if (!existsSync(png)) {
      let job = imageJobs.get(mapFile)
      if (!job) {
        job = ensureMapImages(mapFile, s.workDir, rgbaToPng).finally(() => imageJobs.delete(mapFile))
        imageJobs.set(mapFile, job)
      }
      await job
    }
    return png
  }

  protocol.handle(SCHEME, async (req) => {
    const url = new URL(req.url)
    const [idPart, sub] = url.pathname.replace(/^\/+/, '').split('/')
    const id = Number(idPart)
    const library = deps.library()
    const queue = deps.queue()
    if (!library || !queue || !Number.isInteger(id)) return notFound('bad request')
    try {
      if (url.hostname === 'stream') {
        const job = queue.latestJob(id)
        if (!job?.streamPath || job.status !== 'done' || !existsSync(job.streamPath)) return notFound('not simulated')
        return new Response(await readFile(job.streamPath), {
          headers: { ...CORS, 'content-type': 'application/octet-stream' }
        })
      }
      if (url.hostname === 'minimap') {
        const png = await mapImage(library, id, 'minimap')
        if (!png) return notFound('map not installed')
        if (url.searchParams.has('thumb')) {
          const thumb = png.replace(/\.png$/, '.thumb.png')
          if (!existsSync(thumb))
            await writeFile(thumb, nativeImage.createFromPath(png).resize({ width: THUMB_WIDTH, quality: 'good' }).toPNG())
          return new Response(await readFile(thumb), { headers: IMAGE })
        }
        return new Response(await readFile(png), { headers: IMAGE })
      }
      if (url.hostname === 'overlay' && (sub === 'height' || sub === 'metal')) {
        const png = await mapImage(library, id, sub)
        if (!png) return notFound('map not installed')
        return new Response(await readFile(png), { headers: IMAGE })
      }
      if (url.hostname === 'game') {
        const replay = library.get(id)
        if (!replay) return notFound('unknown replay')
        const rel = normalize(decodeURIComponent(url.pathname.replace(/^\/+\d+\//, ''))).toLowerCase()
        if (rel.startsWith('..')) return notFound('bad path')
        const s = deps.settings()
        const dir = ensureGameAssets(replay.gameVersion, [ourDataDir(s), s.barDataDir], join(s.workDir, 'cache', 'game'))
        const file = join(dir, rel)
        if (!existsSync(file)) return notFound('no such asset')
        const type = rel.endsWith('.json') ? 'application/json' : 'image/png'
        return new Response(await readFile(file), { headers: { ...IMAGE, 'content-type': type } })
      }
      return notFound('unknown resource')
    } catch (e) {
      return new Response(e instanceof Error ? e.message : String(e), { status: 500, headers: CORS })
    }
  })
}
