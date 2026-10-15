// PixiJS scene for the player: minimap background, unit icons (shape by kind, tinted by team), projectiles,
// HP bars and death flashes, with pan/zoom. World coordinates are elmos (x right, z down).
import 'pixi.js/unsafe-eval' // no eval under the app's CSP
import { Application, Container, Graphics, Sprite, type Texture } from 'pixi.js'
import type { ProjectileSample, StreamHeader, StreamMeta, UnitKind } from '@shared/stream/format'
import type { UnitView } from '@shared/stream/interpolate'

export interface DeathFlash {
  x: number
  z: number
  age: number // frames since death
  team: number
  big: boolean
}

export interface RenderOptions {
  hpBars: boolean
  hoveredUid: number
}

const MIN_UNIT_PX = 7
const MIN_BUILDING_PX = 4
const FLASH_FRAMES = 45

function colorNum(hex: string): number {
  return parseInt(hex.slice(1), 16) || 0x888888
}

export class PlayerStage {
  app = new Application()
  private world = new Container()
  private mapLayer = new Container()
  private buildingLayer = new Container()
  private unitLayer = new Container()
  private projLayer = new Container()
  private overlay = new Graphics()
  private mapOverlays = new Map<'height' | 'metal', Sprite | 'loading' | 'failed'>()
  private overlayBase = ''
  private buildingPool: Sprite[] = []
  private unitPool: Sprite[] = []
  private projPool: Sprite[] = []
  private tex = {} as Record<UnitKind | 'dot', Texture>
  private teamColor = new Map<number, number>()
  private kindOf = new Map<number, UnitKind>()
  private sizeOf = new Map<number, [number, number]>()
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
    meta: StreamMeta
  ) {
    for (const t of meta.teams) this.teamColor.set(t.teamId, colorNum(t.color))
    for (const [id, d] of Object.entries(meta.unitDefs)) {
      this.kindOf.set(Number(id), d.kind)
      this.sizeOf.set(Number(id), [Math.max(1, d.xsize) * 8, Math.max(1, d.zsize) * 8])
    }
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
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = `${this.overlayBase}/${kind}`
    try {
      await img.decode()
    } catch {
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

  async init(minimapUrl: string, overlayBase = ''): Promise<void> {
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
    this.world.addChild(this.mapLayer, this.buildingLayer, this.unitLayer, this.projLayer, this.overlay)
    this.app.stage.addChild(this.world)

    // map rectangle placeholder until the minimap loads (or if it can't)
    const bg = new Graphics().rect(0, 0, this.header.mapSizeX, this.header.mapSizeZ).fill(0x1d232b)
    this.mapLayer.addChild(bg)
    void this.loadMinimap(minimapUrl)
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

  private async loadMinimap(url: string): Promise<void> {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = url
    try {
      await img.decode()
    } catch {
      return // no minimap: keep the plain background
    }
    if (this.destroyed) return
    const s = Sprite.from(img)
    s.width = this.header.mapSizeX
    s.height = this.header.mapSizeZ
    this.mapLayer.addChild(s)
  }

  private makeTextures(): void {
    const R = 32
    const stroke = { width: 5, color: 0x000000, alpha: 0.75 }
    const g = (draw: (g: Graphics) => Graphics): Texture => this.app.renderer.generateTexture(draw(new Graphics()))
    this.tex.ground = g((x) => x.poly([0, -R, R * 0.85, R * 0.75, 0, R * 0.35, -R * 0.85, R * 0.75]).fill(0xffffff).stroke(stroke))
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
    const tol = 6 / this.scale
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
    opts: RenderOptions
  ): void {
    if (this.destroyed || !this.tex.dot) return
    const px = 1 / this.scale // one screen pixel in elmos
    let ub = 0
    let uu = 0
    this.drawn.length = 0
    const o = this.overlay.clear()
    let hovered: { x: number; z: number; r: number } | null = null

    for (let i = 0; i < n; i++) {
      const u = units[i]
      const kind = this.kindOf.get(u.def) ?? 'ground'
      const [fx, fz] = this.sizeOf.get(u.def) ?? [16, 16]
      const isBuilding = kind === 'building'
      const s = isBuilding ? this.sprite(this.buildingPool, this.buildingLayer, ub++) : this.sprite(this.unitPool, this.unitLayer, uu++)
      s.texture = this.tex[kind]
      s.tint = this.teamColor.get(u.team) ?? 0x888888
      s.position.set(u.x, u.z)
      s.alpha = u.build < 1 ? 0.3 + 0.5 * u.build : 1
      let r: number
      if (isBuilding) {
        s.rotation = 0
        s.width = Math.max(fx, MIN_BUILDING_PX * px)
        s.height = Math.max(fz, MIN_BUILDING_PX * px)
        r = Math.max(s.width, s.height) / 2
      } else {
        const base = Math.max(fx, fz) * (kind === 'commander' ? 2.2 : 1.5)
        const size = Math.max(base, (kind === 'commander' ? 1.6 : 1) * MIN_UNIT_PX * px)
        s.rotation = kind === 'commander' ? 0 : u.rotation
        s.width = size
        s.height = size
        r = size / 2
      }
      this.drawn.push({ uid: u.uid, x: u.x, z: u.z, r })
      if (u.uid === opts.hoveredUid) hovered = { x: u.x, z: u.z, r }
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

    // projectiles, extrapolated with their velocity
    let pn = 0
    if (proj) {
      const size = 3 * px
      for (let i = 0; i < proj.n; i++) {
        const s = this.sprite(this.projPool, this.projLayer, pn++)
        s.texture = this.tex.dot
        s.tint = brighten(this.teamColor.get(proj.team[i]) ?? 0xffffff)
        s.position.set(proj.x[i] + proj.vx[i] * projAge, proj.z[i] + proj.vz[i] * projAge)
        s.width = size
        s.height = size
      }
    }
    for (let i = pn; i < this.projPool.length; i++) this.projPool[i].visible = false

    // death flashes: expanding, fading rings
    for (const d of deaths) {
      const t = d.age / FLASH_FRAMES
      const radius = (d.big ? 60 : 25) * (0.3 + t) + 4 * px
      o.circle(d.x, d.z, radius).stroke({ width: 2 * px, color: 0xffd27a, alpha: 1 - t })
      if (t < 0.3) o.circle(d.x, d.z, radius * 0.6).fill({ color: 0xffffff, alpha: 0.5 * (1 - t / 0.3) })
    }
    if (hovered) o.circle(hovered.x, hovered.z, hovered.r + 3 * px).stroke({ width: 1.5 * px, color: 0xffffff })
  }
}

function brighten(c: number): number {
  const r = Math.min(255, ((c >> 16) & 255) + 90)
  const g = Math.min(255, ((c >> 8) & 255) + 90)
  const b = Math.min(255, (c & 255) + 90)
  return (r << 16) | (g << 8) | b
}
