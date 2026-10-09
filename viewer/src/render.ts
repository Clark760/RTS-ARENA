// PixiJS 画面：地形、实体、攻击线、叠加层；拖动平移、滚轮缩放、点击选中；可以按某一队的视野看（迷雾）
import { Application, CanvasSource, Container, Graphics, Sprite, Text, Texture } from "pixi.js"
import type { EntSnap, Look, Marker, Replay } from "../../src/core/types.ts"
import type { Delta, State } from "./model.ts"
import { Vision } from "./vision.ts"

export const TILE = 16
export const PLAYER_COLORS = [0x4ea1ff, 0xff5d5d, 0x5ee08a, 0xf5c542, 0xc77dff, 0x4dd4d4]
const NEUTRAL = 0x9aa0a6

export function playerColor(owner: number | null | undefined): number {
  return owner === null || owner === undefined || owner < 0 ? NEUTRAL : PLAYER_COLORS[owner % PLAYER_COLORS.length]
}

function cssColor(c: string): number {
  return parseInt(c.replace("#", ""), 16)
}

interface EntView {
  root: Container
  body: Graphics
  bar: Graphics
  /** 身上有增益时外面的金色圈（D-186） */
  ring: Graphics
  /** 上次画的增益名字 */
  lastBf: string
  w: number
  h: number
  /** 动画：从 (fx, fy) 到 (x, y)，从 start tick 开始，持续 dur tick */
  fx: number
  fy: number
  x: number
  y: number
  start: number
  dur: number
  lastHp: number
  /** 上次画的建造进度（100 = 建好了） */
  lastBp: number
}

export class Renderer {
  readonly app = new Application()
  private camera = new Container()
  private terrainLayer = new Graphics()
  /** 迷雾：每格一个像素的画布，放大成格子 */
  private fogLayer = new Container()
  private fog: { canvas: HTMLCanvasElement; image: ImageData; texture: Texture } | null = null
  private vision: Vision | null = null
  /** 按哪一队的视野看；null 是全图 */
  private team: number | null = null
  private markerLayer = new Container()
  private entLayer = new Container()
  private shotLayer = new Graphics()
  /** 光环范围（菱形，曼哈顿距离）和放技能的闪光（D-186） */
  private auraLayer = new Graphics()
  private castLayer = new Graphics()
  private casts: { u: number; s: string }[] = []
  private castTick = 0
  private selLayer = new Graphics()
  private views = new Map<number, EntView>()
  private replay!: Replay
  private state!: State
  /** 当前帧的攻击，和它发生的 tick */
  private shots: number[] = []
  private shotTick = 0
  /** 已死目标最后的位置，攻击线还要画到那里 */
  private ghosts = new Map<number, { x: number; y: number; seen: boolean }>()
  selected: number | null = null
  onSelect: (id: number | null) => void = () => {}

  async init(host: HTMLElement): Promise<void> {
    await this.app.init({ resizeTo: host, background: 0x15181c, antialias: true, autoDensity: true, resolution: window.devicePixelRatio || 1 })
    host.appendChild(this.app.canvas)
    this.camera.addChild(this.terrainLayer, this.fogLayer, this.markerLayer, this.auraLayer, this.entLayer, this.shotLayer, this.castLayer, this.selLayer)
    this.app.stage.addChild(this.camera)
    this.setupInput(host)
  }

  load(replay: Replay, state: State): void {
    this.replay = replay
    const { width, height, terrain, colors } = replay.map
    const g = this.terrainLayer.clear()
    for (let y = 0; y < height; y++) {
      // 同一行连续相同的地形合成一个矩形
      let x0 = 0
      for (let x = 1; x <= width; x++) {
        if (x < width && terrain[y][x] === terrain[y][x0]) continue
        g.rect(x0 * TILE, y * TILE, (x - x0) * TILE, TILE).fill(cssColor(colors[terrain[y][x0]] ?? "#000000"))
        x0 = x
      }
    }
    for (let x = 0; x <= width; x++) g.moveTo(x * TILE, 0).lineTo(x * TILE, height * TILE)
    for (let y = 0; y <= height; y++) g.moveTo(0, y * TILE).lineTo(width * TILE, y * TILE)
    g.stroke({ width: 1, color: 0x000000, alpha: 0.18 })
    this.setupFog(replay)
    this.fit()
    this.jump(state)
  }

  private setupFog(replay: Replay): void {
    for (const c of this.fogLayer.removeChildren()) c.destroy()
    this.fog?.texture.destroy(true)
    this.fog = null
    this.team = null
    this.vision = Vision.supported(replay) ? new Vision(replay) : null
    if (!this.vision || !replay.fog) return
    const { width, height } = replay.map
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const image = new ImageData(width, height)
    const texture = new Texture({ source: new CanvasSource({ resource: canvas, scaleMode: "nearest", resolution: 1 }) })
    const sprite = new Sprite(texture)
    sprite.scale.set(TILE)
    this.fogLayer.addChild(sprite)
    this.fogLayer.visible = false
    this.fog = { canvas, image, texture }
  }

