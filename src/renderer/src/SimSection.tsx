import { useEffect, useState } from 'react'
import { isResumedGame } from '@shared/sim-status'
import type { JobInfo, ReplayDetail } from '@shared/types'
import { formatDuration } from './format'

const STAGE_LABEL = {
  deps: 'Preparing engine, game and map…',
  loading: 'Engine loading…',
  simulating: 'Simulating',
  finalizing: 'Saving recording…'
} as const

function elapsed(job: JobInfo): string {
  if (!job.startedAt) return ''
  return formatDuration((job.finishedAt ?? Date.now()) - job.startedAt)
}

export function SimSection({ replay, onChanged }: { replay: ReplayDetail; onChanged(): void }): React.JSX.Element {
  const [job, setJob] = useState<JobInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [, tick] = useState(0)

  useEffect(() => {
    let alive = true
    void window.api.getJob(replay.id).then((j) => alive && setJob(j))
    const off = window.api.onJobUpdate((j) => {
      if (j.replayId === replay.id) setJob(j)
    })
    const t = setInterval(() => tick((n) => n + 1), 1000) // elapsed time
    return () => {
      alive = false
      off()
      clearInterval(t)
    }
  }, [replay.id])

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try {
      await fn()
      setJob(await window.api.getJob(replay.id))
      onChanged()
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  const active = job?.status === 'queued' || job?.status === 'running'
  const resumed = isResumedGame(replay)
  const canSimulate = replay.lastFrame >= 0 && !replay.parseError && !active && !resumed
  const progress = job && job.totalFrames ? Math.min(1, job.frame / job.totalFrames) : 0

  return (
    <div className="sim">
      <div className="actions">
        {canSimulate && (
          <button type="button" className="primary" onClick={() => act(() => window.api.simulate(replay.id))}>
            {job?.status === 'done' ? 'Re-simulate' : job?.status === 'failed' ? 'Retry simulation' : 'Simulate'}
          </button>
        )}
        {active && (
          <button type="button" onClick={() => act(() => window.api.cancelSim(replay.id))}>
            Cancel
          </button>
        )}
        <button type="button" disabled title="Coming in milestone 5">
          Open player
        </button>
        <button type="button" onClick={() => void window.api.showInFolder(replay.path)}>
          Show in folder
        </button>
        {job && !active && (job.status === 'done' || job.status === 'failed') && (
          <button type="button" className="danger" onClick={() => act(() => window.api.deleteSimData(replay.id))}>
            Delete simulated data
          </button>
        )}
      </div>

      {resumed && (
        <div className="warn-box">
          This replay continues a saved game (it starts at {formatDuration((replay.firstFrame / 30) * 1000)}). The saved
          game state isn't stored in the replay, so it can't be re-simulated.
        </div>
      )}
      {error && <div className="error-box">{error}</div>}

      {job?.status === 'queued' && <div className="sim-status muted">Queued: waiting for a free simulation slot.</div>}

      {job?.status === 'running' && (
        <div className="sim-status">
          <div className="sim-line">
            <span>
              {job.stage ? STAGE_LABEL[job.stage] : 'Starting…'}
              {job.stage === 'simulating' && ` ${Math.round(progress * 100)}%`}
            </span>
            <span className="muted small">
              {job.stage === 'simulating' && `frame ${job.frame} / ${job.totalFrames} · `}
              {elapsed(job)}
            </span>
          </div>
          <div className={'bar' + (job.stage === 'simulating' ? '' : ' indeterminate')}>
            <div style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
      )}

      {job?.status === 'done' && (
        <div className="sim-status">
          <span className="ok">✓ Simulated</span>{' '}
          <span className="muted small">
            in {elapsed(job)} · {job.endReason === 'gameover' ? 'ended with game over' : job.endReason === 'endofdemo' ? 'replay ended before game over' : job.endReason}
          </span>
        </div>
      )}

      {job?.warning && <div className="warn-box">{job.warning}</div>}

      {job?.status === 'failed' && (
        <div className="error-box">
          <div>Simulation failed: {job.error}</div>
          {job.logTail && (
            <details>
              <summary>Engine log (last lines)</summary>
              <pre className="log">{job.logTail}</pre>
            </details>
          )}
          {job.workDir && (
            <button type="button" className="link" onClick={() => void window.api.showInFolder(job.workDir + '\\infolog.txt')}>
              Open engine work folder
            </button>
          )}
        </div>
      )}
    </div>
  )
}
