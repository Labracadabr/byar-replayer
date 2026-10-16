// PixiJS scene for the player. World coordinates are elmos (x right, z down). Layers, bottom to top:
// map (+ height/metal overlays) · build power lines · buildings · units · projectiles · HP bars/flashes · map marks.
// Units use the game's own strategic icons (team-tinted, like in game); simple shapes stand in until they load.
import 'pixi.js/unsafe-eval' // no eval under the app's CSP
import { Application, Container, Graphics, Sprite, Text, type Texture } from 'pixi.js'
import {
  type ProjectileSample,
  type StreamHeader,
  type StreamMeta,
  type UnitKind,
  WORK_BUILD,
  WORK_CAPTURE,
  WORK_RECLAIM,
  WORK_REPAIR,
  WORK_RESURRECT
} from '@shared/stream/format'
import type { UnitView } from '@shared/stream/interpolate'

export interface DeathFlash {
  x: number
  z: number
  age: number // frames since death
  team: number
  big: boolean
}

/** A map mark to draw this frame (already filtered for visibility / erasure). */
export interface MarkView {
  id: number
  kind: 'point' | 'line'
  x: number
  z: number
  x2?: number
  z2?: number
  label?: string
  color: number
  age: number // frames since placed
}

export interface RenderOptions {
  hpBars: boolean
  buildLines: boolean
  hoveredUid: number
  /** icon size multiplier (user setting) */
  iconScale: number
}

/** On-screen size of a size-1 icon, in CSS pixels */
const ICON_PX = 16
const FLASH_FRAMES = 45
const PING_PULSE_FRAMES = 90
/** v2 recordings made before the build-range check include tasks of builders still on their way: hide those */
const MAX_WORK_LINE = 900

export const WORK_COLORS: Record<number, number> = {
  [WORK_BUILD]: 0x58e070,
  [WORK_REPAIR]: 0x6ad0ff,
  [WORK_RECLAIM]: 0xff9a3c,
  [WORK_RESURRECT]: 0xb08cff,
  [WORK_CAPTURE]: 0xffe066
}

type ProjKind = 'dot' | 'laser' | 'beam' | 'lightning' | 'missile' | 'torpedo' | 'bomb' | 'flame' | 'dgun'

interface ProjStyle {
  kind: ProjKind
  color: number
  /** world size for dots */
  size: number
}

const PROJ_DEFAULT_COLOR: Record<ProjKind, number> = {
  dot: 0xffd27a,
  laser: 0xff5a5a,
  beam: 0xff6a4a,
  lightning: 0xb9d8ff,
  missile: 0xf0f0f0,
  torpedo: 0x9fb3c8,
  bomb: 0x3a3a3a,
  flame: 0xff8a2a,
  dgun: 0xff7a20
}

function projKind(type: string): ProjKind {
  switch (type) {
    case 'LaserCannon':
      return 'laser'
    case 'BeamLaser':
      return 'beam'
    case 'LightningCannon':
      return 'lightning'
    case 'MissileLauncher':
    case 'StarburstLauncher':
      return 'missile'
    case 'TorpedoLauncher':
      return 'torpedo'
    case 'AircraftBomb':
      return 'bomb'
    case 'Flame':
      return 'flame'
    case 'DGun':
      return 'dgun'
    default:
      return 'dot'
  }
}

function colorNum(hex: string | undefined): number | undefined {
  if (!hex) return undefined
  const n = parseInt(hex.slice(1), 16)
  return Number.isNaN(n) ? undefined : n
}

function brighten(c: number, amount = 90): number {
  const r = Math.min(255, ((c >> 16) & 255) + amount)
  const g = Math.min(255, ((c >> 8) & 255) + amount)
  const b = Math.min(255, (c & 255) + amount)
  return (r << 16) | (g << 8) | b
}

/** Cheap deterministic noise for lightning jitter */
function hash(n: number): number {
  const s = Math.sin(n * 12.9898) * 43758.5453
  return s - Math.floor(s) - 0.5
}

