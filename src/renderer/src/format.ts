import type { ReplayPlayer, ReplaySummary } from '@shared/types'

export function formatDuration(ms: number): string {
  if (ms <= 0) return '–'
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

export function formatDate(ms: number): string {
  if (!ms) return '–'
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Players grouped by ally team, in ally-team order. */
export function allyGroups(players: ReplayPlayer[]): ReplayPlayer[][] {
  const groups = new Map<number, ReplayPlayer[]>()
  for (const p of players) {
    if (!groups.has(p.allyTeamId)) groups.set(p.allyTeamId, [])
    groups.get(p.allyTeamId)!.push(p)
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])
}

export function winnerLabel(r: ReplaySummary): string {
  if (r.winners.length === 0) return r.lastFrame < 0 ? 'not started' : '–'
  const groups = allyGroups(r.players)
  const names = r.winners.map((w) => {
    const team = groups.find((g) => g[0]?.allyTeamId === w)
    if (!team) return `Team ${w + 1}`
    return team.length === 1 ? team[0].name : `Team ${w + 1}`
  })
  return names.join(', ')
}

export const PRESET_LABEL: Record<string, string> = {
  duel: 'Duel',
  team: 'Team',
  ffa: 'FFA',
  teamffa: 'Team FFA',
  pve: 'vs AI',
  unknown: '?'
}
