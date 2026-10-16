import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EVENT_DEATH, type StreamHeader, type StreamMeta } from '@shared/stream/format'
import { interpolate, projectilesAt, samplePair, type UnitView } from '@shared/stream/interpolate'
import type { MapMarker, ReplayDetail } from '@shared/types'
import { formatDuration } from '../format'
import { RankIcon } from '../RosterTooltip'
import { type DeathFlash, type MarkView, PlayerStage, WORK_COLORS } from './stage'
import { buildMarks } from './marks'
import { StreamClient } from './stream-client'

const FPS = 30
const SPEEDS = [1, 2, 4, 8, 16, 32, 64]
const FLASH_FRAMES = 45
/** consecutive line segments by one player within this many frames are one "drawing" in the chat feed */
const DRAWING_GAP = 90
const SPEC_COLOR = '#c8ccd4'
const WORK_LABEL: Record<number, string> = { 1: 'Building', 2: 'Repairing', 3: 'Reclaiming', 4: 'Resurrecting', 5: 'Capturing' }

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

/** One line in the side panel feed: chat message, ping/marker, or a drawing. */
interface FeedItem {
  frame: number
  playerId: number
  name: string
  kind: 'chat' | 'ping' | 'drawing'
  type?: 'ally' | 'spec' | 'global' | 'self'
  text: string
  x?: number
  z?: number
}