export class PlayerStage {
  app = new Application()
  private world = new Container()
  private mapLayer = new Container()
  private workGfx = new Graphics()
  private buildingLayer = new Container()
  private unitLayer = new Container()
  private projGfx = new Graphics()
  private projLayer = new Container()
  private overlay = new Graphics()
  private markGfx = new Graphics()
  private markLabels = new Container()
  private mapOverlays = new Map<'height' | 'metal', Sprite | 'loading' | 'failed'>()
  private overlayBase = ''
  private buildingPool: Sprite[] = []
  private unitPool: Sprite[] = []
  private projPool: Sprite[] = []
  private labelPool = new Map<number, Text>()
  private tex = {} as Record<UnitKind | 'dot' | 'missile' | 'glow', Texture>
  private teamColor = new Map<number, number>()
  private kindOf = new Map<number, UnitKind>()
  private sizeOf = new Map<number, [number, number]>()
  /** def -> strategic icon (texture + relative size), once loaded */
  private icons = new Map<number, { tex: Texture; size: number }>()
  private projStyle = new Map<number, ProjStyle>()
  private fitScale = 1
  private destroyed = false
  /** once the user pans or zooms, resizes keep their view instead of re-fitting */
  private userMoved = false
  private resizeObserver: ResizeObserver | null = null
  /** positions of the units drawn last, for hit testing */
  private drawn: { uid: number; x: number; z: number; r: number }[] = []

  constructor(
    private readonly el: HTMLElement,
    private readonly header: StreamHeader,
    private readonly meta: StreamMeta
  ) {
    for (const t of meta.teams) this.teamColor.set(t.teamId, colorNum(t.color) ?? 0x888888)
    for (const [id, d] of Object.entries(meta.unitDefs)) {
      this.kindOf.set(Number(id), d.kind)
      this.sizeOf.set(Number(id), [Math.max(1, d.xsize) * 8, Math.max(1, d.zsize) * 8])
    }
    for (const [id, w] of Object.entries(meta.weaponDefs)) {
      const kind = projKind(w.type)
      this.projStyle.set(Number(id), {
        kind,
        color: kind === 'bomb' || kind === 'missile' || kind === 'torpedo' ? PROJ_DEFAULT_COLOR[kind] : (colorNum(w.color) ?? PROJ_DEFAULT_COLOR[kind]),
        size: Math.max(2, Math.min(12, w.size ?? 3))
      })
    }
  }

  async init(minimapUrl: string, overlayBase = '', gameAssetBase = ''): Promise<void> {
    this.overlayBase = overlayBase
    this.mapLayer.sortableChildren = true
    await this.app.init({
      resizeTo: this.el,
      background: '#0b0d10',
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1
    })
    if (this.destroyed) return
    this.el.appendChild(this.app.canvas)
    this.makeTextures()
    this.world.addChild(
      this.mapLayer,
      this.workGfx,
      this.buildingLayer,
      this.unitLayer,
      this.projGfx,
      this.projLayer,
      this.overlay,
      this.markGfx,
      this.markLabels
    )
    this.app.stage.addChild(this.world)

    // map rectangle placeholder until the minimap loads (or if it can't)
    const bg = new Graphics().rect(0, 0, this.header.mapSizeX, this.header.mapSizeZ).fill(0x1d232b)
    this.mapLayer.addChild(bg)
    void this.loadMinimap(minimapUrl)
    if (gameAssetBase) void this.loadIcons(gameAssetBase)
    this.fit()
    // Pixi's resizeTo only follows window resizes; the canvas host also changes with the layout
    this.resizeObserver = new ResizeObserver(() => {
      if (this.destroyed) return
      this.app.resize()
      if (!this.userMoved) this.fit()
    })
    this.resizeObserver.observe(this.el)
    this.installCamera()
  }

  destroy(): void {
    this.destroyed = true
    this.resizeObserver?.disconnect()
    try {
      this.app.destroy(true, { children: true, texture: true })
    } catch {
      // init may not have finished
    }
  }

  private async loadImage(url: string): Promise<HTMLImageElement | null> {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = url
    try {
      await img.decode()
      return img
    } catch {
      return null
    }
  }

  private async loadMinimap(url: string): Promise<void> {
    const img = await this.loadImage(url)
    if (!img || this.destroyed) return
    const s = Sprite.from(img)
    s.width = this.header.mapSizeX
    s.height = this.header.mapSizeZ
    this.mapLayer.addChild(s)
  }

