import { describe, expect, it } from 'vitest'
import type { DecodedChunk, ProjectileSample, Sample } from '@shared/stream/format'
import { headingToRotation, interpolate, projectilesAt, samplePair, type UnitView } from '@shared/stream/interpolate'
import { decodeDxt1 } from '../src/main/maps/minimap'

function sample(frame: number, units: [number, number, number, number][]): Sample {
  // [uid, x, z, heading]
  const n = units.length
  const s: Sample = {
    frame,
    n,
    uid: new Uint32Array(n),
    def: new Uint16Array(n),
    team: new Uint8Array(n),
    x: new Uint16Array(n),
    z: new Uint16Array(n),
    heading: new Uint8Array(n),
    hp: new Uint8Array(n).fill(255),
    build: new Uint8Array(n).fill(100),
    work: new Uint8Array(n),
    wx: new Uint16Array(n),
    wz: new Uint16Array(n)
  }
  units.forEach(([uid, x, z, h], i) => {
    s.uid[i] = uid
    s.x[i] = x
    s.z[i] = z
    s.heading[i] = h
  })
  return s
}

const proj = (frame: number): ProjectileSample => ({
  frame,
  n: 0,
  weapon: new Uint16Array(),
  team: new Uint8Array(),
  x: new Uint16Array(),
  z: new Uint16Array(),
  vx: new Float32Array(),
  vz: new Float32Array()
})

describe('playback interpolation', () => {
  const chunk: DecodedChunk = {
    frameStart: 0,
    frameEnd: 30,
    samples: [sample(0, [[1, 100, 100, 250], [2, 500, 500, 0]]), sample(15, [[1, 200, 100, 4], [3, 900, 900, 0]])],
    projectiles: [proj(0), proj(5), proj(10)]
  }
  const next: DecodedChunk = { frameStart: 30, frameEnd: 60, samples: [sample(30, [[1, 300, 100, 4]])], projectiles: [] }

  it('finds the sample pair around a frame, crossing into the next chunk', () => {
    expect(samplePair(chunk, next, 7.5)).toMatchObject({ s0: { frame: 0 }, s1: { frame: 15 }, alpha: 0.5 })
    expect(samplePair(chunk, next, 20)).toMatchObject({ s0: { frame: 15 }, s1: { frame: 30 } })
    expect(samplePair(chunk, undefined, 20)).toMatchObject({ s0: { frame: 15 }, s1: null, alpha: 0 })
  })

  it('lerps positions, wraps headings the short way, keeps vanishing units in place', () => {
    const out: UnitView[] = []
    const n = interpolate(samplePair(chunk, next, 7.5)!, out)
    expect(n).toBe(2) // unit 3 only appears once frame 15 is reached
    expect(out[0]).toMatchObject({ uid: 1, x: 150, z: 100 })
    // 250 -> 4 is +10 steps through 255/0, so halfway is 255
    expect(out[0].rotation).toBeCloseTo(headingToRotation(255))
    expect(out[1]).toMatchObject({ uid: 2, x: 500, z: 500 })
  })

  it('maps engine headings to icon rotation', () => {
    // engine heading 0 (h8 = 128) faces +z, which is down on screen: an up-pointing icon turns by π
    expect(headingToRotation(128)).toBeCloseTo(Math.PI)
    // h8 = 192 is engine heading +16384 (a quarter turn, facing +x): icon points right
    expect(Math.sin(headingToRotation(192))).toBeCloseTo(1)
  })

  it('picks the latest fresh projectile sample', () => {
    expect(projectilesAt(chunk, undefined, 12, 10)?.frame).toBe(10)
    expect(projectilesAt(chunk, undefined, 25, 10)).toBeNull()
  })
})

describe('DXT1 decoding', () => {
  it('decodes a block with both endpoint colors and interpolated ones', () => {
    // c0 = pure red (0xF800), c1 = pure blue (0x001F); c0 > c1 => 4-color mode
    // indices: pixel 0 -> 0 (red), pixel 1 -> 1 (blue), pixel 2 -> 2 (2/3 red), others 0
    const block = new Uint8Array([0x00, 0xf8, 0x1f, 0x00, 0b100100, 0, 0, 0])
    const rgba = decodeDxt1(block, 4, 4)
    expect([...rgba.subarray(0, 4)]).toEqual([255, 0, 0, 255])
    expect([...rgba.subarray(4, 8)]).toEqual([0, 0, 255, 255])
    expect([...rgba.subarray(8, 12)]).toEqual([170, 0, 85, 255])
  })
})

describe('map marks', () => {
  it('erases nearby points and lines, but not far or later ones', async () => {
    const { buildMarks } = await import('../src/renderer/src/player/marks')
    const marks = buildMarks([
      { frame: 10, playerId: 1, kind: 'point', x: 100, z: 100, label: 'here' },
      { frame: 20, playerId: 1, kind: 'line', x: 0, z: 500, x2: 1000, z2: 500 },
      { frame: 30, playerId: 2, kind: 'point', x: 3000, z: 3000 },
      { frame: 40, playerId: 2, kind: 'erase', x: 150, z: 120 }, // near the point
      { frame: 50, playerId: 1, kind: 'erase', x: 600, z: 560 }, // near the middle of the line
      { frame: 60, playerId: 1, kind: 'point', x: 600, z: 560 } // placed after the erase: stays
    ])
    expect(marks.map((m) => [m.frame, m.erasedAt])).toEqual([
      [10, 40],
      [20, 50],
      [30, Infinity],
      [60, Infinity]
    ])
  })
})
