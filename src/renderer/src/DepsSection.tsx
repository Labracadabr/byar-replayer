import { useCallback, useEffect, useState } from 'react'
import type { DepState, ReplayDeps } from '@shared/types'

const KIND_LABEL = { engine: 'Engine', game: 'Game', map: 'Map' } as const

const STATUS_ICON: Record<DepState['status'], string> = {
  ok: '✓',
  missing: '↓',
  downloading: '…',
  failed: '✕',
  unavailable: '✕'
}

function DepRow({ d }: { d: DepState }): React.JSX.Element {
  return (
    <div className={`dep dep-${d.status}`}>
      <span className="dep-icon">{STATUS_ICON[d.status]}</span>
      <div className="dep-body">
        <div>
          <span className="dep-kind">{KIND_LABEL[d.kind]}</span> {d.name}
        </div>
        {d.status === 'ok' && d.path && <div className="muted small mono">{d.path}</div>}
        {d.status !== 'ok' && d.message && <div className="small dep-msg">{d.message}</div>}
        {d.status === 'downloading' && (
          <div className={'bar' + ((d.progress ?? -1) < 0 ? ' indeterminate' : '')}>
            <div style={{ width: `${Math.max(0, d.progress ?? 0) * 100}%` }} />
          </div>
        )}
      </div>
    </div>
  )
}

export function DepsSection({ replayId }: { replayId: number }): React.JSX.Element {
  const [deps, setDeps] = useState<ReplayDeps | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    window.api
      .checkDeps(replayId)
      .then((d) => {
        setDeps(d)
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
  }, [replayId])

  useEffect(() => {
    refresh()
    return window.api.onDepProgress((st) =>
      setDeps((cur) => {
        if (!cur || cur[st.kind].name !== st.name) return cur
        return { ...cur, [st.kind]: st }
      })
    )
  }, [refresh])

  if (error) return <div className="error-box">{error}</div>
  if (!deps) return <div className="muted">Checking…</div>

  const list = [deps.engine, deps.game, deps.map]
  const needsDownload = list.some((d) => d.status === 'missing' || d.status === 'failed')
  const mapMissing = deps.map.status !== 'ok'

  const download = async (): Promise<void> => {
    setBusy(true)
    try {
      setDeps(await window.api.ensureDeps(replayId))
    } finally {
      setBusy(false)
    }
  }

  const addMapFolder = async (): Promise<void> => {
    if (await window.api.addMapFolder()) refresh()
  }

  return (
    <div className="deps">
      {list.map((d) => (
        <DepRow key={d.kind} d={d} />
      ))}
      {(needsDownload || mapMissing) && (
        <div className="actions">
          {needsDownload && (
            <button type="button" onClick={download} disabled={busy}>
              {busy ? 'Downloading…' : 'Download missing'}
            </button>
          )}
          {mapMissing && (
            <button type="button" onClick={addMapFolder} disabled={busy}>
              Add map folder…
            </button>
          )}
        </div>
      )}
    </div>
  )
}
