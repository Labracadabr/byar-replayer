import { useState } from 'react'
import type { ReplayPlayer, ReplaySummary } from '@shared/types'
import { allyGroups } from './format'

/** In-game rank chevron from the replay's own game version (rank 0..7 -> ranks/1..8.png). */
export function RankIcon({ replayId, rank }: { replayId: number; rank?: number }): React.JSX.Element | null {
  const [broken, setBroken] = useState(false)
  if (rank === undefined || rank === null || broken) return <span className="rank-icon" />
  return (
    <img
      className="rank-icon"
      src={`brv://game/${replayId}/luaui/images/advplayerslist/ranks/${rank + 1}.png`}
      alt={`rank ${rank}`}
      title={`Rank ${rank + 1}`}
      onError={() => setBroken(true)}
    />
  )
}

function PlayerRow({ replayId, p }: { replayId: number; p: ReplayPlayer }): React.JSX.Element {
  return (
    <div className="roster-row">
      {p.isAI ? <span className="rank-icon" /> : <RankIcon replayId={replayId} rank={p.rank} />}
      <span className="pdot" style={{ background: p.color }} />
      <span className="roster-name">{p.name}</span>
      {p.isAI && <span className="badge">AI</span>}
      <span className="muted small">{[p.faction, p.skill].filter(Boolean).join(' ')}</span>
    </div>
  )
}

/** Full player list of a game, shown while hovering the Players cell. */
export function RosterTooltip({ r, x, y }: { r: ReplaySummary; x: number; y: number }): React.JSX.Element {
  const groups = allyGroups(r.players)
  // keep it on screen: flip above the cursor near the bottom edge
  const style: React.CSSProperties = { left: Math.min(x + 16, window.innerWidth - 380) }
  if (y > window.innerHeight * 0.55) style.bottom = window.innerHeight - y + 12
  else style.top = y + 16
  return (
    <div className="roster-tooltip" style={style}>
      {groups.map((g, i) => (
        <div key={i} className={'roster-team' + (r.winners.includes(g[0].allyTeamId) ? ' winner' : '')}>
          <div className="roster-team-title">
            Team {g[0].allyTeamId + 1}
            {r.winners.includes(g[0].allyTeamId) && <span className="badge win">Winner</span>}
          </div>
          {g.map((p, j) => (
            <PlayerRow key={j} replayId={r.id} p={p} />
          ))}
        </div>
      ))}
      {r.spectatorCount > 0 && <div className="muted small">{r.spectatorCount} spectators</div>}
    </div>
  )
}
