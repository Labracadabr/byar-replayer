import { useCallback, useEffect, useMemo, useState } from 'react'
import { isResumedGame, simStatusOf } from '@shared/sim-status'
import type { Preset, ReplaySummary, ScanProgress, SimStatus } from '@shared/types'
import { DetailPanel } from './DetailPanel'
import { RosterTooltip } from './RosterTooltip'
import { allyGroups, formatDate, formatDuration, PRESET_LABEL, winnerLabel } from './format'

const SIM_LABEL: Record<SimStatus, string> = {
  none: 'Not simulated',
  queued: 'Queued',
  running: 'Simulating',
  ready: 'Ready',
  failed: 'Failed'
}

function SimBadge({ r }: { r: ReplaySummary }): React.JSX.Element {
  if (r.simStatus === 'none' && isResumedGame(r))
    return (
      <span className="badge sim-none" title="Continues a saved game: can't be re-simulated">
        Saved game
      </span>
    )
  let text = SIM_LABEL[r.simStatus]
  if (r.simStatus === 'running')
    text = r.simStage === 'simulating' ? `Simulating ${Math.round(r.simProgress * 100)}%` : r.simStage === 'deps' ? 'Preparing…' : 'Loading…'
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

type SortKey = 'date' | 'map' | 'players' | 'mode' | 'duration' | 'sim'
const SORT_VALUE: Record<SortKey, (r: ReplaySummary) => string | number> = {
  date: (r) => r.startTime,
  map: (r) => r.mapName.toLowerCase(),
  players: (r) => r.players.length,
  mode: (r) => r.preset,
  duration: (r) => r.durationMs,
  sim: (r) => ['running', 'queued', 'ready', 'failed', 'none'].indexOf(r.simStatus)
}

function MapCell({ r }: { r: ReplaySummary }): React.JSX.Element {
  const [broken, setBroken] = useState(false)
  if (r.parseError) return <span className="error" title={r.parseError}>Unreadable: {r.fileName}</span>
  return (
    <span className="map-cell">
      {broken ? (
        <span className="map-thumb empty-thumb" />
      ) : (
        <img className="map-thumb" src={`brv://minimap/${r.id}?thumb=1`} loading="lazy" alt="" onError={() => setBroken(true)} />
      )}
      {r.mapName}
    </span>
  )
}

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

export function LibraryView({
  onOpenSettings,
  onOpenPlayer
}: {
  onOpenSettings(): void
  onOpenPlayer(id: number, title: string): void
}): React.JSX.Element {
  const [replays, setReplays] = useState<ReplaySummary[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [filters, setFilters] = useState<Filters>(EMPTY)
  const [scan, setScan] = useState<ScanProgress>({ running: false, done: 0, total: 0 })
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'date', desc: true })
  const [dragging, setDragging] = useState(false)
  const [importMsg, setImportMsg] = useState<string | null>(null)
  const [roster, setRoster] = useState<{ r: ReplaySummary; x: number; y: number } | null>(null)

  const reload = useCallback(() => void window.api.listReplays().then(setReplays), [])
  useEffect(() => {
    reload()
    const off1 = window.api.onLibraryChanged(reload)
    const off2 = window.api.onScanProgress(setScan)
    // patch the row in place on job progress instead of reloading the whole list
    const off3 = window.api.onJobUpdate((job) =>
      setReplays((rows) =>
        rows.map((r) => {
          if (r.id !== job.replayId) return r
          const sim = simStatusOf(job)
          return { ...r, simStatus: sim.status, simProgress: sim.progress, simStage: job.status === 'running' ? job.stage : null }
        })
      )
    )
    return () => {
      off1()
      off2()
      off3()
    }
  }, [reload])

  const visible = useMemo(() => {
    const v = SORT_VALUE[sort.key]
    const dir = sort.desc ? -1 : 1
    return replays
      .filter((r) => matches(r, filters))
      .sort((a, b) => {
        const x = v(a)
        const y = v(b)
        return (x < y ? -1 : x > y ? 1 : b.startTime - a.startTime) * dir
      })
  }, [replays, filters, sort])

  const imported = (ids: number[], tried: number): void => {
    reload()
    if (ids.length > 0) {
      setSelected(ids[0])
      setFilters(EMPTY) // make sure the imported replay is visible
    }
    setImportMsg(tried > ids.length ? `${tried - ids.length} file(s) skipped: only .sdfz replays can be imported.` : null)
  }

  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setDragging(false)
    const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean)
    if (paths.length === 0) return
    imported(await window.api.importReplays(paths), paths.length)
  }

  const header = (key: SortKey, label: string): React.JSX.Element => (
    <th
      className="sortable"
      onClick={() => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key === 'date' || key === 'duration' }))}
    >
      {label}
      {sort.key === key && <span className="sort-arrow">{sort.desc ? ' ▾' : ' ▴'}</span>}
    </th>
  )
  const set = <K extends keyof Filters>(k: K, v: Filters[K]): void => setFilters((f) => ({ ...f, [k]: v }))

  const toggleFavorite = async (r: ReplaySummary): Promise<void> => {
    await window.api.setFavorite(r.id, !r.favorite)
    reload()
  }

  return (
    <div
      className="library"
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={onDrop}
    >
      {dragging && <div className="drop-overlay">Drop .sdfz replays to add them</div>}
      {roster && <RosterTooltip r={roster.r} x={roster.x} y={roster.y} />}
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
        {(() => {
          const running = replays.filter((r) => r.simStatus === 'running').length
          const queued = replays.filter((r) => r.simStatus === 'queued').length
          return running + queued > 0 ? (
            <span className="badge sim-running">
              {running} simulating{queued > 0 && ` · ${queued} queued`}
            </span>
          ) : null
        })()}
        <span className="muted">
          {scan.running ? `Scanning ${scan.done}/${scan.total}…` : `${visible.length} of ${replays.length} replays`}
        </span>
        <button type="button" onClick={async () => imported(await window.api.openReplays(), 0)}>
          Add replay…
        </button>
        <button type="button" onClick={() => void window.api.rescan()} disabled={scan.running}>
          Rescan
        </button>
        <button type="button" onClick={onOpenSettings}>
          Settings
        </button>
      </header>
      {importMsg && (
        <div className="warn-box toast" onClick={() => setImportMsg(null)}>
          {importMsg}
        </div>
      )}
      <div className="library-body">
        <div className="table-wrap">
          <table className="replays">
            <thead>
              <tr>
                <th className="col-fav">★</th>
                {header('date', 'Date')}
                {header('map', 'Map')}
                {header('players', 'Players')}
                {header('mode', 'Mode')}
                {header('duration', 'Duration')}
                <th>Winner</th>
                {header('sim', 'Simulation')}
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
                  <td>
                    <MapCell r={r} />
                  </td>
                  <td
                    className="players-cell"
                    onMouseMove={(e) => r.players.length > 0 && setRoster({ r, x: e.clientX, y: e.clientY })}
                    onMouseLeave={() => setRoster(null)}
                  >
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
            <div className="empty">
              {replays.length === 0
                ? 'No replays found in the replay folders. Drop .sdfz files here or use "Add replay…".'
                : 'No replays match the filters.'}
            </div>
          )}
        </div>
        {selected !== null && <DetailPanel id={selected} onChanged={reload} onClose={() => setSelected(null)} onOpenPlayer={onOpenPlayer} />}
      </div>
    </div>
  )
}
