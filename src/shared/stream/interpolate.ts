// Playback helpers: pick the samples around a frame and interpolate unit state between them.
import type { DecodedChunk, ProjectileSample, Sample } from './format'

export interface UnitView {
  uid: number
  def: number
  team: number
  x: number
  z: number
  /** screen rotation (radians) of an icon pointing up when unrotated */
  rotation: number
  hp: number // 0..1
  build: number // 0..1
}

export interface SamplePair {
  s0: Sample
  s1: Sample | null
  alpha: number
}

/** The sample at or before `frame` and the one after it (possibly the first sample of the next chunk). */
export function samplePair(chunk: DecodedChunk, next: DecodedChunk | undefined, frame: number): SamplePair | null {
  const samples = chunk.samples
  if (samples.length === 0) return null
  let lo = 0
  let hi = samples.length - 1
  if (frame <= samples[0].frame) return { s0: samples[0], s1: null, alpha: 0 }
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (samples[mid].frame <= frame) lo = mid
    else hi = mid - 1
  }
  const s0 = samples[lo]
  const s1 = samples[lo + 1] ?? next?.samples[0] ?? null
  if (!s1 || s1.frame <= s0.frame) return { s0, s1: null, alpha: 0 }
  return { s0, s1, alpha: Math.min(1, Math.max(0, (frame - s0.frame) / (s1.frame - s0.frame))) }
}

/** Engine heading (as 0..255) to the rotation of an up-pointing icon on a map drawn with x right, z down. */
export function headingToRotation(h8: number): number {
  const a = ((h8 * 256 - 32768) / 32768) * Math.PI // engine: 0 faces +z
  return Math.PI - a
}

function view(out: UnitView[], k: number): UnitView {
  let v = out[k]
  if (!v) out[k] = v = { uid: 0, def: 0, team: 0, x: 0, z: 0, rotation: 0, hp: 1, build: 1 }
  return v
}

/**
 * Writes the interpolated units into `out` (objects are reused between frames) and returns the count.
 * Units only in s0 stay put until they vanish; units only in s1 appear when s1 is reached.
 */
export function interpolate(p: SamplePair, out: UnitView[]): number {
  const { s0, s1, alpha } = p
  let j = 0
  for (let i = 0; i < s0.n; i++) {
    const v = view(out, i)
    const uid = s0.uid[i]
    v.uid = uid
    v.def = s0.def[i]
    v.team = s0.team[i]
    let x = s0.x[i]
    let z = s0.z[i]
    let h = s0.heading[i]
    let hp = s0.hp[i]
    let build = s0.build[i]
    if (s1 && alpha > 0) {
      while (j < s1.n && s1.uid[j] < uid) j++
      if (j < s1.n && s1.uid[j] === uid) {
        x += (s1.x[j] - x) * alpha
        z += (s1.z[j] - z) * alpha
        const dh = ((s1.heading[j] - h + 128) & 255) - 128 // shortest way round
        h += dh * alpha
        hp += (s1.hp[j] - hp) * alpha
        build += (s1.build[j] - build) * alpha
      }
    }
    v.x = x
    v.z = z
    v.rotation = headingToRotation(h)
    v.hp = hp / 255
    v.build = build / 100
  }
  return s0.n
}

/** Most recent projectile sample at `frame`, if it's fresh enough to draw (projectiles live a few frames). */
export function projectilesAt(
  chunk: DecodedChunk,
  prev: DecodedChunk | undefined,
  frame: number,
  maxAge: number
): ProjectileSample | null {
  const list = chunk.projectiles
  let best: ProjectileSample | null = null
  let lo = 0
  let hi = list.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (list[mid].frame <= frame) {
      best = list[mid]
      lo = mid + 1
    } else hi = mid - 1
  }
  if (!best && prev && prev.projectiles.length > 0) best = prev.projectiles[prev.projectiles.length - 1]
  return best && frame - best.frame < maxAge ? best : null
}