  /** 能不能按视野看（老回放没有视野信息） */
  get canPerspective(): boolean {
    return this.vision !== null
  }

  /** 按 team 这一队的视野看；null 回到全图 */
  setPerspective(team: number | null): void {
    this.team = this.vision ? team : null
    this.refreshVision()
  }

  /** 这个实体现在画不画（按视野看时看不见的敌人不画） */
  shown(id: number): boolean {
    return this.views.get(id)?.root.visible ?? false
  }

  /** 局面变了以后重算视野：隐藏看不见的实体、更新迷雾 */
  private refreshVision(): void {
    const team = this.team
    const vision = this.vision
    if (team === null || !vision) {
      for (const v of this.views.values()) v.root.visible = true
      this.fogLayer.visible = false
      return
    }
    vision.compute(this.state, team)
    for (const [id, v] of this.views) {
      const e = this.state.ents.get(id)
      v.root.visible = e ? vision.visible(e, team) : false
    }
    if (!this.fog) return
    const { image, canvas, texture } = this.fog
    const px = image.data
    for (let i = 0; i < vision.vis.length; i++) px[i * 4 + 3] = vision.vis[i] ? 0 : 150
    canvas.getContext("2d")!.putImageData(image, 0, 0)
    texture.source.update()
    this.fogLayer.visible = true
  }

  fit(): void {
    const { width, height } = this.replay.map
    const sw = this.app.screen.width
    const sh = this.app.screen.height
    const scale = Math.min(sw / (width * TILE), sh / (height * TILE)) * 0.96
    this.camera.scale.set(scale)
    this.camera.position.set((sw - width * TILE * scale) / 2, (sh - height * TILE * scale) / 2)
  }

  /** 跳到某个局面（不做动画） */
  jump(state: State): void {
    this.state = state
    for (const v of this.views.values()) v.root.destroy({ children: true })
    this.views.clear()
    this.ghosts.clear()
    for (const e of state.ents.values()) this.addView(e, state.tick)
    this.shots = []
    this.casts = []
    this.drawMarkers(state.markers)
    this.refreshVision()
  }

  /** 应用了一帧之后更新画面 */
  advance(state: State, d: Delta): void {
    this.state = state
    const t = state.tick
    for (const e of d.died) {
      const v = this.views.get(e.id)
      if (v) {
        this.ghosts.set(e.id, { x: v.x, y: v.y, seen: v.root.visible })
        v.root.destroy({ children: true })
        this.views.delete(e.id)
      }
    }
    for (const id of d.spawned) this.addView(state.ents.get(id)!, t)
    // 换了主人：按新主人的颜色重画
    for (const o of d.owned) {
      const v = this.views.get(o.id)
      const e = state.ents.get(o.id)
      if (!v || !e) continue
      v.root.destroy({ children: true })
      this.views.delete(o.id)
      this.addView(e, t)
    }
    for (const m of d.moved) {
      const v = this.views.get(m.id)
      const e = state.ents.get(m.id)
      if (!v || !e) continue
      v.fx = m.fromX
      v.fy = m.fromY
      v.x = e.x
      v.y = e.y
      v.start = t
      v.dur = Math.max(1, this.replay.types[e.type]?.moveTicks ?? 1)
    }
    if (d.shots.length) {
      this.shots = d.shots
      this.shotTick = t
    }
    if (d.casts.length) {
      this.casts = d.casts
      this.castTick = t
    }
    if (this.replay.frames[t - 1]?.markers) this.drawMarkers(state.markers)
    this.refreshVision()
  }

