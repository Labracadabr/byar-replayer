// Minimap extraction: map archive (.sd7 = 7z, .sdz = zip) -> maps/*.smf -> DXT1 1024x1024 minimap -> PNG (cached).
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { path7za } from '7zip-bin'

export const MINIMAP_SIZE = 1024

export interface SmfHeader {
  mapx: number // in 8-elmo squares
  mapy: number
  minHeight: number
  maxHeight: number
  heightmapPtr: number
  typeMapPtr: number
  tilesPtr: number
  minimapPtr: number
  metalmapPtr: number
}

export function parseSmfHeader(buf: Buffer): SmfHeader {
  if (buf.subarray(0, 15).toString('latin1') !== 'spring map file') throw new Error('Not an SMF map file')
  return {
    mapx: buf.readInt32LE(24),
    mapy: buf.readInt32LE(28),
    minHeight: buf.readFloatLE(44),
    maxHeight: buf.readFloatLE(48),
    heightmapPtr: buf.readInt32LE(52),
    typeMapPtr: buf.readInt32LE(56),
    tilesPtr: buf.readInt32LE(60),
    minimapPtr: buf.readInt32LE(64),
    metalmapPtr: buf.readInt32LE(68)
  }
}

/** Decodes DXT1 (BC1) blocks to RGBA. */
export function decodeDxt1(src: Buffer | Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4)
  const c = new Uint8Array(16) // 4 colors x RGBA
  let p = 0
  for (let by = 0; by < height; by += 4) {
    for (let bx = 0; bx < width; bx += 4) {
      const c0 = src[p] | (src[p + 1] << 8)
      const c1 = src[p + 2] | (src[p + 3] << 8)
      const bits = (src[p + 4] | (src[p + 5] << 8) | (src[p + 6] << 16) | (src[p + 7] << 24)) >>> 0
      p += 8
      const r0 = ((c0 >> 11) & 31) * 255 / 31, g0 = ((c0 >> 5) & 63) * 255 / 63, b0 = (c0 & 31) * 255 / 31
      const r1 = ((c1 >> 11) & 31) * 255 / 31, g1 = ((c1 >> 5) & 63) * 255 / 63, b1 = (c1 & 31) * 255 / 31
      c.set([r0, g0, b0, 255, r1, g1, b1, 255], 0)
      if (c0 > c1) {
        c.set([(2 * r0 + r1) / 3, (2 * g0 + g1) / 3, (2 * b0 + b1) / 3, 255, (r0 + 2 * r1) / 3, (g0 + 2 * g1) / 3, (b0 + 2 * b1) / 3, 255], 8)
      } else {
        c.set([(r0 + r1) / 2, (g0 + g1) / 2, (b0 + b1) / 2, 255, 0, 0, 0, 0], 8)
      }
      for (let i = 0; i < 16; i++) {
        const idx = (bits >>> (2 * i)) & 3
        const x = bx + (i & 3)
        const y = by + (i >> 2)
        const o = (y * width + x) * 4
        out[o] = c[idx * 4]
        out[o + 1] = c[idx * 4 + 1]
        out[o + 2] = c[idx * 4 + 2]
        out[o + 3] = c[idx * 4 + 3]
      }
    }
  }
  return out
}

function run7za(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(path7za, args, { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`7za failed: ${stderr.toString().trim() || err.message}`))
      else resolve(stdout)
    })
  })
}

/** Reads the .smf out of a map archive. */
export async function readSmf(mapArchive: string): Promise<Buffer> {
  const listing = (await run7za(['l', '-slt', '-ba', mapArchive])).toString('utf8')
  const smf = [...listing.matchAll(/^Path = (.+\.smf)\r?$/gim)].map((m) => m[1].trim())
  if (smf.length === 0) throw new Error(`No .smf inside ${basename(mapArchive)}`)
  const buf = await run7za(['e', '-so', mapArchive, smf[0]])
  if (buf.length < 80) throw new Error(`Could not extract ${smf[0]} from ${basename(mapArchive)}`)
  return buf
}

export type PngEncoder = (rgba: Uint8Array, width: number, height: number) => Buffer

/** Extracts the minimap PNG for a map archive into outPng (no-op if it exists). */
export async function ensureMinimap(mapArchive: string, outPng: string, encodePng: PngEncoder): Promise<void> {
  if (existsSync(outPng)) return
  const smf = await readSmf(mapArchive)
  const h = parseSmfHeader(smf)
  const dxtSize = (MINIMAP_SIZE * MINIMAP_SIZE) / 2
  if (h.minimapPtr <= 0 || h.minimapPtr + dxtSize > smf.length) throw new Error('SMF minimap pointer out of range')
  const rgba = decodeDxt1(smf.subarray(h.minimapPtr, h.minimapPtr + dxtSize), MINIMAP_SIZE, MINIMAP_SIZE)
  mkdirSync(dirname(outPng), { recursive: true })
  const tmp = outPng + '.tmp'
  writeFileSync(tmp, encodePng(rgba, MINIMAP_SIZE, MINIMAP_SIZE))
  renameSync(tmp, outPng)
}

export function minimapCachePath(workDir: string, mapArchive: string): string {
  return join(workDir, 'cache', 'minimaps', basename(mapArchive).replace(/\.(sd7|sdz)$/i, '') + '.png')
}
