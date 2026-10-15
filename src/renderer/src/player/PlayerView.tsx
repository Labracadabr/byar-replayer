import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EVENT_DEATH, type StreamHeader, type StreamMeta } from '@shared/stream/format'
import { interpolate, projectilesAt, samplePair, type UnitView } from '@shared/stream/interpolate'
import { formatDuration } from '../format'
import { type DeathFlash, PlayerStage } from './stage'
import { StreamClient } from './stream-client'

const FPS = 30
const SPEEDS = [1, 2, 4, 8, 16, 32, 64]
const FLASH_FRAMES = 45

function clock(frame: number): string {
  return formatDuration(Math.max(0, (frame / FPS) * 1000)).replace(/^–$/, '0:00')
}

interface Props {
  replayId: number
  title: string
  onClose(): void
}

interface Hover {
  uid: number
  x: number
  y: number
}

export function PlayerView({ replayId, title, onClose }: Props): React.JSX.Element {
  const canvasHost = useRef<HTMLDivElement>(null)
  const [data, setData] = useState<{ header: StreamHeader; meta: StreamMeta } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [frame, setFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(8)
  const [hpBars, setHpBars] = useState(true)
  const [overlays, setOverlays] = useState({ height: false, metal: false })
  const [overlayMissing, setOverlayMissing] = useState<string | null>(null)
  const [loadingChunk, setLoadingChunk] = useState(false)
  const [hover, setHover] = useState<Hover | null>(null)

  // playback state lives in refs so the render loop doesn't depend on React renders
  const frameRef = useRef(0)
  const playingRef = useRef(false)
  const speedRef = useRef(8)
  const hpBarsRef = useRef(true)
  const hoverRef = useRef<Hover | null>(null)
  const unitsRef = useRef<UnitView[]>([])
  const countRef = useRef(0)
  const clientRef = useRef<StreamClient | null>(null)
  const stageRef = useRef<PlayerStage | null>(null)

  playingRef.current = playing
  speedRef.current = speed
  hpBarsRef.current = hpBars
  hoverRef.current = hover

  const seek = useCallback((f: number) => {
    const h = clientRef.current?.header
    if (!h) return
    frameRef.current = Math.max(h.firstFrame, Math.min(h.lastFrame, f))
    setFrame(frameRef.current)
  }, [])

  const toggleOverlay = useCallback((kind: 'height' | 'metal') => {
    setOverlays((cur) => {
      const next = { ...cur, [kind]: !cur[kind] }
      void stageRef.current?.setMapOverlay(kind, next[kind]).then((ok) => {
        if (!ok) {
          setOverlayMissing(`The ${kind} map isn't available (map file not found).`)
          setOverlays((c) => ({ ...c, [kind]: false }))
        }
      })
      return next
    })
  }, [])

  // open the stream + set up the stage
  useEffect(() => {
    const client = new StreamClient()
    clientRef.current = client
    let stage: PlayerStage | null = null
    let disposed = false
    client
      .open(`brv://stream/${replayId}`)
      .then(async ({ header, meta }) => {
        if (disposed) return
        stage = new PlayerStage(canvasHost.current!, header, meta)
        stageRef.current = stage
        await stage.init(`brv://minimap/${replayId}`, `brv://overlay/${replayId}`)
        frameRef.current = header.firstFrame
        setData({ header, meta })
        void client.load(0)
      })
      .catch((e: Error) => setError(e.message))
    return () => {
      disposed = true
      stage?.destroy()
      client.dispose()
      stageRef.current = null
      clientRef.current = null
    }
  }, [replayId])

  // deaths sorted by frame for the flash effect
  const deaths = useMemo(() => {
    if (!data) return [] as { frame: number; x: number; z: number; team: number; big: boolean }[]
    return data.meta.events
      .filter((e) => e[1] === EVENT_DEATH && e[6] >= 0)
      .map((e) => {
        const kind = data.meta.unitDefs[e[3]]?.kind
        return { frame: e[0], x: e[6], z: e[7], team: e[4], big: kind === 'building' || kind === 'commander' }
      })
  }, [data])

  // render loop
  useEffect(() => {
    if (!data) return
    const { header } = data
    const client = clientRef.current!
    let raf = 0
    let last = performance.now()
    let lastUi = 0
    const flashes: DeathFlash[] = []
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick)
      const dt = Math.min(250, now - last)
      last = now
      const idx = client.chunkIndexFor(frameRef.current)
      const chunk = client.get(idx)
      if (!chunk) {
        void client.load(idx)
        setLoadingChunk(true)
        return // hold the frame until the chunk is decoded
      }
      if (playingRef.current) {
        frameRef.current += (dt / 1000) * FPS * speedRef.current
        if (frameRef.current >= header.lastFrame) {
          frameRef.current = header.lastFrame
          setPlaying(false)
        }
      }
      const f = frameRef.current
      const ci = client.chunkIndexFor(f)
      const cur = client.get(ci)
      if (!cur) return
      const next = client.get(ci + 1)
      if (!next) client.prefetch(ci + 1)
      const pair = samplePair(cur, next, f)
      const n = pair ? interpolate(pair, unitsRef.current) : 0
      countRef.current = n
      const proj = projectilesAt(cur, client.get(ci - 1), f, header.projectileInterval * 2)
      // death flashes in the last FLASH_FRAMES frames
      flashes.length = 0
      let lo = 0
      let hi = deaths.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (deaths[mid].frame < f - FLASH_FRAMES) lo = mid + 1
        else hi = mid
      }
      for (let i = lo; i < deaths.length && deaths[i].frame <= f; i++) {
        const d = deaths[i]
        flashes.push({ x: d.x, z: d.z, team: d.team, big: d.big, age: f - d.frame })
      }
      stageRef.current?.render(unitsRef.current, n, proj, proj ? f - proj.frame : 0, flashes, {
        hpBars: hpBarsRef.current,
        hoveredUid: hoverRef.current?.uid ?? -1
      })
      if (now - lastUi > 100) {
        lastUi = now
        setFrame(f)
        setLoadingChunk(false)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [data, deaths])

  // keyboard shortcuts
  useEffect(() => {
    if (!data) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const step = data.header.sampleInterval
      switch (e.key) {
        case ' ':
          e.preventDefault()
          if (frameRef.current >= data.header.lastFrame) seek(data.header.firstFrame)
          setPlaying((p) => !p)
          break
        case 'ArrowLeft':
          e.preventDefault()
          seek(frameRef.current - (e.shiftKey ? 60 : 10) * FPS)
          break
        case 'ArrowRight':
          e.preventDefault()
          seek(frameRef.current + (e.shiftKey ? 60 : 10) * FPS)
          break
        case ',':
          setPlaying(false)
          seek(frameRef.current - step)
          break
        case '.':
          setPlaying(false)
          seek(frameRef.current + step)
          break
        case '+':
        case '=':
          setSpeed((s) => SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(s) + 1)])
          break
        case '-':
          setSpeed((s) => SPEEDS[Math.max(0, SPEEDS.indexOf(s) - 1)])
          break
        case 'Home':
          seek(data.header.firstFrame)
          break
        case 'End':
          seek(data.header.lastFrame)
          break
        case 'h':
          setHpBars((v) => !v)
          break
        case 'f':
          stageRef.current?.fit()
          break
        case 't':
          toggleOverlay('height')
          break
        case 'm':
          toggleOverlay('metal')
          break
        case 'Escape':
          onClose()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [data, seek, onClose, toggleOverlay])

  // per-bucket death counts: where the fights are
  const fights = useMemo(() => {
    if (!data) return [] as number[]
    const { firstFrame, lastFrame } = data.header
    const buckets = new Array<number>(200).fill(0)
    const span = Math.max(1, lastFrame - firstFrame)
    for (const d of deaths) {
      const i = Math.min(199, Math.floor(((d.frame - firstFrame) / span) * 200))
      if (i >= 0) buckets[i]++
    }
    // log scale: the end-of-game mass destruction would otherwise flatten every real fight
    const max = Math.log1p(Math.max(1, ...buckets))
    return buckets.map((b) => Math.log1p(b) / max)
  }, [data, deaths])

  const onMouseMove = (e: React.MouseEvent): void => {
    const r = canvasHost.current!.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    const uid = stageRef.current?.pick(x, y) ?? -1
    setHover(uid >= 0 ? { uid, x, y } : null)
  }

  if (error)
    return (
      <div className="player-view">
        <PlayerTop title={title} onClose={onClose} />
        <div className="player-error error-box">Could not open the recording: {error}</div>
      </div>
    )

  const header = data?.header
  const meta = data?.meta
  const hoveredUnit = hover ? unitsRef.current.slice(0, countRef.current).find((u) => u.uid === hover.uid) : undefined

  return (
    <div className="player-view">
      <PlayerTop title={title} onClose={onClose} />
      <div className="player-main">
        <div className="player-canvas" ref={canvasHost} onMouseMove={onMouseMove} onMouseLeave={() => setHover(null)}>
          {!data && <div className="player-loading">Loading recording…</div>}
          {loadingChunk && <div className="player-chunk-loading">Loading…</div>}
          {overlayMissing && (
            <div className="player-chunk-loading warn" onClick={() => setOverlayMissing(null)}>
              {overlayMissing}
            </div>
          )}
          {hoveredUnit && meta && hover && <Tooltip unit={hoveredUnit} meta={meta} x={hover.x} y={hover.y} />}
        </div>
        {meta && header && <SidePanel meta={meta} frame={frame} onSeek={seek} />}
      </div>
      {header && (
        <Timeline
          header={header}
          frame={frame}
          playing={playing}
          speed={speed}
          hpBars={hpBars}
          overlays={overlays}
          fights={fights}
          onOverlay={toggleOverlay}
          onPlay={() => {
            if (frameRef.current >= header.lastFrame) seek(header.firstFrame)
            setPlaying(!playing)
          }}
          onSeek={seek}
          onSpeed={setSpeed}
          onHpBars={setHpBars}
          onStep={(d) => {
            setPlaying(false)
            seek(frameRef.current + d * header.sampleInterval)
          }}
        />
      )}
    </div>
  )
}

function PlayerTop({ title, onClose }: { title: string; onClose(): void }): React.JSX.Element {
  return (
    <header className="player-top">
      <button type="button" onClick={onClose}>
        ← Library
      </button>
      <span className="player-title">{title}</span>
      <span className="muted small">
        Space play/pause · ←/→ ±10 s (Shift ±60 s) · , . step · +/− speed · H HP bars · T height · M metal · F fit
      </span>
    </header>
  )
}

function Tooltip({ unit, meta, x, y }: { unit: UnitView; meta: StreamMeta; x: number; y: number }): React.JSX.Element {
  const def = meta.unitDefs[unit.def]
  const team = meta.teams.find((t) => t.teamId === unit.team)
  return (
    <div className="unit-tooltip" style={{ left: x + 14, top: y + 14 }}>
      <div className="tt-name">{def?.humanName ?? `Unit ${unit.def}`}</div>
      <div className="muted small">{def?.name}</div>
      <div>
        HP {Math.round(unit.hp * (def?.health ?? 0))} / {def?.health ?? '?'}
        {unit.build < 1 && ` · building ${Math.round(unit.build * 100)}%`}
      </div>
      <div>
        <span className="pdot" style={{ background: team?.color }} />
        {team?.name ?? `Team ${unit.team}`}
      </div>
    </div>
  )
}

function Timeline(props: {
  header: StreamHeader
  frame: number
  playing: boolean
  speed: number
  hpBars: boolean
  overlays: { height: boolean; metal: boolean }
  fights: number[]
  onOverlay(kind: 'height' | 'metal'): void
  onPlay(): void
  onSeek(f: number): void
  onSpeed(s: number): void
  onHpBars(v: boolean): void
  onStep(dir: number): void
}): React.JSX.Element {
  const { header: h, frame } = props
  return (
    <footer className="timeline">
      <button type="button" onClick={() => props.onStep(-1)} title="Step back (,)">
        ⏮
      </button>
      <button type="button" className="play" onClick={props.onPlay} title="Play/pause (Space)">
        {props.playing ? '❚❚' : '▶'}
      </button>
      <button type="button" onClick={() => props.onStep(1)} title="Step forward (.)">
        ⏭
      </button>
      <span className="time mono">
        {clock(frame)} / {clock(h.lastFrame)}
      </span>
      <div className="scrubber-wrap">
        <div
          className="fights"
          title="Unit deaths over time: click to jump"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            props.onSeek(h.firstFrame + ((e.clientX - r.left) / r.width) * (h.lastFrame - h.firstFrame))
          }}
        >
          {props.fights.map((v, i) => (
            <span key={i} style={{ height: `${Math.round(v * 100)}%` }} />
          ))}
        </div>
        <input
          className="scrubber"
          type="range"
          min={h.firstFrame}
          max={h.lastFrame}
          step={1}
          value={Math.round(frame)}
          onChange={(e) => props.onSeek(Number(e.target.value))}
        />
      </div>
      <div className="speeds">
        {SPEEDS.map((s) => (
          <button type="button" key={s} className={s === props.speed ? 'on' : ''} onClick={() => props.onSpeed(s)}>
            {s}×
          </button>
        ))}
      </div>
      <label className="check small">
        <input type="checkbox" checked={props.hpBars} onChange={(e) => props.onHpBars(e.target.checked)} />
        HP bars
      </label>
      <label className="check small" title="Shaded height map (T)">
        <input type="checkbox" checked={props.overlays.height} onChange={() => props.onOverlay('height')} />
        Height
      </label>
      <label className="check small" title="Metal spots (M)">
        <input type="checkbox" checked={props.overlays.metal} onChange={() => props.onOverlay('metal')} />
        Metal
      </label>
    </footer>
  )
}

