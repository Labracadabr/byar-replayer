// Minimap extraction: map archive (.sd7 = 7z, .sdz = zip) -> maps/*.smf -> DXT1 1024x1024 minimap -> PNG (cached).
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { path7za as packed7za } from '7zip-bin'
import { unpacked } from '../unpacked'

const path7za = unpacked(packed7za) // the real exe is outside app.asar when packaged

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

export type MapImage = 'minimap' | 'height' | 'metal'

/** Hill-shaded, elevation-tinted height map ((mapx+1) x (mapy+1) pixels). Below 0 (water) is tinted blue. */
export function renderHeight(smf: Buffer, h: SmfHeader): { rgba: Uint8Array; width: number; height: number } {
  const w = h.mapx + 1
  const ht = h.mapy + 1
  const raw = new Uint16Array(w * ht)
  for (let i = 0; i < raw.length; i++) raw[i] = smf.readUInt16LE(h.heightmapPtr + i * 2)
  const scale = (h.maxHeight - h.minHeight) / 65535
  const height = (x: number, y: number): number =>
    h.minHeight + raw[Math.min(ht - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))] * scale
  const range = Math.max(1, h.maxHeight - Math.max(0, h.minHeight))
  // light from the north-west, a bit above the horizon
  const L = [-0.5, -0.5, 0.7]
  const ll = Math.hypot(L[0], L[1], L[2])
  const rgba = new Uint8Array(w * ht * 4)
  for (let y = 0; y < ht; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (height(x + 1, y) - height(x - 1, y)) / 16
      const dy = (height(x, y + 1) - height(x, y - 1)) / 16
      const nl = Math.hypot(dx, dy, 1)
      const shade = Math.max(0, (-dx * L[0] - dy * L[1] + L[2]) / (nl * ll))
      const e = height(x, y)
      const o = (y * w + x) * 4
      if (e < 0) {
        const d = Math.min(1, -e / 150)
        rgba[o] = (40 - 25 * d) * (0.6 + 0.4 * shade)
        rgba[o + 1] = (90 - 40 * d) * (0.6 + 0.4 * shade)
        rgba[o + 2] = (150 - 30 * d) * (0.6 + 0.4 * shade)
      } else {
        const t = Math.min(1, e / range)
        // low = olive green, high = light sand
        const r = 70 + 150 * t
        const g = 95 + 115 * t
        const b = 60 + 120 * t
        rgba[o] = r * shade
        rgba[o + 1] = g * shade
        rgba[o + 2] = b * shade
      }
      rgba[o + 3] = 255
    }
  }
  return { rgba, width: w, height: ht }
}

/** Metal spots as translucent cyan over a transparent image ((mapx/2) x (mapy/2) pixels). */
export function renderMetal(smf: Buffer, h: SmfHeader): { rgba: Uint8Array; width: number; height: number } {
  const w = h.mapx / 2
  const ht = h.mapy / 2
  const rgba = new Uint8Array(w * ht * 4)
  for (let i = 0; i < w * ht; i++) {
    const v = smf[h.metalmapPtr + i]
    if (v === 0) continue
    rgba[i * 4] = 80
    rgba[i * 4 + 1] = 230
    rgba[i * 4 + 2] = 255
    rgba[i * 4 + 3] = Math.min(255, 90 + v)
  }
  return { rgba, width: w, height: ht }
}

export function mapImagePath(workDir: string, mapArchive: string, kind: MapImage): string {
  const stem = basename(mapArchive).replace(/\.(sd7|sdz)$/i, '')
  return join(workDir, 'cache', 'minimaps', kind === 'minimap' ? `${stem}.png` : `${stem}.${kind}.png`)
}

/** Writes the minimap, height and metal PNGs for a map archive (one .smf read); skips files that exist. */
export async function ensureMapImages(mapArchive: string, workDir: string, encodePng: PngEncoder): Promise<void> {
  const kinds: MapImage[] = ['minimap', 'height', 'metal']
  if (kinds.every((k) => existsSync(mapImagePath(workDir, mapArchive, k)))) return
  const smf = await readSmf(mapArchive)
  const h = parseSmfHeader(smf)
  const write = (kind: MapImage, img: { rgba: Uint8Array; width: number; height: number }): void => {
    const out = mapImagePath(workDir, mapArchive, kind)
    if (existsSync(out)) return
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out + '.tmp', encodePng(img.rgba, img.width, img.height))
    renameSync(out + '.tmp', out)
  }
  const dxtSize = (MINIMAP_SIZE * MINIMAP_SIZE) / 2
  if (h.minimapPtr <= 0 || h.minimapPtr + dxtSize > smf.length) throw new Error('SMF minimap pointer out of range')
  write('minimap', {
    rgba: decodeDxt1(smf.subarray(h.minimapPtr, h.minimapPtr + dxtSize), MINIMAP_SIZE, MINIMAP_SIZE),
    width: MINIMAP_SIZE,
    height: MINIMAP_SIZE
  })
  write('height', renderHeight(smf, h))
  write('metal', renderMetal(smf, h))
}
