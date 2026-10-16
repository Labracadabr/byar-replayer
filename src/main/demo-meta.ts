// Extracts library metadata from an .sdfz using sdfz-demo-parser (offline; no API needed).
import { DemoModel, DemoParser } from 'sdfz-demo-parser'
import type { ChatLine } from '@shared/stream/format'
import type { MapMarker, ReplayTimeline } from '@shared/types'
import type { Preset, ReplayPlayer } from '@shared/types'

/** Bump when the extracted fields change, so the library re-parses existing rows. */
export const PARSER_VERSION = 4

const SIM_FPS = 30

export interface DemoMeta {
  gameId: string
  engineVersion: string
  gameVersion: string
  mapName: string
  startTime: number
  /** Real game time, from the last keyframe in the packet stream (header gameTime is 0 for aborted games) */
  durationMs: number
  /** -1 if the game never started (lobby-only demo) */
  lastFrame: number
  /** First keyframe; > 0 when the game was resumed from a saved game (then it can't be re-simulated) */
  firstFrame: number
  preset: Preset
  winners: number[]
  players: ReplayPlayer[]
  spectatorCount: number
  gameSettings: Record<string, string>
  mapSettings: Record<string, string>
}

type RGB = { r: number; g: number; b: number }

function hex(c: RGB | undefined): string {
  if (!c) return '#888888'
  return '#' + [c.r, c.g, c.b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
}

/** [teamN] { rgbcolor=r g b; } from the start script, components 0..1 */
export function teamColorsFromScript(script: string): Map<number, RGB> {
  const out = new Map<number, RGB>()
  for (const m of script.matchAll(/\[team(\d+)\]\s*\{([^}]*)\}/gi)) {
    const c = m[2].match(/rgbcolor\s*=\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/i)
    if (c) out.set(Number(m[1]), { r: +c[1] * 255, g: +c[2] * 255, b: +c[3] * 255 })
  }
  return out
}

export function classifyPreset(players: ReplayPlayer[]): Preset {
  if (players.length === 0) return 'unknown'
  const humans = players.filter((p) => !p.isAI)
  if (players.some((p) => p.isAI) && humans.length > 0) {
    // humans all on one side vs AIs => PvE; mixed teams count as normal games below
    const humanAllies = new Set(humans.map((p) => p.allyTeamId))
    const aiOnlyAllies = new Set(players.filter((p) => p.isAI && !humanAllies.has(p.allyTeamId)).map((p) => p.allyTeamId))
    if (humanAllies.size === 1 && aiOnlyAllies.size > 0) return 'pve'
  }
  const sizes = new Map<number, number>()
  for (const p of players) sizes.set(p.allyTeamId, (sizes.get(p.allyTeamId) ?? 0) + 1)
  const counts = [...sizes.values()]
  if (counts.length < 2) return 'unknown'
  const maxSize = Math.max(...counts)
  if (counts.length === 2) return maxSize === 1 ? 'duel' : 'team'
  return maxSize === 1 ? 'ffa' : 'teamffa'
}