  /** Loads the game's strategic icons for the unit types in this game (icontypes.json maps iconType -> bitmap). */
  private async loadIcons(base: string): Promise<void> {
    let types: Record<string, { bitmap: string; size: number }>
    try {
      const res = await fetch(`${base}/icontypes.json`)
      if (!res.ok) return
      types = await res.json()
    } catch {
      return
    }
    const byBitmap = new Map<string, Promise<Texture | null>>()
    const load = (bitmap: string): Promise<Texture | null> => {
      let p = byBitmap.get(bitmap)
      if (!p) {
        p = this.loadImage(`${base}/${bitmap.toLowerCase()}`).then((img) => (img && !this.destroyed ? Sprite.from(img).texture : null))
        byBitmap.set(bitmap, p)
      }
      return p
    }
    await Promise.all(
      Object.entries(this.meta.unitDefs).map(async ([id, d]) => {
        const t = types[d.iconType] ?? types[d.name]
        if (!t?.bitmap) return
        const tex = await load(t.bitmap)
        if (tex) this.icons.set(Number(id), { tex, size: t.size || 1 })
      })
    )
  }

  /** Shows/hides the height or metal map overlay, loading it on first use. Resolves false if unavailable. */
  async setMapOverlay(kind: 'height' | 'metal', visible: boolean): Promise<boolean> {
    const cur = this.mapOverlays.get(kind)
    if (cur instanceof Sprite) {
      cur.visible = visible
      return true
    }
    if (cur === 'failed') return false
    if (!visible || cur === 'loading') return true
    this.mapOverlays.set(kind, 'loading')
    const img = await this.loadImage(`${this.overlayBase}/${kind}`)
    if (!img) {
      this.mapOverlays.set(kind, 'failed')
      return false
    }
    if (this.destroyed) return false
    const s = Sprite.from(img)
    s.width = this.header.mapSizeX
    s.height = this.header.mapSizeZ
    s.alpha = kind === 'height' ? 0.85 : 1
    s.zIndex = kind === 'height' ? 1 : 2 // above the minimap (0); metal above height
    this.mapLayer.addChild(s)
    this.mapOverlays.set(kind, s)
    return true
  }

