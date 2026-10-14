// BRVS state stream format (docs/format.md): encoder and decoder for one game's recorded state.
// Pure TS with no Node APIs, so the decoder can run in a renderer Web Worker. Compression is injected (zstd).
import { ByteReader, ByteWriter } from './bytes'

export const MAGIC = 'BRVS'
export const FORMAT_VERSION = 1

export type Decompress = (data: Uint8Array) => Uint8Array

export interface BlobRef {
  /** relative to the end of the header */
  offset: number
  length: number
}

export interface ChunkRef extends BlobRef {
  frameStart: number
  /** exclusive */
  frameEnd: number
}

export interface StreamHeader {
  formatVersion: number
  gameId: string
  mapName: string
  /** map size in elmos (map units × 512) */
  mapSizeX: number
  mapSizeZ: number
  sampleInterval: number
  projectileInterval: number
  keyframeInterval: number
  firstFrame: number
  lastFrame: number
  endReason: string
  engine: string
  game: string
  createdAt: number
  meta: BlobRef
  chunks: ChunkRef[]
}

export type UnitKind = 'building' | 'ground' | 'air' | 'ship' | 'commander'

export interface UnitDefInfo {
  name: string
  humanName: string
  /** footprint in 8-elmo squares */
  xsize: number
  zsize: number
  kind: UnitKind
  metal: number
  energy: number
  health: number
  iconType: string
}

export interface TeamInfo {
  teamId: number
  allyTeam: number
  name: string
  color: string // #rrggbb
  isAI: boolean
  isGaia: boolean
  side: string
}

export const EVENT_CREATE = 1
export const EVENT_FINISH = 2
export const EVENT_DEATH = 3
export const EVENT_GIVE = 4
export const EVENT_GAMEOVER = 5

/**
 * [frame, type, uid, def, team, other, x, z]
 * other: builder uid (create), attacker uid or -1 (death), previous team (give)
 * x/z: death position (death) else -1
 */
export type StreamEvent = [number, number, number, number, number, number, number, number]

export interface ChatLine {
  frame: number
  playerId: number
  name: string
  type: 'ally' | 'spec' | 'global' | 'self'
  message: string
}

export interface TeamStats {
  /** units alive (finished or under construction) */
  units: number[]
  /** metal cost of finished mobile units */
  army: number[]
}

export interface StreamMeta {
  teams: TeamInfo[]
  winners: number[]
  unitDefs: Record<number, UnitDefInfo>
  weaponDefs: Record<number, { name: string; type: string }>
  events: StreamEvent[]
  chat: ChatLine[]
  /** sampled every `interval` frames starting at frame 0 */
  stats: { interval: number; teams: Record<number, TeamStats> }
}

/** One unit at one sample. heading/hp are 0..255, build is 0..100. */
export interface UnitState {
  uid: number
  def: number
  team: number
  x: number
  z: number
  heading: number
  hp: number
  build: number
}

export interface ProjectileState {
  weapon: number
  team: number
  x: number
  z: number
  /** elmos per frame, for extrapolating between samples */
  vx: number
  vz: number
}

export interface EncodedSample {
  frame: number
  units: UnitState[] // sorted by uid
}

export interface EncodedProjectiles {
  frame: number
  list: ProjectileState[]
}

/** Decoded sample: struct-of-arrays sorted by uid, cheap to interpolate. */
export interface Sample {
  frame: number
  n: number
  uid: Uint32Array
  def: Uint16Array
  team: Uint8Array
  x: Uint16Array
  z: Uint16Array
  heading: Uint8Array
  hp: Uint8Array
  build: Uint8Array
}

export interface ProjectileSample {
  frame: number
  n: number
  weapon: Uint16Array
  team: Uint8Array
  x: Uint16Array
  z: Uint16Array
  vx: Int8Array
  vz: Int8Array
}

export interface DecodedChunk {
  frameStart: number
  frameEnd: number
  samples: Sample[]
  projectiles: ProjectileSample[]
}

const M_POS = 1
const M_HEADING = 2
const M_HP = 4
const M_BUILD = 8
const M_TEAM = 16
const M_DEF = 32

function writeUnit(w: ByteWriter, u: UnitState): void {
  w.varint(u.def)
  w.varint(u.team)
  w.u16(u.x)
  w.u16(u.z)
  w.u8(u.heading)
  w.u8(u.hp)
  w.u8(u.build)
}