  private addView(e: EntSnap, t: number): void {
    const info = this.replay.types[e.type]
    const look: Look = info?.look ?? { shape: "circle" }
    const w = info?.w ?? 1
    const h = info?.h ?? 1
    const root = new Container()
    const body = new Graphics()
    const color = look.color ? cssColor(look.color) : playerColor(e.owner)
    const pw = w * TILE
    const ph = h * TILE
    const pad = info?.kind === "unit" ? 2.5 : 1.5
    const cx = pw / 2
    const cy = ph / 2
    const r = Math.min(pw, ph) / 2 - pad
    switch (look.shape) {
      case "circle":
        body.circle(cx, cy, r)
        break
      case "square":
        body.roundRect(pad, pad, pw - pad * 2, ph - pad * 2, 3)
        break
      case "triangle":
        body.poly([cx, pad, pw - pad, ph - pad, pad, ph - pad])
        break
      case "diamond":
        body.poly([cx, pad, pw - pad, cy, cx, ph - pad, pad, cy])
        break
      case "hex":
        body.regularPoly(cx, cy, r, 6)
        break
    }
    body.fill({ color, alpha: info?.kind === "building" ? 0.55 : 0.95 }).stroke({ width: 1.2, color: 0x000000, alpha: 0.6 })
    root.addChild(body)
    if (look.label) {
      const size = info?.kind === "unit" ? 9 : 13
      const label = new Text({ text: look.label, style: { fontSize: size * 2, fill: 0xffffff, fontWeight: "bold" } })
      label.scale.set(0.5)
      label.anchor.set(0.5)
      label.position.set(cx, cy + 0.5)
      root.addChild(label)
    }
    const bar = new Graphics()
    const ring = new Graphics()
    root.addChild(bar, ring)
    this.entLayer.addChild(root)
    this.views.set(e.id, { root, body, bar, ring, lastBf: "", w, h, fx: e.x, fy: e.y, x: e.x, y: e.y, start: t, dur: 1, lastHp: -1, lastBp: -1 })
  }

  private drawMarkers(markers: Marker[]): void {
    for (const c of this.markerLayer.removeChildren()) c.destroy()
    const g = new Graphics()
    this.markerLayer.addChild(g)
    for (const m of markers) {
      if (m.kind === "zone") {
        const color = typeof m.color === "string" && /^#[0-9a-fA-F]{6}$/.test(m.color) ? cssColor(m.color) : playerColor(m.owner)
        g.rect(m.x * TILE, m.y * TILE, m.w * TILE, m.h * TILE)
          .fill({ color, alpha: m.owner === null ? 0.12 : 0.25 })
          .stroke({ width: 2, color, alpha: 0.9 })
        if (m.label) this.addLabel(m.label, (m.x + m.w / 2) * TILE, m.y * TILE - 8, color)
      } else {
        this.addLabel(m.text, (m.x + 0.5) * TILE, (m.y + 0.5) * TILE, playerColor(m.owner))
      }
    }
  }

  private addLabel(text: string, x: number, y: number, color: number): void {
    const t = new Text({ text, style: { fontSize: 22, fill: color, fontWeight: "bold", stroke: { color: 0x000000, width: 4 } } })
    t.scale.set(0.5)
    t.anchor.set(0.5)
    t.position.set(x, y)
    this.markerLayer.addChild(t)
  }