  private makeTextures(): void {
    const R = 32
    const stroke = { width: 5, color: 0x000000, alpha: 0.75 }
    const g = (draw: (g: Graphics) => Graphics): Texture => this.app.renderer.generateTexture(draw(new Graphics()))
    // fallback unit shapes (used until / unless the game's icons load)
    this.tex.ground = g((x) => x.circle(0, 0, R).fill(0xffffff).stroke(stroke))
    this.tex.air = g((x) => x.poly([0, -R, R, R, 0, R * 0.45, -R, R]).fill(0xffffff).stroke(stroke))
    this.tex.ship = g((x) => x.poly([0, -R, R * 0.55, 0, R * 0.4, R, -R * 0.4, R, -R * 0.55, 0]).fill(0xffffff).stroke(stroke))
    this.tex.commander = g((x) => {
      const pts: number[] = []
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? R : R * 0.45
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2
        pts.push(Math.cos(a) * r, Math.sin(a) * r)
      }
      return x.poly(pts).fill(0xffffff).stroke({ ...stroke, width: 4 })
    })
    this.tex.building = g((x) => x.rect(-R, -R, 2 * R, 2 * R).fill(0xffffff).stroke({ ...stroke, width: 4 }))
    this.tex.dot = g((x) => x.circle(0, 0, 8).fill(0xffffff))
    // projectile shapes; missiles point up (-y) unrotated
    this.tex.missile = g((x) =>
      x
        .poly([0, -16, 4, -8, 4, 10, 8, 16, -8, 16, -4, 10, -4, -8])
        .fill(0xffffff)
        .stroke({ width: 1.5, color: 0x000000, alpha: 0.6 })
    )
    this.tex.glow = g((x) =>
      x.circle(0, 0, 16).fill({ color: 0xffffff, alpha: 0.25 }).circle(0, 0, 10).fill({ color: 0xffffff, alpha: 0.6 }).circle(0, 0, 5).fill(0xffffff)
    )
  }

  get scale(): number {
    return this.world.scale.x
  }

  fit(): void {
    const { width: w, height: h } = this.app.screen // CSS pixels
    this.fitScale = Math.min(w / this.header.mapSizeX, h / this.header.mapSizeZ) * 0.96
    this.world.scale.set(this.fitScale)
    this.world.position.set((w - this.header.mapSizeX * this.fitScale) / 2, (h - this.header.mapSizeZ * this.fitScale) / 2)
  }

  /** Centers the view on a map position (keeps zoom, at least 2x the fitted zoom). */
  centerOn(x: number, z: number): void {
    this.userMoved = true
    const s = Math.max(this.scale, this.fitScale * 2)
    const { width: w, height: h } = this.app.screen
    this.world.scale.set(s)
    this.world.position.set(w / 2 - x * s, h / 2 - z * s)
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    this.userMoved = true
    const s = Math.min(this.fitScale * 40, Math.max(this.fitScale * 0.5, this.scale * factor))
    const wx = (sx - this.world.x) / this.scale
    const wz = (sy - this.world.y) / this.scale
    this.world.scale.set(s)
    this.world.position.set(sx - wx * s, sy - wz * s)
  }

  private installCamera(): void {
    const canvas = this.app.canvas
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        const r = canvas.getBoundingClientRect()
        this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.pow(1.0015, -e.deltaY))
      },
      { passive: false }
    )
    let drag: { x: number; y: number } | null = null
    canvas.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY }
      canvas.setPointerCapture(e.pointerId)
    })
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return
      this.userMoved = true
      this.world.position.set(this.world.x + e.clientX - drag.x, this.world.y + e.clientY - drag.y)
      drag = { x: e.clientX, y: e.clientY }
    })
    const end = (): void => {
      drag = null
    }
    canvas.addEventListener('pointerup', end)
    canvas.addEventListener('pointercancel', end)
    canvas.addEventListener('dblclick', () => {
      this.userMoved = false
      this.fit()
    })
  }

  /** Unit under a screen position (canvas coordinates), or -1. */
  pick(sx: number, sy: number): number {
    const wx = (sx - this.world.x) / this.scale
    const wz = (sy - this.world.y) / this.scale
    const tol = 4 / this.scale
    let best = -1
    let bestD = Infinity
    for (const d of this.drawn) {
      const dist = Math.hypot(d.x - wx, d.z - wz)
      if (dist < d.r + tol && dist < bestD) {
        best = d.uid
        bestD = dist
      }
    }
    return best
  }

  private sprite(pool: Sprite[], layer: Container, i: number): Sprite {
    let s = pool[i]
    if (!s) {
      s = new Sprite()
      s.anchor.set(0.5)
      pool[i] = s
      layer.addChild(s)
    }
    s.visible = true
    return s
  }

  render(
    units: UnitView[],
    n: number,
    proj: ProjectileSample | null,
    projAge: number,
    deaths: DeathFlash[],
    marks: MarkView[],
    opts: RenderOptions
  ): void {
    if (this.destroyed || !this.tex.dot) return
    const px = 1 / this.scale // one screen pixel in elmos
    this.renderUnits(units, n, px, opts)
    this.renderProjectiles(proj, projAge, px)
    this.renderEffects(deaths, px)
    this.renderMarks(marks, px)
  }

  private renderUnits(units: UnitView[], n: number, px: number, opts: RenderOptions): void {
    let ub = 0
    let uu = 0
    this.drawn.length = 0
    const o = this.overlay.clear()
    const wg = this.workGfx.clear()
    let hovered: { x: number; z: number; r: number } | null = null
    const flow = (performance.now() / 700) % 1 // build power particles move along the line

    for (let i = 0; i < n; i++) {
      const u = units[i]
      const kind = this.kindOf.get(u.def) ?? 'ground'
      const [fx, fz] = this.sizeOf.get(u.def) ?? [16, 16]
      const isBuilding = kind === 'building'
      const s = isBuilding ? this.sprite(this.buildingPool, this.buildingLayer, ub++) : this.sprite(this.unitPool, this.unitLayer, uu++)
      const icon = this.icons.get(u.def)
      s.tint = this.teamColor.get(u.team) ?? 0x888888
      s.position.set(u.x, u.z)
      s.alpha = u.build < 1 ? 0.35 + 0.45 * u.build : 1
      let r: number
      if (icon) {
        // strategic icon: constant on-screen size like in game, never smaller than the footprint
        s.texture = icon.tex
        s.rotation = 0
        const size = Math.max(ICON_PX * icon.size * opts.iconScale * px, isBuilding ? Math.max(fx, fz) : 0)
        s.width = size
        s.height = size
        r = size / 2
      } else {
        s.texture = this.tex[kind]
        if (isBuilding) {
          s.rotation = 0
          s.width = Math.max(fx, 4 * px)
          s.height = Math.max(fz, 4 * px)
          r = Math.max(s.width, s.height) / 2
        } else {
          const size = Math.max(Math.max(fx, fz) * 1.5, (kind === 'commander' ? 12 : 8) * opts.iconScale * px)
          s.rotation = kind === 'air' || kind === 'ship' ? u.rotation : 0
          s.width = size
          s.height = size
          r = size / 2
        }
      }
      this.drawn.push({ uid: u.uid, x: u.x, z: u.z, r })
      if (u.uid === opts.hoveredUid) hovered = { x: u.x, z: u.z, r }

      // build power: a line from the worker to what it builds / repairs / reclaims / resurrects / captures
      if (opts.buildLines && u.work && Math.hypot(u.wx - u.x, u.wz - u.z) < MAX_WORK_LINE) {
        const color = WORK_COLORS[u.work] ?? 0xffffff
        wg.moveTo(u.x, u.z).lineTo(u.wx, u.wz).stroke({ width: 1.8 * px, color, alpha: 0.75 })
        // particles flow towards the target (reclaim: towards the worker, it "eats")
        const dx = u.wx - u.x
        const dz = u.wz - u.z
        const len = Math.hypot(dx, dz)
        if (len > 6 * px) {
          for (let k = 0; k < 3; k++) {
            let t = (flow + k / 3) % 1
            if (u.work === WORK_RECLAIM) t = 1 - t
            wg.circle(u.x + dx * t, u.z + dz * t, 2 * px).fill({ color, alpha: 0.95 })
          }
        }
      }

      // HP bars for damaged units, once they are big enough on screen to read
      if (opts.hpBars && u.hp < 0.98 && u.build >= 1 && r / px > 3) {
        const w = Math.max(r * 2, 10 * px)
        const h = 2.5 * px
        const y = u.z - r - 4 * px
        o.rect(u.x - w / 2, y, w, h).fill({ color: 0x000000, alpha: 0.7 })
        o.rect(u.x - w / 2, y, w * u.hp, h).fill(u.hp > 0.6 ? 0x5ccf8a : u.hp > 0.3 ? 0xf2c14e : 0xff5050)
      }
    }
    for (let i = ub; i < this.buildingPool.length; i++) this.buildingPool[i].visible = false
    for (let i = uu; i < this.unitPool.length; i++) this.unitPool[i].visible = false
    if (hovered) o.circle(hovered.x, hovered.z, hovered.r + 3 * px).stroke({ width: 1.5 * px, color: 0xffffff })
  }

  /** Projectiles by weapon type, extrapolated from their sample with their velocity. */
  private renderProjectiles(proj: ProjectileSample | null, age: number, px: number): void {
    const g = this.projGfx.clear()
    let pn = 0
    if (proj) {
      for (let i = 0; i < proj.n; i++) {
        const w = proj.weapon[i]
        if (w === 0xffff) continue // v1 recordings: debris without a weapon
        const style = this.projStyle.get(w) ?? { kind: 'dot' as ProjKind, color: PROJ_DEFAULT_COLOR.dot, size: 3 }
        const vx = proj.vx[i]
        const vz = proj.vz[i]
        const x0 = proj.x[i]
        const z0 = proj.z[i]
        if (style.kind === 'beam' || style.kind === 'lightning') {
          // the velocity of a beam is the beam itself; beams are short-lived, fade them out
          const alpha = Math.max(0, 1 - age / 6)
          if (alpha <= 0) continue
          if (style.kind === 'beam') {
            g.moveTo(x0, z0).lineTo(x0 + vx, z0 + vz).stroke({ width: 2.2 * px, color: style.color, alpha })
            g.moveTo(x0, z0).lineTo(x0 + vx, z0 + vz).stroke({ width: 0.8 * px, color: 0xffffff, alpha: alpha * 0.8 })
          } else {
            const len = Math.hypot(vx, vz) || 1
            const nx = -vz / len
            const nz = vx / len
            g.moveTo(x0, z0)
            const segs = 6
            for (let k = 1; k <= segs; k++) {
              const t = k / segs
              const j = k === segs ? 0 : hash(i * 31 + k + proj.frame) * len * 0.18
              g.lineTo(x0 + vx * t + nx * j, z0 + vz * t + nz * j)
            }
            g.stroke({ width: 1.6 * px, color: style.color, alpha })
          }
          continue
        }
        const x = x0 + vx * age
        const z = z0 + vz * age
        switch (style.kind) {
          case 'laser': {
            // a bolt: short streak behind the head
            const k = Math.max(1.5, (6 * px) / (Math.hypot(vx, vz) || 1))
            g.moveTo(x - vx * k, z - vz * k).lineTo(x, z).stroke({ width: 1.8 * px, color: style.color, alpha: 0.95 })
            break
          }
          case 'missile':
          case 'torpedo': {
            g.moveTo(x - vx * 4, z - vz * 4).lineTo(x, z).stroke({ width: 1.2 * px, color: style.kind === 'missile' ? 0xffc080 : 0x9fd0ff, alpha: 0.45 })
            const s = this.sprite(this.projPool, this.projLayer, pn++)
            s.texture = this.tex.missile
            s.tint = style.color
            s.alpha = 1
            s.rotation = Math.atan2(vz, vx) + Math.PI / 2
            s.width = 4.5 * px
            s.height = 9 * px
            s.position.set(x, z)
            break
          }
          case 'dgun': {
            const s = this.sprite(this.projPool, this.projLayer, pn++)
            s.texture = this.tex.glow
            s.tint = style.color
            s.alpha = 1
            s.rotation = 0
            s.width = s.height = Math.max(14 * px, 30)
            s.position.set(x, z)
            break
          }
          case 'flame': {
            const s = this.sprite(this.projPool, this.projLayer, pn++)
            s.texture = this.tex.glow
            s.tint = style.color
            s.alpha = 0.55
            s.rotation = 0
            s.width = s.height = Math.max(6 * px, 12)
            s.position.set(x, z)
            break
          }
          case 'bomb': {
            const s = this.sprite(this.projPool, this.projLayer, pn++)
            s.texture = this.tex.dot
            s.tint = style.color
            s.alpha = 1
            s.rotation = 0
            s.width = s.height = Math.max(4.5 * px, 8)
            s.position.set(x, z)
            break
          }
          default: {
            const s = this.sprite(this.projPool, this.projLayer, pn++)
            s.texture = this.tex.dot
            s.tint = style.color
            s.alpha = 1
            s.rotation = 0
            s.width = s.height = Math.max(2.6 * px, style.size * 1.2)
            s.position.set(x, z)
          }
        }
      }
    }
    for (let i = pn; i < this.projPool.length; i++) this.projPool[i].visible = false
  }

  /** Death flashes: expanding, fading rings. */
  private renderEffects(deaths: DeathFlash[], px: number): void {
    const o = this.overlay
    for (const d of deaths) {
      const t = d.age / FLASH_FRAMES
      const radius = (d.big ? 60 : 25) * (0.3 + t) + 4 * px
      o.circle(d.x, d.z, radius).stroke({ width: 2 * px, color: 0xffd27a, alpha: 1 - t })
      if (t < 0.3) o.circle(d.x, d.z, radius * 0.6).fill({ color: 0xffffff, alpha: 0.5 * (1 - t / 0.3) })
    }
  }

  /** Map pings / markers (points with labels) and drawn lines, in the drawing player's color. */
  private renderMarks(marks: MarkView[], px: number): void {
    const g = this.markGfx.clear()
    const used = new Set<number>()
    for (const m of marks) {
      if (m.kind === 'line') {
        g.moveTo(m.x, m.z).lineTo(m.x2 ?? m.x, m.z2 ?? m.z).stroke({ width: 2.2 * px, color: m.color, alpha: 0.9 })
        continue
      }
      // point: pin + pulse rings for the first seconds
      if (m.age < PING_PULSE_FRAMES) {
        for (const off of [0, 0.35]) {
          const t = (m.age / PING_PULSE_FRAMES + off) % 1
          g.circle(m.x, m.z, (8 + 40 * t) * px).stroke({ width: 2 * px, color: m.color, alpha: 1 - t })
        }
      }
      g.circle(m.x, m.z, 6 * px).fill({ color: 0x000000, alpha: 0.6 }).circle(m.x, m.z, 4 * px).fill(m.color)
      g.moveTo(m.x, m.z - 6 * px).lineTo(m.x, m.z - 18 * px).stroke({ width: 2 * px, color: m.color })
      if (m.label) {
        let t = this.labelPool.get(m.id)
        if (!t) {
          t = new Text({
            text: m.label,
            style: { fill: 0xffffff, fontSize: 13, fontFamily: 'Segoe UI', stroke: { color: 0x000000, width: 3 } }
          })
          t.anchor.set(0, 1)
          this.labelPool.set(m.id, t)
          this.markLabels.addChild(t)
        }
        t.visible = true
        t.scale.set(px)
        t.position.set(m.x + 5 * px, m.z - 18 * px)
        used.add(m.id)
      }
    }
    for (const [id, t] of this.labelPool) if (!used.has(id)) t.visible = false
  }
}

export { brighten }
