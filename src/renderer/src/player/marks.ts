// Map marks from the demo's map-draw packets: which points/lines exist at which frame (erases remove them).
import type { MapMarker } from '@shared/types'

/** an erase removes map marks within this distance (elmos) */
export const ERASE_RADIUS = 100

/** A map mark with its lifetime: visible from `frame` until `erasedAt` (exclusive). */
export interface Mark extends MapMarker {
  id: number
  erasedAt: number
}

function segmentDistance(px: number, pz: number, x1: number, z1: number, x2: number, z2: number): number {
  const dx = x2 - x1
  const dz = z2 - z1
  const l2 = dx * dx + dz * dz
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - x1) * dx + (pz - z1) * dz) / l2)) : 0
  return Math.hypot(px - (x1 + dx * t), pz - (z1 + dz * t))
}

/** Points and lines with the frame an erase removed them (Infinity if never). */
export function buildMarks(markers: MapMarker[]): Mark[] {
  const marks: Mark[] = []
  markers.forEach((m, id) => {
    if (m.kind === 'erase') {
      for (const k of marks) {
        // like in game, an erase removes any nearby mark, not only the eraser's own
        if (k.erasedAt !== Infinity || k.frame > m.frame) continue
        const d = k.kind === 'line' ? segmentDistance(m.x, m.z, k.x, k.z, k.x2 ?? k.x, k.z2 ?? k.z) : Math.hypot(k.x - m.x, k.z - m.z)
        if (d <= ERASE_RADIUS) k.erasedAt = m.frame
      }
    } else marks.push({ ...m, id, erasedAt: Infinity })
  })
  return marks
}

