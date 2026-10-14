import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Preset, ReplaySummary, ScanProgress, SimStatus } from '@shared/types'
import { DetailPanel } from './DetailPanel'
import { allyGroups, formatDate, formatDuration, PRESET_LABEL, winnerLabel } from './format'

const SIM_LABEL: Record<SimStatus, string> = {
  none: 'Not simulated',
  queued: 'Queued',
  running: 'Simulating',
  ready: 'Ready',
  failed: 'Failed'
}

function SimBadge({ r }: { r: ReplaySummary }): React.JSX.Element {
  const text = r.simStatus === 'running' ? `Simulating ${Math.round(r.simProgress * 100)}%` : SIM_LABEL[r.simStatus]
  return <span className={`badge sim-${r.simStatus}`}>{text}</span>
}

function Teams({ r }: { r: ReplaySummary }): React.JSX.Element {
  const groups = allyGroups(r.players)
  if (groups.length === 0) return <span className="muted">–</span>
  // big games: show counts instead of every name
  if (r.players.length > 6) {
    return <span>{groups.map((g) => g.length).join(' v ')}</span>
  }
  return (
    <span className="teams">
      {groups.map((g, i) => (
        <span key={i}>
          {i > 0 && <span className="vs"> vs </span>}
          {g.map((p, j) => (
            <span key={j}>
              {j > 0 && ', '}
              <span className="pdot" style={{ background: p.color }} />
              {p.name}
            </span>
          ))}
        </span>
      ))}
    </span>
  )
}

interface Filters {
  text: string
  favorites: boolean
  sim: SimStatus | ''
  preset: Preset | ''
  from: string
  to: string
}

const EMPTY: Filters = { text: '', favorites: false, sim: '', preset: '', from: '', to: '' }

function matches(r: ReplaySummary, f: Filters): boolean {
  if (f.favorites && !r.favorite) return false
  if (f.sim && r.simStatus !== f.sim) return false
  if (f.preset && r.preset !== f.preset) return false
  if (f.from && r.startTime < new Date(f.from).getTime()) return false
  if (f.to && r.startTime >= new Date(f.to).getTime() + 86_400_000) return false
  if (f.text) {
    const q = f.text.toLowerCase()
    const hay = [r.mapName, r.fileName, ...r.players.map((p) => p.name)].join('\n').toLowerCase()
    if (!q.split(/\s+/).every((w) => hay.includes(w))) return false
  }
  return true
}

export function LibraryView({ onOpenSettings }: { onOpenSettings(): void }): React.JSX.Element {
  const [replays, setReplays] = useState<ReplaySummary[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [filters, setFilters] = useState<Filters>(EMPTY)
  const [scan, setScan] = useState<ScanProgress>({ running: false, done: 0, total: 0 })

  const reload = useCallback(() => void window.api.listReplays().then(setReplays), [])
  useEffect(() => {
    reload()
    const off1 = window.api.onLibraryChanged(reload)
    const off2 = window.api.onScanProgress(setScan)
    return () => {
      off1()
      off2()
    }
  }, [reload])

  const visible = useMemo(() => replays.filter((r) => matches(r, filters)), [replays, filters])
  const set = <K extends keyof Filters>(k: K, v: Filters[K]): void => setFilters((f) => ({ ...f, [k]: v }))

  const toggleFavorite = async (r: ReplaySummary): Promise<void> => {
    await window.api.setFavorite(r.id, !r.favorite)
    reload()
  }

  return (
    <div className="library">
      <header className="toolbar">
        <input
          className="search"
          placeholder="Search player or map…"
          value={filters.text}
          onChange={(e) => set('text', e.target.value)}
        />
        <label className="check">
          <input type="checkbox" checked={filters.favorites} onChange={(e) => set('favorites', e.target.checked)} />
          ★ Favorites
        </label>
        <select value={filters.preset} onChange={(e) => set('preset', e.target.value as Preset | '')}>
          <option value="">All modes</option>
          {(['duel', 'team', 'ffa', 'teamffa', 'pve'] as Preset[]).map((p) => (
            <option key={p} value={p}>
              {PRESET_LABEL[p]}
            </option>
          ))}
        </select>
        <select value={filters.sim} onChange={(e) => set('sim', e.target.value as SimStatus | '')}>
          <option value="">Any sim status</option>
          {(Object.keys(SIM_LABEL) as SimStatus[]).map((s) => (
            <option key={s} value={s}>
              {SIM_LABEL[s]}
            </option>
          ))}
        </select>
        <input type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} title="From date" />
        <input type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} title="To date" />
        {JSON.stringify(filters) !== JSON.stringify(EMPTY) && (
          <button type="button" onClick={() => setFilters(EMPTY)}>
            Clear
          </button>
        )}
        <span className="spacer" />
        <span className="muted">
          {scan.running ? `Scanning ${scan.done}/${scan.total}…` : `${visible.length} of ${replays.length} replays`}
        </span>
        <button type="button" onClick={() => void window.api.rescan()} disabled={scan.running}>
          Rescan
        </button>
        <button type="button" onClick={onOpenSettings}>
          Settings
        </button>
      </header>
      <div className="library-body">
        <div className="table-wrap">
          <table className="replays">
            <thead>
              <tr>
                <th className="col-fav">★</th>
                <th>Date</th>
                <th>Map</th>
                <th>Players</th>
                <th>Mode</th>
                <th>Duration</th>
                <th>Winner</th>
                <th>Simulation</th>
                <th className="col-note" title="Has note">✎</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id} className={r.id === selected ? 'selected' : ''} onClick={() => setSelected(r.id)}>
                  <td className="col-fav">
                    <button
                      type="button"
                      className={'star' + (r.favorite ? ' on' : '')}
                      onClick={(e) => {
                        e.stopPropagation()
                        void toggleFavorite(r)
                      }}
                    >
                      {r.favorite ? '★' : '☆'}
                    </button>
                  </td>
                  <td className="nowrap">{formatDate(r.startTime)}</td>
                  <td>{r.parseError ? <span className="error" title={r.parseError}>Unreadable: {r.fileName}</span> : r.mapName}</td>
                  <td>
                    <Teams r={r} />
                  </td>
                  <td>{PRESET_LABEL[r.preset]}</td>
                  <td className="nowrap">{formatDuration(r.durationMs)}</td>
                  <td>{winnerLabel(r)}</td>
                  <td>
                    <SimBadge r={r} />
                  </td>
                  <td className="col-note">{r.note ? '✎' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {visible.length === 0 && !scan.running && (
            <div className="empty">{replays.length === 0 ? 'No replays found in the replay folders.' : 'No replays match the filters.'}</div>
          )}
        </div>
        {selected !== null && <DetailPanel id={selected} onChanged={reload} onClose={() => setSelected(null)} />}
      </div>
    </div>
  )
}
