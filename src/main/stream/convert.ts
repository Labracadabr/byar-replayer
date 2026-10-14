// Converts the recorder's raw text output (docs/raw-format.md) into a BRVS state stream (docs/format.md).
import { createReadStream, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { constants, zstdCompressSync } from 'node:zlib'
import {
  buildFile,
  type ChatLine,
  type ChunkRef,
  encodeChunk,
  encodeMeta,
  type EncodedProjectiles,
  type EncodedSample,
  EVENT_CREATE,
  EVENT_DEATH,
  EVENT_FINISH,
  EVENT_GAMEOVER,
  EVENT_GIVE,
  type ProjectileState,
  type StreamEvent,
  type StreamHeader,
  type StreamMeta,
  type TeamInfo,
  type TeamStats,
  type UnitDefInfo,
  type UnitKind,
  type UnitState
} from '@shared/stream/format'

export const DEFAULT_KEYFRAME_INTERVAL = 600 // 20 s
const STATS_INTERVAL = 30
const ZSTD_LEVEL = 9

export interface ConvertInput {
  rawPath: string
  /** BRVDEFS file; optional (names/kinds fall back to placeholders) */
  unitDefsPath?: string
  outPath: string
  gameId: string
  chat: ChatLine[]
  keyframeInterval?: number
}

export interface ConvertResult {
  bytes: number
  chunks: number
  uniqueUnits: number
  samples: number
  lastFrame: number
  elapsedMs: number
}

export function compress(data: Uint8Array): Uint8Array {
  return zstdCompressSync(data, { params: { [constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL } })
}

interface RawDefs {
  units: Map<number, UnitDefInfo>
  weapons: Map<number, { name: string; type: string }>
}

export function parseUnitDefs(text: string): RawDefs {
  const units = new Map<number, UnitDefInfo>()
  const weapons = new Map<number, { name: string; type: string }>()
  for (const line of text.split(/\r?\n/)) {
    const f = line.split(' ')
    if (f[0] === 'U' && f.length >= 15) {
      const [, id, name, xsize, zsize, isB, isAir, isShip, isCom, metal, energy, health, , iconType] = f
      const kind: UnitKind =
        isCom === '1' ? 'commander' : isB === '1' ? 'building' : isAir === '1' ? 'air' : isShip === '1' ? 'ship' : 'ground'
      units.set(Number(id), {
        name,
        humanName: f.slice(14).join(' '),
        xsize: Number(xsize),
        zsize: Number(zsize),
        kind,
        metal: Number(metal),
        energy: Number(energy),
        health: Number(health),
        iconType
      })
    } else if (f[0] === 'W' && f.length >= 4) {
      weapons.set(Number(f[1]), { name: f[2], type: f[3] })
    }
  }
  return { units, weapons }
}

function hexColor(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')
}

const clampU16 = (v: number): number => (v < 0 ? 0 : v > 0xffff ? 0xffff : v)
/** engine heading -32768..32767 -> 0..255 */
const heading8 = (h: number): number => ((h + 32768) >> 8) & 0xff

export async function convertRaw(input: ConvertInput): Promise<ConvertResult> {
  const t0 = Date.now()
  const K = input.keyframeInterval ?? DEFAULT_KEYFRAME_INTERVAL
  const defs: RawDefs =
    input.unitDefsPath && existsSync(input.unitDefsPath)
      ? parseUnitDefs(readFileSync(input.unitDefsPath, 'utf8'))
      : { units: new Map(), weapons: new Map() }

  const hdr: Record<string, string> = {}
  const teams: TeamInfo[] = []
  let gaia = -1
  let winners: number[] = []
  let endReason = 'unknown'
  let lastFrame = 0
  const events: StreamEvent[] = []
  const usedDefs = new Set<number>()
  const usedWeapons = new Set<number>()
  const stats: Record<number, TeamStats> = {}

  // engine unit ids are reused after death: map them to stable uids
  let nextUid = 1
  const alive = new Map<number, { uid: number; def: number }>()
  const dying = new Map<number, { uid: number; def: number }>() // destroyed but maybe still listed for a few frames
  const uidFor = (rawId: number, def: number): number => {
    const a = alive.get(rawId)
    if (a && a.def === def) return a.uid
    const d = dying.get(rawId)
    if (d && d.def === def) return d.uid
    const uid = nextUid++
    alive.set(rawId, { uid, def })
    return uid
  }

  // chunk assembly
  const chunks: (ChunkRef & { data: Uint8Array })[] = []
  let chunkIdx = -1
  let samples: EncodedSample[] = []
  let projs: EncodedProjectiles[] = []
  let nSamples = 0
  const flushChunk = (): void => {
    if (chunkIdx >= 0 && samples.length > 0) {
      const frameStart = chunkIdx * K
      const raw = encodeChunk(frameStart, frameStart + K, samples, projs)
      chunks.push({ frameStart, frameEnd: frameStart + K, offset: 0, length: 0, data: compress(raw) })
    }
    samples = []
    projs = []
  }
  const enterChunkFor = (frame: number): void => {
    const idx = Math.floor(frame / K)
    if (idx !== chunkIdx) {
      flushChunk()
      chunkIdx = idx
    }
  }

  const recordStats = (frame: number, units: UnitState[]): void => {
    if (frame % STATS_INTERVAL !== 0) return
    const i = frame / STATS_INTERVAL
    const count = new Map<number, number>()
    const army = new Map<number, number>()
    for (const u of units) {
      count.set(u.team, (count.get(u.team) ?? 0) + 1)
      const d = defs.units.get(u.def)
      if (d && d.kind !== 'building' && u.build >= 100) army.set(u.team, (army.get(u.team) ?? 0) + d.metal)
    }
    for (const t of teams) {
      if (t.isGaia) continue
      const s = (stats[t.teamId] ??= { units: [], army: [] })
      // pad gaps (missing samples) with the previous value
      while (s.units.length < i) {
        s.units.push(s.units.at(-1) ?? 0)
        s.army.push(s.army.at(-1) ?? 0)
      }
      s.units[i] = count.get(t.teamId) ?? 0
      s.army[i] = army.get(t.teamId) ?? 0
    }
  }

  const rl = createInterface({ input: createReadStream(input.rawPath, { encoding: 'utf8', highWaterMark: 1 << 20 }), crlfDelay: Infinity })
  const it = rl[Symbol.asyncIterator]()
  const next = async (): Promise<string | undefined> => {
    const r = await it.next()
    return r.done ? undefined : r.value
  }

  const first = await next()
  if (!first?.startsWith('BRVRAW 1')) throw new Error('Not a BRVRAW v1 recording')

  for (let line = await next(); line !== undefined; line = await next()) {
    if (line.length === 0) continue
    const f = line.split(' ')
    switch (f[0]) {
      case 'H':
        for (const kv of f.slice(1)) {
          const eq = kv.indexOf('=')
          if (eq > 0) hdr[kv.slice(0, eq)] = kv.slice(eq + 1)
        }
        gaia = Number(hdr.gaia ?? -1)
        break
      case 'T': {
        const teamId = Number(f[1])
        teams.push({
          teamId,
          allyTeam: Number(f[2]),
          color: hexColor(Number(f[3]), Number(f[4]), Number(f[5])),
          isAI: f[6] === '1',
          side: f[7],
          name: f.slice(8).join(' '),
          isGaia: teamId === gaia
        })
        break
      }
      case 'F': {
        const frame = Number(f[1])
        const count = Number(f[2])
        const units: UnitState[] = []
        for (let i = 0; i < count; i++) {
          const l = await next()
          if (l === undefined) break
          const u = l.split(' ')
          const rawId = Number(u[0])
          const def = Number(u[1])
          const maxHp = Number(u[8])
          usedDefs.add(def)
          units.push({
            uid: uidFor(rawId, def),
            def,
            team: Number(u[2]),
            x: clampU16(Number(u[3])),
            z: clampU16(Number(u[4])),
            heading: heading8(Number(u[6])),
            hp: maxHp > 0 ? Math.max(0, Math.min(255, Math.round((Number(u[7]) / maxHp) * 255))) : 255,
            build: Math.max(0, Math.min(100, Number(u[9])))
          })
        }
        units.sort((a, b) => a.uid - b.uid)
        enterChunkFor(frame)
        samples.push({ frame, units })
        nSamples++
        recordStats(frame, units)
        lastFrame = Math.max(lastFrame, frame)
        // units still listed after their death event are done dying once they leave the sample
        if (dying.size > 0) {
          const listed = new Set(units.map((u) => u.uid))
          for (const [rawId, d] of dying) if (!listed.has(d.uid)) dying.delete(rawId)
        }
        break
      }
      case 'P': {
        const frame = Number(f[1])
        const count = Number(f[2])
        const list: ProjectileState[] = []
        for (let i = 0; i < count; i++) {
          const l = await next()
          if (l === undefined) break
          const p = l.split(' ')
          const weapon = Number(p[1])
          if (weapon >= 0) usedWeapons.add(weapon)
          list.push({
            weapon,
            team: Number(p[2]),
            x: clampU16(Number(p[3])),
            z: clampU16(Number(p[4])),
            vx: Number(p[6]),
            vz: Number(p[7])
          })
        }
        enterChunkFor(frame)
        projs.push({ frame, list })
        break
      }
      case 'E': {
        const frame = Number(f[1])
        const rawId = Number(f[3])
        const def = Number(f[4])
        switch (f[2]) {
          case 'C': {
            dying.delete(rawId)
            const uid = nextUid++
            alive.set(rawId, { uid, def })
            usedDefs.add(def)
            const builder = Number(f[6])
            events.push([frame, EVENT_CREATE, uid, def, Number(f[5]), builder >= 0 ? (alive.get(builder)?.uid ?? -1) : -1, -1, -1])
            break
          }
          case 'F':
            events.push([frame, EVENT_FINISH, uidFor(rawId, def), def, Number(f[5]), -1, -1, -1])
            break
          case 'D': {
            const uid = uidFor(rawId, def)
            const attacker = Number(f[6])
            const attackerUid = attacker >= 0 ? (alive.get(attacker)?.uid ?? -1) : -1
            events.push([frame, EVENT_DEATH, uid, def, Number(f[5]), attackerUid, Number(f[9]), Number(f[10])])
            alive.delete(rawId)
            dying.set(rawId, { uid, def })
            break
          }
          case 'G':
            events.push([frame, EVENT_GIVE, uidFor(rawId, def), def, Number(f[5]), Number(f[6]), -1, -1])
            break
          case 'O':
            winners = (f[3] ?? '').split(',').filter(Boolean).map(Number)
            events.push([frame, EVENT_GAMEOVER, -1, -1, -1, -1, -1, -1])
            break
        }
        break
      }
      case 'DONE':
        endReason = f[1]
        lastFrame = Math.max(lastFrame, Number(f[2]))
        break
    }
  }
  flushChunk()
  if (chunks.length === 0) throw new Error('Recording contains no unit samples')

  const unitDefs: Record<number, UnitDefInfo> = {}
  for (const id of usedDefs) {
    unitDefs[id] = defs.units.get(id) ?? {
      name: `def${id}`,
      humanName: `Unit #${id}`,
      xsize: 2,
      zsize: 2,
      kind: 'ground',
      metal: 0,
      energy: 0,
      health: 0,
      iconType: 'default'
    }
  }
  const weaponDefs: Record<number, { name: string; type: string }> = {}
  for (const id of usedWeapons) weaponDefs[id] = defs.weapons.get(id) ?? { name: `weapon${id}`, type: 'unknown' }

  const meta: StreamMeta = {
    teams,
    winners,
    unitDefs,
    weaponDefs,
    events,
    chat: input.chat,
    stats: { interval: STATS_INTERVAL, teams: stats }
  }
  const header: Omit<StreamHeader, 'meta' | 'chunks'> = {
    formatVersion: 1,
    gameId: input.gameId,
    mapName: (hdr.map ?? '').replace(/_/g, ' '),
    mapSizeX: Number(hdr.mapX ?? 0),
    mapSizeZ: Number(hdr.mapZ ?? 0),
    sampleInterval: Number(hdr.interval ?? 15),
    projectileInterval: Number(hdr.projInterval ?? 0),
    keyframeInterval: K,
    firstFrame: chunks[0].frameStart,
    lastFrame,
    endReason,
    engine: hdr.engine ?? '',
    game: (hdr.game ?? '').replace(/_/g, ' '),
    createdAt: Date.now()
  }
  const parts = buildFile(header, compress(encodeMeta(meta)), chunks)
  const part = input.outPath + '.part'
  writeFileSync(part, Buffer.concat(parts))
  rmSync(input.outPath, { force: true })
  renameSync(part, input.outPath)
  return {
    bytes: parts.reduce((n, p) => n + p.length, 0),
    chunks: chunks.length,
    uniqueUnits: nextUid - 1,
    samples: nSamples,
    lastFrame,
    elapsedMs: Date.now() - t0
  }
}