export function PlayerView({ replayId, title, onClose }: Props): React.JSX.Element {
  const canvasHost = useRef<HTMLDivElement>(null)
  const [data, setData] = useState<{ header: StreamHeader; meta: StreamMeta } | null>(null)
  const [replay, setReplay] = useState<ReplayDetail | null>(null)
  const [markers, setMarkers] = useState<MapMarker[] | null>(null)
  const [timelineChat, setTimelineChat] = useState<FeedItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [frame, setFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(8)
  const [hpBars, setHpBars] = useState(true)
  const [buildLines, setBuildLines] = useState(true)
  const [iconScale, setIconScale] = useState(1)
  const [overlays, setOverlays] = useState({ height: false, metal: false })
  const [overlayMissing, setOverlayMissing] = useState<string | null>(null)
  const [loadingChunk, setLoadingChunk] = useState(false)
  const [hover, setHover] = useState<Hover | null>(null)

  // playback state lives in refs so the render loop doesn't depend on React renders
  const frameRef = useRef(0)
  const playingRef = useRef(false)
  const speedRef = useRef(8)
  const optsRef = useRef({ hpBars: true, buildLines: true, iconScale: 1, hoveredUid: -1 })
  const unitsRef = useRef<UnitView[]>([])
  const countRef = useRef(0)
  const clientRef = useRef<StreamClient | null>(null)
  const stageRef = useRef<PlayerStage | null>(null)

  playingRef.current = playing
  speedRef.current = speed
  optsRef.current = { hpBars, buildLines, iconScale, hoveredUid: hover?.uid ?? -1 }

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
        await stage.init(`brv://minimap/${replayId}`, `brv://overlay/${replayId}`, `brv://game/${replayId}`)
        frameRef.current = header.firstFrame
        setData({ header, meta })
        void client.load(0)
      })
      .catch((e: Error) => setError(e.message))
    // players (colors, ranks) and the chat/ping timeline come from the replay itself
    void window.api.getReplay(replayId).then((r) => !disposed && setReplay(r))
    void window.api
      .getTimeline(replayId)
      .then((t) => {
        if (disposed) return
        setMarkers(t.markers)
        setTimelineChat(
          t.chat.map((c) => ({ frame: c.frame, playerId: c.playerId, name: c.name, kind: 'chat', type: c.type, text: c.message }))
        )
      })
      .catch(() => !disposed && setMarkers([])) // demo file gone: chat falls back to the recording, no pings
    return () => {
      disposed = true
      stage?.destroy()
      client.dispose()
      stageRef.current = null
      clientRef.current = null
    }
  }, [replayId])

  // player id -> color / name / rank
  const players = useMemo(() => {
    const byId = new Map<number, { name: string; color: string; teamId: number; rank?: number }>()
    for (const p of replay?.players ?? []) if (p.playerId >= 0) byId.set(p.playerId, { name: p.name, color: p.color, teamId: p.teamId, rank: p.rank })
    return byId
  }, [replay])
  const playerColor = useCallback((id: number): string => players.get(id)?.color ?? SPEC_COLOR, [players])

  const marks = useMemo(() => buildMarks(markers ?? []), [markers])
  const markColors = useMemo(() => marks.map((m) => parseInt(playerColor(m.playerId).slice(1), 16)), [marks, playerColor])

  // chat + pings + drawings, sorted by frame
  const feed = useMemo((): FeedItem[] => {
    const chat: FeedItem[] =
      timelineChat ??
      (data?.meta.chat ?? []).map((c) => ({ frame: c.frame, playerId: c.playerId, name: c.name, kind: 'chat', type: c.type, text: c.message }))
    const items = [...chat]
    let lastDraw: { playerId: number; frame: number; item: FeedItem } | null = null
    for (const m of markers ?? []) {
      const name = players.get(m.playerId)?.name ?? `Player ${m.playerId}`
      if (m.kind === 'point') {
        items.push({ frame: m.frame, playerId: m.playerId, name, kind: 'ping', text: m.label || 'ping', x: m.x, z: m.z })
      } else if (m.kind === 'line') {
        if (lastDraw && lastDraw.playerId === m.playerId && m.frame - lastDraw.frame <= DRAWING_GAP) lastDraw.frame = m.frame
        else {
          const item: FeedItem = { frame: m.frame, playerId: m.playerId, name, kind: 'drawing', text: 'drew on the map', x: m.x, z: m.z }
          items.push(item)
          lastDraw = { playerId: m.playerId, frame: m.frame, item }
        }
      }
    }
    return items.sort((a, b) => a.frame - b.frame)
  }, [timelineChat, data, markers, players])

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
    const markViews: MarkView[] = []
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
      // map marks placed and not yet erased
      markViews.length = 0
      for (let i = 0; i < marks.length; i++) {
        const m = marks[i]
        if (m.frame > f || f >= m.erasedAt) continue
        markViews.push({
          id: m.id,
          kind: m.kind === 'line' ? 'line' : 'point',
          x: m.x,
          z: m.z,
          x2: m.x2,
          z2: m.z2,
          label: m.label,
          color: markColors[i],
          age: f - m.frame
        })
      }
      stageRef.current?.render(unitsRef.current, n, proj, proj ? f - proj.frame : 0, flashes, markViews, optsRef.current)
      if (now - lastUi > 100) {
        lastUi = now
        setFrame(f)
        setLoadingChunk(false)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [data, deaths, marks, markColors])

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
        case 'b':
          setBuildLines((v) => !v)
          break
        case '[':
          setIconScale((s) => Math.max(0.5, Math.round((s - 0.1) * 10) / 10))
          break
        case ']':
          setIconScale((s) => Math.min(2.5, Math.round((s + 0.1) * 10) / 10))
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

  const jumpTo = useCallback(
    (item: FeedItem) => {
      seek(item.frame)
      if (item.x !== undefined && item.z !== undefined) stageRef.current?.centerOn(item.x, item.z)
    },
    [seek]
  )

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
        {meta && header && (
          <SidePanel
            meta={meta}
            replay={replay}
            replayId={replayId}
            frame={frame}
            feed={feed}
            playerColor={playerColor}
            onJump={jumpTo}
          />
        )}
      </div>
      {header && (
        <Timeline
          header={header}
          frame={frame}
          playing={playing}
          speed={speed}
          hpBars={hpBars}
          buildLines={buildLines}
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
          onBuildLines={setBuildLines}
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
        Space play/pause · ←/→ ±10 s (Shift ±60 s) · , . step · +/− speed · H HP bars · B build power · [ ] icon size · T
        height · M metal · F fit
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
      {unit.work > 0 && (
        <div style={{ color: '#' + (WORK_COLORS[unit.work] ?? 0xffffff).toString(16).padStart(6, '0') }}>{WORK_LABEL[unit.work]}</div>
      )}
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
  buildLines: boolean
  overlays: { height: boolean; metal: boolean }
  fights: number[]
  onOverlay(kind: 'height' | 'metal'): void
  onPlay(): void
  onSeek(f: number): void
  onSpeed(s: number): void
  onHpBars(v: boolean): void
  onBuildLines(v: boolean): void
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
      <label className="check small" title="Lines from builders to what they build, repair, reclaim or resurrect (B)">
        <input type="checkbox" checked={props.buildLines} onChange={(e) => props.onBuildLines(e.target.checked)} />
        Build power
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

function SidePanel(props: {
  meta: StreamMeta
  replay: ReplayDetail | null
  replayId: number
  frame: number
  feed: FeedItem[]
  playerColor(id: number): string
  onJump(item: FeedItem): void
}): React.JSX.Element {
  const { meta, replay, frame, feed } = props
  const statIdx = Math.floor(frame / meta.stats.interval)
  const allies = new Map<number, typeof meta.teams>()
  for (const t of meta.teams) {
    if (t.isGaia) continue
    if (!allies.has(t.allyTeam)) allies.set(t.allyTeam, [])
    allies.get(t.allyTeam)!.push(t)
  }
  // team -> human player (for the rank chevron)
  const rankOf = new Map<number, number | undefined>()
  for (const p of replay?.players ?? []) if (!p.isAI) rankOf.set(p.teamId, p.rank)
  let shown = 0
  while (shown < feed.length && feed[shown].frame <= frame) shown++
  const chatEnd = useRef<HTMLDivElement>(null)
  // block body: scrollIntoView returns a Promise in current Chromium, which React would treat as a cleanup
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: 'end' })
  }, [shown])
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
                    {t.isAI ? <span className="rank-icon" /> : <RankIcon replayId={props.replayId} rank={rankOf.get(t.teamId)} />}
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
          {shown === 0 && <div className="muted small">No messages yet.</div>}
          {feed.slice(0, shown).map((c, i) => {
            const color = c.name ? props.playerColor(c.playerId) : SPEC_COLOR
            return (
              <div
                key={i}
                className={`chat-line chat-${c.kind}${c.type ? ` chat-${c.type}` : ''}`}
                onClick={() => props.onJump(c)}
                title={c.kind === 'chat' ? 'Jump here' : 'Jump here and show it on the map'}
              >
                <span className="muted mono small">{clock(c.frame)}</span>{' '}
                <b style={{ color }}>{c.name || 'Host'}</b>
                {c.kind === 'chat' && c.type === 'ally' && <span className="muted small"> (allies)</span>}
                {c.kind === 'chat' && c.type === 'spec' && <span className="muted small"> (spec)</span>}
                {c.kind === 'chat' ? (
                  <>: {c.text}</>
                ) : c.kind === 'ping' ? (
                  <span className="chat-ping">
                    {' '}
                    📍 {c.text === 'ping' ? 'pinged the map' : <>marked “{c.text}”</>}
                  </span>
                ) : (
                  <span className="chat-ping"> ✎ {c.text}</span>
                )}
              </div>
            )
          })}
          <div ref={chatEnd} />
        </div>
      </section>
    </aside>
  )
}