export async function readDemoMeta(path: string): Promise<DemoMeta> {
  const parser = new DemoParser({
    // keep KEYFRAME packets (excluded by default) so we can find the real last frame; store no packets
    includePackets: [],
    excludePackets: [DemoModel.Packet.ID.NEWFRAME, DemoModel.Packet.ID.SYNCRESPONSE, DemoModel.Packet.ID.PLAYERINFO]
  })
  let lastFrame = -1
  let firstFrame = -1
  // BAR broadcasts the in-game team colors in a COLORS Lua message; the parser applies it to humans only
  const luaColors = new Map<number, RGB>()
  parser.onPacket.add((packet) => {
    if (packet.id === DemoModel.Packet.ID.KEYFRAME && packet.data) {
      lastFrame = (packet.data as { frameNum: number }).frameNum
      if (firstFrame < 0) firstFrame = lastFrame
    }
    const lua = packet.data as { data?: { name?: string; data?: unknown } } | undefined
    if (packet.id === DemoModel.Packet.ID.LUAMSG && lua?.data?.name === 'COLORS' && Array.isArray(lua.data.data)) {
      for (const c of lua.data.data as ({ teamID: number } & RGB)[]) luaColors.set(c.teamID, { r: c.r, g: c.g, b: c.b })
    }
  })
  const demo = await parser.parseDemo(path)
  const info = demo.info
  const scriptColors = teamColorsFromScript(demo.script)
  const colorOf = (teamId: number, own?: RGB): string => hex(luaColors.get(teamId) ?? own ?? scriptColors.get(teamId))
  const players: ReplayPlayer[] = [
    ...info.players.map((p) => ({
      playerId: p.playerId,
      rank: p.rank ?? undefined,
      name: p.name,
      teamId: p.teamId,
      allyTeamId: p.allyTeamId,
      color: colorOf(p.teamId, p.rgbColor),
      isAI: false,
      faction: p.faction || undefined,
      skill: p.skill || undefined
    })),
    ...info.ais.map((a) => ({
      playerId: -1,
      name: a.name || a.shortName,
      teamId: a.teamId,
      allyTeamId: a.allyTeamId,
      color: colorOf(a.teamId, a.rgbColor),
      isAI: true,
      faction: a.faction || undefined
    }))
  ].sort((a, b) => a.allyTeamId - b.allyTeamId || a.teamId - b.teamId)

  return {
    gameId: info.meta.gameId,
    engineVersion: info.meta.engine,
    gameVersion: info.meta.game,
    mapName: info.meta.map,
    startTime: new Date(info.meta.startTime).getTime(),
    durationMs: lastFrame > 0 ? Math.round((lastFrame / SIM_FPS) * 1000) : 0,
    lastFrame,
    firstFrame,
    preset: classifyPreset(players),
    // GAMEOVER packet first, end-of-demo stats block as fallback
    winners: info.meta.winningAllyTeamIds?.length ? info.meta.winningAllyTeamIds : (demo.statistics?.winningAllyTeamIds ?? []),
    players,
    spectatorCount: info.spectators.length,
    gameSettings: info.gameSettings ?? {},
    mapSettings: info.mapSettings ?? {}
  }
}

/** Chat and map drawings stamped with exact sim frames (counted from KEYFRAME/NEWFRAME packets, pause-proof). */
export async function readDemoTimeline(path: string): Promise<ReplayTimeline> {
  const ID = DemoModel.Packet.ID
  // keep frame packets: they are excluded by default
  const parser = new DemoParser({ includePackets: [], excludePackets: [ID.SYNCRESPONSE, ID.PLAYERINFO] })
  let frame = 0
  const chat: ChatLine[] = []
  const markers: MapMarker[] = []
  parser.onPacket.add((packet) => {
    if (packet.id === ID.KEYFRAME && packet.data) frame = (packet.data as { frameNum: number }).frameNum
    else if (packet.id === ID.NEWFRAME) frame++
    else if (packet.id === ID.CHAT && packet.data) {
      const d = packet.data as { fromId: number; toId: number; message: string }
      const type = d.toId === 252 ? 'ally' : d.toId === 253 ? 'spec' : d.toId === 254 ? 'global' : 'self'
      if (type !== 'self') chat.push({ frame, playerId: d.fromId, name: '', type, message: d.message.trim() })
    } else if (packet.id === ID.MAPDRAW && packet.data) {
      const d = packet.data as { playerNum: number; mapDrawAction: number; x: number; z: number; x2?: number; z2?: number; label?: string }
      const kind = d.mapDrawAction === 0 ? 'point' : d.mapDrawAction === 2 ? 'line' : 'erase'
      markers.push({
        frame,
        playerId: d.playerNum,
        kind,
        x: d.x,
        z: d.z,
        ...(kind === 'line' ? { x2: d.x2 ?? d.x, z2: d.z2 ?? d.z } : {}),
        ...(kind === 'point' ? { label: (d.label ?? '').trim() } : {})
      })
    }
  })
  const demo = await parser.parseDemo(path)
  const names = new Map<number, string>()
  for (const p of [...demo.info.players, ...demo.info.spectators]) names.set(p.playerId, p.name)
  for (const c of chat) c.name = names.get(c.playerId) ?? ''
  return { chat, markers }
}

/** Chat log for the stream converter. */
export async function readDemoChat(path: string): Promise<ChatLine[]> {
  return (await readDemoTimeline(path)).chat
}