/** Encodes the samples of one chunk: the first sample is a full keyframe, the rest are deltas. */
export function encodeChunk(
  frameStart: number,
  frameEnd: number,
  samples: EncodedSample[],
  projectiles: EncodedProjectiles[]
): Uint8Array {
  const w = new ByteWriter()
  w.varint(frameStart)
  w.varint(frameEnd - frameStart)
  w.varint(samples.length)
  let prevFrame = frameStart
  let prev: UnitState[] = []
  samples.forEach((s, i) => {
    w.varint(s.frame - prevFrame)
    prevFrame = s.frame
    if (i === 0) {
      w.varint(s.units.length)
      let last = 0
      for (const u of s.units) {
        w.varint(u.uid - last)
        last = u.uid
        writeUnit(w, u)
      }
    } else {
      const removed: number[] = []
      const added: UnitState[] = []
      const changed: [UnitState, UnitState][] = []
      let a = 0
      let b = 0
      while (a < prev.length || b < s.units.length) {
        const pu = prev[a]
        const cu = s.units[b]
        if (cu === undefined || (pu !== undefined && pu.uid < cu.uid)) {
          removed.push(pu.uid)
          a++
        } else if (pu === undefined || cu.uid < pu.uid) {
          added.push(cu)
          b++
        } else {
          if (
            pu.x !== cu.x ||
            pu.z !== cu.z ||
            pu.heading !== cu.heading ||
            pu.hp !== cu.hp ||
            pu.build !== cu.build ||
            pu.team !== cu.team ||
            pu.def !== cu.def
          )
            changed.push([pu, cu])
          a++
          b++
        }
      }
      w.varint(removed.length)
      let last = 0
      for (const uid of removed) {
        w.varint(uid - last)
        last = uid
      }
      w.varint(added.length)
      last = 0
      for (const u of added) {
        w.varint(u.uid - last)
        last = u.uid
        writeUnit(w, u)
      }
      w.varint(changed.length)
      last = 0
      for (const [p, c] of changed) {
        w.varint(c.uid - last)
        last = c.uid
        let mask = 0
        if (p.x !== c.x || p.z !== c.z) mask |= M_POS
        if (p.heading !== c.heading) mask |= M_HEADING
        if (p.hp !== c.hp) mask |= M_HP
        if (p.build !== c.build) mask |= M_BUILD
        if (p.team !== c.team) mask |= M_TEAM
        if (p.def !== c.def) mask |= M_DEF
        w.u8(mask)
        if (mask & M_POS) {
          w.svarint(c.x - p.x)
          w.svarint(c.z - p.z)
        }
        if (mask & M_HEADING) w.u8(c.heading)
        if (mask & M_HP) w.u8(c.hp)
        if (mask & M_BUILD) w.u8(c.build)
        if (mask & M_TEAM) w.varint(c.team)
        if (mask & M_DEF) w.varint(c.def)
      }
    }
    prev = s.units
  })
  w.varint(projectiles.length)
  prevFrame = frameStart
  for (const ps of projectiles) {
    w.varint(ps.frame - prevFrame)
    prevFrame = ps.frame
    w.varint(ps.list.length)
    for (const p of ps.list) {
      w.varint(p.weapon + 1)
      w.varint(p.team + 1)
      w.u16(p.x)
      w.u16(p.z)
      w.i8(p.vx)
      w.i8(p.vz)
    }
  }
  return w.finish()
}

function allocSample(frame: number, n: number): Sample {
  return {
    frame,
    n,
    uid: new Uint32Array(n),
    def: new Uint16Array(n),
    team: new Uint8Array(n),
    x: new Uint16Array(n),
    z: new Uint16Array(n),
    heading: new Uint8Array(n),
    hp: new Uint8Array(n),
    build: new Uint8Array(n)
  }
}

function readUnitInto(r: ByteReader, s: Sample, i: number, uid: number): void {
  s.uid[i] = uid
  s.def[i] = r.varint()
  s.team[i] = r.varint()
  s.x[i] = r.u16()
  s.z[i] = r.u16()
  s.heading[i] = r.u8()
  s.hp[i] = r.u8()
  s.build[i] = r.u8()
}

function copyUnit(from: Sample, i: number, to: Sample, j: number): void {
  to.uid[j] = from.uid[i]
  to.def[j] = from.def[i]
  to.team[j] = from.team[i]
  to.x[j] = from.x[i]
  to.z[j] = from.z[i]
  to.heading[j] = from.heading[i]
  to.hp[j] = from.hp[i]
  to.build[j] = from.build[i]
}

