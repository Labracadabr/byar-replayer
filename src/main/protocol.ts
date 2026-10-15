// brv:// protocol: serves recordings and minimaps to the renderer (and its Web Worker) without exposing file paths.
//   brv://stream/<replayId>   the replay's state stream (.brvs)
//   brv://minimap/<replayId>  the map's minimap PNG (extracted and cached on first request)
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { nativeImage, protocol } from 'electron'
import { findLocalMap } from './deps/maps'
import { ensureMinimap, minimapCachePath } from './maps/minimap'
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

function notFound(msg: string): Response {
  return new Response(msg, { status: 404, headers: { ...CORS, 'content-type': 'text/plain' } })
}

export function handleProtocol(deps: {
  library: () => Library | null
  queue: () => SimQueue | null
  settings: () => Settings
}): void {
  const minimapJobs = new Map<string, Promise<void>>()

  protocol.handle(SCHEME, async (req) => {
    const url = new URL(req.url)
    const id = Number(url.pathname.replace(/^\/+/, ''))
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
        const replay = library.get(id)
        if (!replay) return notFound('unknown replay')
        const s = deps.settings()
        const mapFile = findLocalMap(replay.mapName, s.mapDirs)
        if (!mapFile) return notFound('map not installed')
        const png = minimapCachePath(s.workDir, mapFile)
        if (!existsSync(png)) {
          let job = minimapJobs.get(png)
          if (!job) {
            job = ensureMinimap(mapFile, png, rgbaToPng).finally(() => minimapJobs.delete(png))
            minimapJobs.set(png, job)
          }
          await job
        }
        return new Response(await readFile(png), { headers: { ...CORS, 'content-type': 'image/png' } })
      }
      return notFound('unknown resource')
    } catch (e) {
      return new Response(e instanceof Error ? e.message : String(e), { status: 500, headers: CORS })
    }
  })
}