  /** 每个画面帧调用；now 是带小数的 tick */
  draw(now: number): void {
    for (const [id, v] of this.views) {
      const p = Math.min(1, Math.max(0, (now - v.start) / v.dur))
      const px = v.fx + (v.x - v.fx) * p
      const py = v.fy + (v.y - v.fy) * p
      v.root.position.set(px * TILE, py * TILE)
      const e = this.state.ents.get(id)
      if (e && (e.hp !== v.lastHp || (e.bp ?? 100) !== v.lastBp)) {
        v.lastHp = e.hp
        v.lastBp = e.bp ?? 100
        // 没建好的建筑画得淡一些
        v.body.alpha = v.lastBp < 100 ? 0.4 : 1
        this.drawBar(v, e)
      }
      // 身上有增益（光环、技能给的）：外面一圈金色
      const bf = e?.bf?.join("|") ?? ""
      if (bf !== v.lastBf) {
        v.lastBf = bf
        const g = v.ring.clear()
        if (bf) g.circle((v.w * TILE) / 2, (v.h * TILE) / 2, (Math.min(v.w, v.h) * TILE) / 2 + 1).stroke({ width: 1.4, color: 0xf2c14e, alpha: 0.9 })
      }
    }
    // 光环范围：带光环的实体（看得见的）周围画一个淡淡的菱形
    const ag = this.auraLayer.clear()
    for (const [id, v] of this.views) {
      const e = this.state.ents.get(id)
      const info = e ? this.replay.types[e.type] : undefined
      if (!e || !info?.auras?.length || !v.root.visible || e.bp !== undefined) continue
      const cx = v.root.x + (v.w * TILE) / 2
      const cy = v.root.y + (v.h * TILE) / 2
      for (const a of info.auras) {
        const r = ((a.radius < 0 ? (e.st?.sight ?? info.sight ?? 0) : a.radius) + 0.5) * TILE
        ag.poly([cx, cy - r, cx + r, cy, cx, cy + r, cx - r, cy]).fill({ color: playerColor(e.owner), alpha: 0.06 }).stroke({ width: 1, color: playerColor(e.owner), alpha: 0.35 })
      }
    }
    // 放技能：释放者身上一圈扩散的金光，3 tick 后淡出（技能名在右边的事件列表里）
    const cg = this.castLayer.clear()
    const cAge = now - this.castTick
    if (this.casts.length && cAge < 3) {
      const alpha = Math.max(0, 1 - cAge / 3)
      for (const c of this.casts) {
        const p = this.centerOf(c.u)
        if (!p) continue
        cg.circle(p.x, p.y, TILE * (0.6 + cAge * 0.5)).stroke({ width: 2, color: 0xf2c14e, alpha })
      }
    }
    // 攻击线：本帧发生的攻击，在一个 tick 内淡出
    const sg = this.shotLayer.clear()
    const age = now - this.shotTick
    if (this.shots.length && age < 1.5) {
      const alpha = Math.max(0, 1 - age / 1.5)
      for (let i = 0; i < this.shots.length; i += 2) {
        const a = this.centerOf(this.shots[i])
        const b = this.centerOf(this.shots[i + 1])
        if (!a || !b) continue
        const owner = this.state.ents.get(this.shots[i])?.owner
        sg.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 1.6, color: playerColor(owner), alpha })
        sg.circle(b.x, b.y, 2.2).fill({ color: 0xffffff, alpha })
      }
    }
    const sel = this.selLayer.clear()
    if (this.selected !== null) {
      const v = this.views.get(this.selected)
      if (v?.root.visible) {
        sel.rect(v.root.x - 2, v.root.y - 2, v.w * TILE + 4, v.h * TILE + 4).stroke({ width: 2, color: 0xffffff })
      }
    }
  }

  /** 攻击线的端点；按视野看时看不见的一端不画（不然会暴露迷雾里的攻击者） */
  private centerOf(id: number): { x: number; y: number } | null {
    const v = this.views.get(id)
    if (v) return v.root.visible ? { x: v.root.x + (v.w * TILE) / 2, y: v.root.y + (v.h * TILE) / 2 } : null
    const g = this.ghosts.get(id)
    return g?.seen ? { x: (g.x + 0.5) * TILE, y: (g.y + 0.5) * TILE } : null
  }

  private drawBar(v: EntView, e: EntSnap): void {
    const info = this.replay.types[e.type]
    const g = v.bar.clear()
    const max = info?.kind === "resource" ? null : (e.st?.maxHp ?? info?.maxHp)
    const w = v.w * TILE - 2
    // 建造进度：底边一条蓝色进度条
    if (e.bp !== undefined) {
      g.rect(1, v.h * TILE - 3, w, 2.5).fill(0x000000)
      g.rect(1, v.h * TILE - 3, (w * e.bp) / 100, 2.5).fill(0x5aa9f2)
    }
    if (!max || e.hp >= max) return // 满血不画
    const frac = Math.max(0, e.hp / max)
    g.rect(1, -3, w, 2.5).fill(0x000000)
    g.rect(1, -3, w * frac, 2.5).fill(frac > 0.5 ? 0x6ee36e : frac > 0.25 ? 0xf2c14e : 0xf25f5c)
  }

  private setupInput(host: HTMLElement): void {
    let drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null
    host.addEventListener("pointerdown", (ev) => {
      drag = { x: ev.clientX, y: ev.clientY, cx: this.camera.x, cy: this.camera.y, moved: false }
      host.setPointerCapture(ev.pointerId)
    })
    host.addEventListener("pointermove", (ev) => {
      if (!drag) return
      const dx = ev.clientX - drag.x
      const dy = ev.clientY - drag.y
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true
      if (drag.moved) this.camera.position.set(drag.cx + dx, drag.cy + dy)
    })
    host.addEventListener("pointerup", (ev) => {
      if (drag && !drag.moved) this.pick(ev, host)
      drag = null
    })
    host.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault()
        const rect = host.getBoundingClientRect()
        const mx = ev.clientX - rect.left
        const my = ev.clientY - rect.top
        const old = this.camera.scale.x
        const next = Math.min(8, Math.max(0.2, old * (ev.deltaY < 0 ? 1.15 : 1 / 1.15)))
        this.camera.position.set(mx - ((mx - this.camera.x) * next) / old, my - ((my - this.camera.y) * next) / old)
        this.camera.scale.set(next)
      },
      { passive: false },
    )
  }

  private pick(ev: PointerEvent, host: HTMLElement): void {
    const rect = host.getBoundingClientRect()
    const wx = (ev.clientX - rect.left - this.camera.x) / this.camera.scale.x / TILE
    const wy = (ev.clientY - rect.top - this.camera.y) / this.camera.scale.y / TILE
    let hit: number | null = null
    for (const [id, v] of this.views) {
      if (!v.root.visible) continue
      const x = v.root.x / TILE
      const y = v.root.y / TILE
      if (wx >= x && wx < x + v.w && wy >= y && wy < y + v.h) {
        // 单位优先于建筑和资源点
        if (hit === null || this.replay.types[this.state.ents.get(id)!.type]?.kind === "unit") hit = id
      }
    }
    this.selected = hit
    this.onSelect(hit)
  }
}
