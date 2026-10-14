import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ByteReader, ByteWriter } from '@shared/stream/bytes'
import { decodeChunk, encodeChunk, EVENT_DEATH, type EncodedSample, type Sample, type UnitState } from '@shared/stream/format'
import { convertRaw } from '../src/main/stream/convert'
import { openStream } from '../src/main/stream/reader'

const tmp = mkdtempSync(join(tmpdir(), 'brv-stream-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function unitAt(s: Sample, uid: number): UnitState | undefined {
  for (let i = 0; i < s.n; i++)
    if (s.uid[i] === uid)
      return { uid, def: s.def[i], team: s.team[i], x: s.x[i], z: s.z[i], heading: s.heading[i], hp: s.hp[i], build: s.build[i] }
  return undefined
}

describe('bytes', () => {
  it('round-trips varints, zigzag and fixed ints', () => {
    const w = new ByteWriter()
    const vals = [0, 1, 127, 128, 300, 65535, 2 ** 31, 2 ** 40]
    for (const v of vals) w.varint(v)
    for (const v of [-1, 0, 1, -64, 64, -100000]) w.svarint(v)
    w.u16(51234)
    w.i8(-5)
    const r = new ByteReader(w.finish())
    expect(vals.map(() => r.varint())).toEqual(vals)
    expect([1, 2, 3, 4, 5, 6].map(() => r.svarint())).toEqual([-1, 0, 1, -64, 64, -100000])
    expect(r.u16()).toBe(51234)
    expect(r.i8()).toBe(-5)
    expect(r.done).toBe(true)
  })
})

describe('chunk encoding', () => {
  it('round-trips keyframe + deltas with adds, removals and changes', () => {
    const u = (uid: number, x: number, extra: Partial<UnitState> = {}): UnitState => ({
      uid, def: 10 + uid, team: uid % 3, x, z: 1000 + uid, heading: 7, hp: 255, build: 100, ...extra
    })
    const samples: EncodedSample[] = [
      { frame: 600, units: [u(1, 100), u(2, 200), u(5, 500)] },
      { frame: 615, units: [u(1, 110), u(2, 200), u(5, 500, { hp: 30 })] }, // move + hp change
      { frame: 630, units: [u(2, 200, { team: 1 }), u(5, 499), u(7, 700, { build: 10 })] }, // 1 removed, 7 added
      { frame: 645, units: [u(2, 200, { team: 1 }), u(5, 499), u(7, 700, { build: 55, heading: 200 })] }
    ]
    const projectiles = [{ frame: 605, list: [{ weapon: 3, team: 1, x: 10, z: 20, vx: -4, vz: 12 }] }]
    const c = decodeChunk(encodeChunk(600, 1200, samples, projectiles))
    expect([c.frameStart, c.frameEnd]).toEqual([600, 1200])
    expect(c.samples.map((s) => s.frame)).toEqual([600, 615, 630, 645])
    samples.forEach((s, i) => {
      expect(c.samples[i].n).toBe(s.units.length)
      for (const unit of s.units) expect(unitAt(c.samples[i], unit.uid)).toEqual(unit)
    })
    expect(c.projectiles[0]).toMatchObject({ frame: 605, n: 1 })
    expect([c.projectiles[0].weapon[0], c.projectiles[0].vx[0], c.projectiles[0].vz[0]]).toEqual([3, -4, 12])
  })
})

const RAW = `BRVRAW 1
H interval=15 projInterval=5 mapX=4096 mapZ=4096 gaia=2 engine=2025.04.08 game=Beyond_All_Reason_test-1 map=Test_Map_v1
T 0 0 255 0 0 0 armada Alice
T 1 1 0 0 255 1 cortex Bob AI
T 2 2 76 76 76 0 - Gaia
E 0 C 100 5 0 -1
E 0 C 101 6 1 -1
F 0 2
100 5 0 1000 1000 50 0 3000 3000 100
101 6 1 3000 3000 50 -32768 3000 3000 100
E 10 C 200 7 0 100
F 15 3
100 5 0 1010 1000 50 0 3000 3000 100
101 6 1 3000 3000 50 -32768 1500 3000 100
200 7 0 1100 1100 50 16384 10 400 3
P 15 1
9 4 0 1050 1000 60 5.5 -2.0
E 20 D 101 6 1 100 5 0 3000 3000
F 30 3
100 5 0 1020 1000 50 0 3000 3000 100
101 6 1 3000 3000 50 -32768 0 3000 100
200 7 0 1100 1100 50 16384 200 400 50
E 31 C 101 8 1 -1
F 45 3
100 5 0 1030 1000 50 0 3000 3000 100
101 8 1 2000 2000 50 0 100 100 100
200 7 0 1100 1100 50 16384 400 400 100
E 45 O 0
DONE gameover 45
`

describe('convertRaw', () => {
  it('converts a synthetic recording, keeping unit identity across id reuse', async () => {
    const raw = join(tmp, 'raw.txt')
    const defs = join(tmp, 'defs.txt')
    writeFileSync(raw, RAW)
    writeFileSync(
      defs,
      'BRVDEFS 1\nU 5 armcom 6 6 0 0 0 1 2700 26000 3700 37.5 armcom Armada Commander\nU 6 corak 4 4 0 0 0 0 50 900 300 90 corak A.K.\nU 7 armsolar 10 10 1 0 0 0 155 0 340 0 armsolar Solar Collector\nU 8 corak2 4 4 0 0 0 0 60 900 300 90 corak2 Another\nW 4 armcom_laser LaserCannon 300 Laser\n'
    )
    const out = join(tmp, 'game.brvs')
    const res = await convertRaw({ rawPath: raw, unitDefsPath: defs, outPath: out, gameId: 'abc', chat: [], keyframeInterval: 30 })
    expect(res).toMatchObject({ chunks: 2, samples: 4, lastFrame: 45 })

    const s = openStream(out)
    expect(s.header).toMatchObject({ gameId: 'abc', mapName: 'Test Map v1', mapSizeX: 4096, endReason: 'gameover', keyframeInterval: 30 })
    expect(s.header.chunks.map((c) => c.frameStart)).toEqual([0, 30])
    expect(s.meta.winners).toEqual([0])
    expect(s.meta.teams.map((t) => [t.name, t.color, t.isGaia])).toEqual([
      ['Alice', '#ff0000', false],
      ['Bob AI', '#0000ff', false],
      ['Gaia', '#4c4c4c', true]
    ])
    expect(s.meta.unitDefs[5].kind).toBe('commander')
    expect(s.meta.unitDefs[7].kind).toBe('building')
    expect(s.meta.weaponDefs[4].type).toBe('LaserCannon')

    const c0 = s.chunk(0)
    const c1 = s.chunk(1)
    // corak (raw 101) died at frame 20 but is still listed while dying at frame 30; raw id 101 is then reused
    const corakUid = c0.samples[0].uid[1]
    expect(unitAt(c0.samples[1], corakUid)?.hp).toBe(128) // 1500/3000
    expect(unitAt(c1.samples[0], corakUid)?.def).toBe(6) // dying, same identity
    const reused = c1.samples[1]
    expect(unitAt(reused, corakUid)).toBeUndefined()
    const newUnit = [...reused.uid].find((uid) => reused.def[[...reused.uid].indexOf(uid)] === 8)!
    expect(newUnit).not.toBe(corakUid)
    // death event with attacker identity and position
    const death = s.meta.events.find((e) => e[1] === EVENT_DEATH)!
    expect(death).toEqual([20, EVENT_DEATH, corakUid, 6, 1, c0.samples[0].uid[0], 3000, 3000])
    expect(c0.projectiles[0]).toMatchObject({ frame: 15, n: 1 })
    expect(c0.projectiles[0].vx[0]).toBe(6) // 5.5 rounded
    // stats at frames 0 and 30: army counts finished mobile units only (solar is a building)
    expect(s.meta.stats.teams[0].army).toEqual([2700, 2700])
    expect(s.meta.stats.teams[0].units).toEqual([1, 2])
  })
})

// Real raw recordings, when present (they're deleted after conversion unless the app runs with BRV_KEEP_RAW=1)
const REC = 'D:/Dmitrii/bar-replay-viewer/recordings/'
const UNITDEFS = 'D:/Dmitrii/bar-replay-viewer/cache/unitdefs/'
describe.skipIf(!existsSync(REC + 'replay-1/raw.txt'))('real recordings', () => {
  it.each([
    ['replay-1', 'Beyond_All_Reason_test-28768-e91bda2.txt'],
    ['replay-4', 'Beyond_All_Reason_test-29243-424ae0a.txt']
  ])('converts %s to a small stream that decodes to the raw data', { timeout: 300_000 }, async (dir, defsFile) => {
    const raw = REC + dir + '/raw.txt'
    if (!existsSync(raw)) return
    const out = join(tmp, dir + '.brvs')
    const res = await convertRaw({ rawPath: raw, unitDefsPath: UNITDEFS + defsFile, outPath: out, gameId: dir, chat: [] })
    const mb = (n: number): string => (n / 1024 / 1024).toFixed(1) + ' MB'
    console.log(dir, `raw ${mb(statSync(raw).size)} -> ${mb(res.bytes)}`, res)
    expect(res.bytes).toBeLessThan(10 * 1024 * 1024)

    // every chunk decodes; sample frames are continuous and every unit count is plausible
    const s = openStream(out)
    let prevFrame = -1
    let maxUnits = 0
    let problems = 0
    for (let i = 0; i < s.header.chunks.length; i++) {
      const c = s.chunk(i)
      for (const sm of c.samples) {
        if (sm.frame <= prevFrame) problems++
        prevFrame = sm.frame
        maxUnits = Math.max(maxUnits, sm.n)
        for (let k = 1; k < sm.n; k++) if (sm.uid[k] <= sm.uid[k - 1]) problems++
      }
    }
    expect(problems).toBe(0)
    expect(prevFrame).toBeGreaterThan(s.header.lastFrame - 30)
    expect(maxUnits).toBeGreaterThan(100)
  })
})

describe.skipIf(!existsSync(REC + 'replay-1/game.brvs'))('stream files produced by the app', () => {
  it('fully decodes the 8v8 stream with chat, events and stats', () => {
    const s = openStream(REC + 'replay-1/game.brvs')
    expect(s.header).toMatchObject({ mapName: 'Project SD-129 v1.0', endReason: 'gameover', lastFrame: 30455 })
    expect(s.meta.winners).toEqual([0])
    expect(s.meta.chat.length).toBe(75)
    expect(s.meta.events.filter((e) => e[1] === EVENT_DEATH).length).toBe(2234)
    let problems = 0
    let samples = 0
    let prev = -1
    for (let i = 0; i < s.header.chunks.length; i++) {
      for (const sm of s.chunk(i).samples) {
        samples++
        if (sm.frame <= prev) problems++
        prev = sm.frame
        for (let k = 1; k < sm.n; k++) if (sm.uid[k] <= sm.uid[k - 1]) problems++
      }
    }
    expect(problems).toBe(0)
    expect(samples).toBe(2031)
  })
})
