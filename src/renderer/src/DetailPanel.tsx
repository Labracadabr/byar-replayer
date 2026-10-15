import { useEffect, useRef, useState } from 'react'
import type { ReplayDetail } from '@shared/types'
import { DepsSection } from './DepsSection'
import { SimSection } from './SimSection'
import { allyGroups, formatDate, formatDuration, PRESET_LABEL } from './format'

interface Props {
  id: number
  onChanged(): void
  onClose(): void
  onOpenPlayer(id: number, title: string): void
}

export function DetailPanel({ id, onChanged, onClose, onOpenPlayer }: Props): React.JSX.Element {
  const [r, setR] = useState<ReplayDetail | null>(null)
  const [note, setNote] = useState('')
  const [saved, setSaved] = useState(true)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<{ id: number; note: string } | null>(null)

  const flush = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const p = pending.current
    pending.current = null
    if (p) void window.api.setNote(p.id, p.note).then(() => {
      setSaved(true)
      onChanged()
    })
  }

  useEffect(() => {
    let alive = true
    void window.api.getReplay(id).then((d) => {
      if (!alive) return
      setR(d)
      setNote(d?.note ?? '')
      setSaved(true)
    })
    return () => {
      alive = false
      flush() // save a pending note before switching replays
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const editNote = (v: string): void => {
    setNote(v)
    setSaved(false)
    pending.current = { id, note: v }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, 600)
  }

  if (!r) return <aside className="detail" />

  const toggleFav = async (): Promise<void> => {
    await window.api.setFavorite(r.id, !r.favorite)
    setR({ ...r, favorite: !r.favorite })
    onChanged()
  }

  const settingsEntries = Object.entries(r.gameSettings).filter(([, v]) => v !== '' && v !== undefined)

  return (
    <aside className="detail">
      <div className="detail-head">
        <div>
          <h2>{r.mapName || r.fileName}</h2>
          <div className="muted">
            {formatDate(r.startTime)} · {PRESET_LABEL[r.preset]} · {formatDuration(r.durationMs)}
          </div>
        </div>
        <div className="detail-head-actions">
          <button type="button" className={'star big' + (r.favorite ? ' on' : '')} onClick={toggleFav} title="Favorite">
            {r.favorite ? '★' : '☆'}
          </button>
          <button type="button" onClick={onClose} title="Close">
            ✕
          </button>
        </div>
      </div>

      {r.parseError && <div className="error-box">Could not read this replay: {r.parseError}</div>}
      {r.lastFrame < 0 && !r.parseError && <div className="warn-box">This game never started (lobby only).</div>}

      <SimSection replay={r} onChanged={onChanged} onOpenPlayer={onOpenPlayer} />

      {!r.parseError && r.lastFrame >= 0 && (
        <section>
          <h3>Requirements</h3>
          <DepsSection replayId={r.id} />
        </section>
      )}

      <section>
        <h3>Players</h3>
        {allyGroups(r.players).map((g, i) => (
          <div className={'ally' + (r.winners.includes(g[0].allyTeamId) ? ' winner' : '')} key={i}>
            <div className="ally-title">
              Team {g[0].allyTeamId + 1}
              {r.winners.includes(g[0].allyTeamId) && <span className="badge win">Winner</span>}
            </div>
            {g.map((p, j) => (
              <div className="player" key={j}>
                <span className="pdot" style={{ background: p.color }} />
                <span className="pname">{p.name}</span>
                {p.isAI && <span className="badge">AI</span>}
                <span className="muted">{[p.faction, p.skill].filter(Boolean).join(' ')}</span>
              </div>
            ))}
          </div>
        ))}
        {r.spectatorCount > 0 && <div className="muted">{r.spectatorCount} spectators</div>}
      </section>

      <section>
        <h3>
          Note <span className="muted small">{saved ? '' : 'saving…'}</span>
        </h3>
        <textarea value={note} onChange={(e) => editNote(e.target.value)} onBlur={flush} placeholder="Your notes on this game…" rows={5} />
      </section>

      <section>
        <h3>Game</h3>
        <dl className="kv">
          <dt>Game version</dt>
          <dd>{r.gameVersion}</dd>
          <dt>Engine</dt>
          <dd>{r.engineVersion}</dd>
          <dt>Game ID</dt>
          <dd className="mono">{r.gameId}</dd>
          <dt>File</dt>
          <dd className="mono small">{r.fileName}</dd>
        </dl>
        {settingsEntries.length > 0 && (
          <details>
            <summary>Game settings ({settingsEntries.length})</summary>
            <dl className="kv small">
              {settingsEntries.map(([k, v]) => (
                <div key={k} className="kv-row">
                  <dt>{k}</dt>
                  <dd>{v.length > 80 ? v.slice(0, 80) + '…' : v}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </section>
    </aside>
  )
}