/** Decodes a (decompressed) chunk into full per-sample unit tables. */
export function decodeChunk(data: Uint8Array): DecodedChunk {
  const r = new ByteReader(data)
  const frameStart = r.varint()
  const frameEnd = frameStart + r.varint()
  const nSamples = r.varint()
  const samples: Sample[] = []
  let frame = frameStart
  for (let si = 0; si < nSamples; si++) {
    frame += r.varint()
    if (si === 0) {
      const n = r.varint()
      const s = allocSample(frame, n)
      let uid = 0
      for (let i = 0; i < n; i++) {
        uid += r.varint()
        readUnitInto(r, s, i, uid)
      }
      samples.push(s)
      continue
    }
    const prev = samples[si - 1]
    const nRemoved = r.varint()
    const removed = new Set<number>()
    let uid = 0
    for (let i = 0; i < nRemoved; i++) removed.add((uid += r.varint()))
    const nAdded = r.varint()
    const added = allocSample(frame, nAdded)
    uid = 0
    for (let i = 0; i < nAdded; i++) readUnitInto(r, added, i, (uid += r.varint()))
    // merge prev (minus removed) with added, both sorted by uid
    const s = allocSample(frame, prev.n - nRemoved + nAdded)
    let a = 0
    let b = 0
    let k = 0
    while (a < prev.n || b < nAdded) {
      if (a < prev.n && removed.has(prev.uid[a])) {
        a++
      } else if (b >= nAdded || (a < prev.n && prev.uid[a] < added.uid[b])) {
        copyUnit(prev, a++, s, k++)
      } else {
        copyUnit(added, b++, s, k++)
      }
    }
    const nChanged = r.varint()
    uid = 0
    let idx = 0
    for (let i = 0; i < nChanged; i++) {
      uid += r.varint()
      while (s.uid[idx] !== uid) {
        idx++
        if (idx >= s.n) throw new Error(`corrupt chunk: changed uid ${uid} not present at frame ${frame}`)
      }
      const mask = r.u8()
      if (mask & M_POS) {
        s.x[idx] += r.svarint()
        s.z[idx] += r.svarint()
      }
      if (mask & M_HEADING) s.heading[idx] = r.u8()
      if (mask & M_HP) s.hp[idx] = r.u8()
      if (mask & M_BUILD) s.build[idx] = r.u8()
      if (mask & M_TEAM) s.team[idx] = r.varint()
      if (mask & M_DEF) s.def[idx] = r.varint()
    }
    samples.push(s)
  }
  const nProj = r.varint()
  const projectiles: ProjectileSample[] = []
  frame = frameStart
  for (let pi = 0; pi < nProj; pi++) {
    frame += r.varint()
    const n = r.varint()
    const p: ProjectileSample = {
      frame,
      n,
      weapon: new Uint16Array(n),
      team: new Uint8Array(n),
      x: new Uint16Array(n),
      z: new Uint16Array(n),
      vx: new Int8Array(n),
      vz: new Int8Array(n)
    }
    for (let i = 0; i < n; i++) {
      p.weapon[i] = r.varint() - 1
      p.team[i] = r.varint() - 1
      p.x[i] = r.u16()
      p.z[i] = r.u16()
      p.vx[i] = r.i8()
      p.vz[i] = r.i8()
    }
    projectiles.push(p)
  }
  return { frameStart, frameEnd, samples, projectiles }
}

const enc = new TextEncoder()
const dec = new TextDecoder()

/** File = "BRVS" | u32 version | u32 headerLength | header JSON | blobs (meta, chunks), all zstd-compressed. */
export function buildFile(header: Omit<StreamHeader, 'meta' | 'chunks'>, meta: Uint8Array, chunks: (ChunkRef & { data: Uint8Array })[]): Uint8Array[] {
  let offset = 0
  const metaRef: BlobRef = { offset, length: meta.length }
  offset += meta.length
  const refs: ChunkRef[] = chunks.map((c) => {
    const ref = { frameStart: c.frameStart, frameEnd: c.frameEnd, offset, length: c.data.length }
    offset += c.data.length
    return ref
  })
  const json = enc.encode(JSON.stringify({ ...header, meta: metaRef, chunks: refs } satisfies StreamHeader))
  const pre = new Uint8Array(12)
  pre.set(enc.encode(MAGIC), 0)
  const dv = new DataView(pre.buffer)
  dv.setUint32(4, FORMAT_VERSION, true)
  dv.setUint32(8, json.length, true)
  return [pre, json, meta, ...chunks.map((c) => c.data)]
}

/** Parses the file prefix; `dataStart` is where blob offsets are counted from. */
export function readHeader(prefix: Uint8Array): { header: StreamHeader; dataStart: number } {
  if (prefix.length < 12 || dec.decode(prefix.subarray(0, 4)) !== MAGIC) throw new Error('Not a BRVS stream file')
  const dv = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength)
  const version = dv.getUint32(4, true)
  if (version !== FORMAT_VERSION) throw new Error(`Unsupported stream format version ${version}`)
  const len = dv.getUint32(8, true)
  if (prefix.length < 12 + len) throw new RangeError(`header needs ${12 + len} bytes`)
  return { header: JSON.parse(dec.decode(prefix.subarray(12, 12 + len))) as StreamHeader, dataStart: 12 + len }
}

export function encodeMeta(meta: StreamMeta): Uint8Array {
  return enc.encode(JSON.stringify(meta))
}

export function decodeMeta(data: Uint8Array): StreamMeta {
  return JSON.parse(dec.decode(data)) as StreamMeta
}