function SidePanel({ meta, frame, onSeek }: { meta: StreamMeta; frame: number; onSeek(f: number): void }): React.JSX.Element {
  const statIdx = Math.floor(frame / meta.stats.interval)
  const allies = new Map<number, typeof meta.teams>()
  for (const t of meta.teams) {
    if (t.isGaia) continue
    if (!allies.has(t.allyTeam)) allies.set(t.allyTeam, [])
    allies.get(t.allyTeam)!.push(t)
  }
  const chat = meta.chat.filter((c) => c.frame <= frame)
  const chatEnd = useRef<HTMLDivElement>(null)
  // block body: scrollIntoView returns a Promise in current Chromium, which React would treat as a cleanup
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: 'end' })
  }, [chat.length])
  const stat = (teamId: number, key: 'units' | 'army'): number => {
    const arr = meta.stats.teams[teamId]?.[key]
    if (!arr || arr.length === 0) return 0
    return arr[Math.min(arr.length - 1, statIdx)] ?? 0
  }
  return (
    <aside className="player-side">
      <section className="side-players">
        <h3>Players</h3>
        <div className="side-head muted small">
          <span />
          <span>units</span>
          <span>army</span>
        </div>
        {[...allies.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([ally, teams]) => (
            <div key={ally} className={'side-ally' + (meta.winners.includes(ally) ? ' winner' : '')}>
              <div className="ally-title small">
                Team {ally + 1}
                {meta.winners.includes(ally) && <span className="badge win">Winner</span>}
              </div>
              {teams.map((t) => (
                <div key={t.teamId} className="side-row">
                  <span className="side-name">
                    <span className="pdot" style={{ background: t.color }} />
                    {t.name}
                  </span>
                  <span className="mono">{stat(t.teamId, 'units')}</span>
                  <span className="mono">{Math.round(stat(t.teamId, 'army') / 1000)}k</span>
                </div>
              ))}
            </div>
          ))}
      </section>
      <section className="side-chat">
        <h3>Chat</h3>
        <div className="chat-list">
          {chat.length === 0 && <div className="muted small">No messages yet.</div>}
          {chat.map((c, i) => (
            <div key={i} className={`chat-line chat-${c.type}`} onClick={() => onSeek(c.frame)} title="Jump here">
              <span className="muted mono small">{clock(c.frame)}</span> <b>{c.name || 'Host'}</b>
              {c.type === 'ally' && <span className="muted small"> (allies)</span>}
              {c.type === 'spec' && <span className="muted small"> (spec)</span>}: {c.message}
            </div>
          ))}
          <div ref={chatEnd} />
        </div>
      </section>
    </aside>
  )
}
