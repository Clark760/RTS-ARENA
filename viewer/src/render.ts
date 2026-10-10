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
  /** 特效（D-190）：放技能、回血、技能冷却环；飘字放在 fxLayer 里 */
  private fxLayer = new Container()
  private castLayer = new Graphics()
  private statusLayer = new Graphics()
  /** 最近放的技能：释放者、目标点（技能的目标、同一 tick 在旁边刷出来的资源点）、哪个 tick */
  private castFx: { u: number; x: number; y: number; targets: { x: number; y: number }[]; tick: number }[] = []
  /** 最近的回血：哪个实体、回了多少、哪个 tick */
  private healFx: { id: number; amount: number; tick: number }[] = []
  /** 飘字：放技能的技能名、回血的 +N */
  private texts: { t: Text; id: number; tick: number; life: number; dx: number }[] = []
  /** 每个实体放技能的 tick（按技能），算冷却环用 */
  private castLog = new Map<number, Map<string, number[]>>()
  /** 每个实体出现的 tick（算开局冷却 initialCooldown） */
  private bornAt = new Map<number, number>()
  /** 每个实体最近几次回血的 tick（面板显示"正在回血"） */
  private healLog = new Map<number, number[]>()
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
    this.fxLayer.addChild(this.castLayer)
    this.camera.addChild(this.terrainLayer, this.fogLayer, this.markerLayer, this.auraLayer, this.entLayer, this.statusLayer, this.shotLayer, this.fxLayer, this.selLayer)
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
    this.indexAbilities(replay)
    this.fit()
    this.jump(state)
  }

  /** 整理整局的放技能、出生、回血时间（D-190）：冷却环、选中面板按当前 tick 查 */
  private indexAbilities(replay: Replay): void {
    this.castLog.clear()
    this.bornAt.clear()
    this.healLog.clear()
    for (const e of replay.initial.entities) this.bornAt.set(e.id, 0)
    for (const f of replay.frames) {
      for (const e of f.spawn ?? []) this.bornAt.set(e.id, f.t)
      for (const c of f.casts ?? []) {
        const m = this.castLog.get(c.u) ?? new Map<string, number[]>()
        m.set(c.s, [...(m.get(c.s) ?? []), f.t])
        this.castLog.set(c.u, m)
      }
      const h = f.heal ?? []
      for (let i = 0; i < h.length; i += 2) this.healLog.set(h[i], [...(this.healLog.get(h[i]) ?? []), f.t])
    }
  }

  /** 实体 id 在第 t tick 每个技能还要几 tick 才能再放（没有技能返回空数组） */
  cooldownsAt(id: number, type: string, t: number): { id: string; name: string; left: number; cooldown: number }[] {
    const skills = this.replay.types[type]?.skills ?? []
    return skills.map((k) => {
      const casts = (this.castLog.get(id)?.get(k.id) ?? []).filter((x) => x <= t)
      const last = casts.length ? casts[casts.length - 1] : null
      // 放成功那一 tick 冷却是 cooldown，当 tick 结算就减 1；实体出现以后每 tick 减 1
      const left = last !== null ? Math.max(0, last + k.cooldown - 1 - t) : Math.max(0, k.initialCooldown - (t - (this.bornAt.get(id) ?? 0)))
      return { id: k.id, name: k.name, left, cooldown: k.cooldown }
    })
  }

  /** 实体在第 t tick 前后是不是正在被动回血（最近一次回血在 every + 1 tick 以内） */
  healingAt(id: number, type: string, t: number): boolean {
    const regen = this.replay.types[type]?.passives?.find((x) => x.kind === "regen")
    if (!regen) return false
    const log = this.healLog.get(id) ?? []
    return log.some((x) => x <= t && t - x <= regen.every + 1)
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
    this.castFx = []
    this.healFx = []
    for (const x of this.texts) x.t.destroy()
    this.texts = []
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
    // 放技能：记下释放者的位置、目标（技能写的目标，加上同一 tick 在释放者 4 格内刷出来的资源点，比如点金的金矿）
    for (const c of d.casts) {
      const caster = state.ents.get(c.u)
      if (!caster) continue
      const targets: { x: number; y: number }[] = []
      if (c.x !== undefined && c.y !== undefined) targets.push({ x: c.x, y: c.y })
      const tg = c.t !== undefined ? state.ents.get(c.t) : undefined
      if (tg) targets.push({ x: tg.x, y: tg.y })
      for (const id of d.spawned) {
        const e = state.ents.get(id)
        if (e && this.replay.types[e.type]?.kind === "resource" && Math.abs(e.x - caster.x) + Math.abs(e.y - caster.y) <= 4) targets.push({ x: e.x, y: e.y })
      }
      this.castFx.push({ u: c.u, x: caster.x, y: caster.y, targets, tick: t })
      const name = this.replay.types[caster.type]?.skills?.find((k) => k.id === c.s)?.name ?? c.s
      this.float(name, c.u, t, 0xf2c14e, 14)
    }
    for (let i = 0; i < d.heals.length; i += 2) {
      this.healFx.push({ id: d.heals[i], amount: d.heals[i + 1], tick: t })
      this.float(`+${d.heals[i + 1]}`, d.heals[i], t, 0x6ee36e, 10)
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

  /** 在实体头顶飘一行字（技能名、+回血），life 个 tick 后消失 */
  private float(text: string, id: number, tick: number, color: number, life: number): void {
    const t = new Text({ text, style: { fontSize: 22, fill: color, fontWeight: "bold", stroke: { color: 0x000000, width: 4 } } })
    t.scale.set(0.5)
    t.anchor.set(0.5)
    t.visible = false
    this.fxLayer.addChild(t)
    // 同一个实体同时飘好几行时错开一点
    const dx = this.texts.filter((x) => x.id === id && tick - x.tick < 3).length * 10
    this.texts.push({ t, id, tick, life, dx })
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
    // 光环波纹、金环呼吸、冷却环发光按真实时间动（暂停时也在动）；放技能、回血的特效按 tick 走
    const wall = performance.now() / 1000
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
        if (bf)
          g.circle((v.w * TILE) / 2, (v.h * TILE) / 2, (Math.min(v.w, v.h) * TILE) / 2 + 1.2)
            .fill({ color: 0xf2c14e, alpha: 0.12 })
            .stroke({ width: 1.6, color: 0xf2c14e, alpha: 1 })
      }
      // 金环一呼一吸（D-190：增益要有明确的指示）
      if (bf) v.ring.alpha = 0.55 + 0.45 * Math.sin(wall * 5 + id)
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
        const col = playerColor(e.owner)
        const dia = (rr: number) => [cx, cy - rr, cx + rr, cy, cx, cy + rr, cx - rr, cy]
        // 范围：淡淡的底色 + 边缘
        ag.poly(dia(r)).fill({ color: col, alpha: 0.05 }).stroke({ width: 1.2, color: col, alpha: 0.4 })
        // 从光环的主人往外扩散到边缘的金色波纹，两道错开半拍，越往外越淡（D-190）
        for (const k of [0, 0.5]) {
          const f = (wall / 1.8 + k) % 1
          ag.poly(dia(Math.max(2, r * f))).fill({ color: 0xf2c14e, alpha: 0.07 * (1 - f) }).stroke({ width: 2, color: 0xf2c14e, alpha: 0.6 * (1 - f) })
        }
        // 主人身上一圈光晕
        ag.circle(cx, cy, TILE * (0.9 + 0.12 * Math.sin(wall * 3))).fill({ color: 0xf2c14e, alpha: 0.18 })
      }
    }
    // 状态环（D-190）：有技能的实体身边一圈冷却进度（金色是冷却好了的部分，好了整圈发光）；正在回血的再加一圈绿色
    const stg = this.statusLayer.clear()
    const tickNow = Math.floor(now)
    for (const [id, v] of this.views) {
      const e = this.state.ents.get(id)
      const info = e ? this.replay.types[e.type] : undefined
      if (!e || !v.root.visible || (!info?.skills?.length && !info?.passives?.length)) continue
      const cx = v.root.x + (v.w * TILE) / 2
      const cy = v.root.y + (v.h * TILE) / 2
      const R = (Math.max(v.w, v.h) * TILE) / 2 + 3.5
      const cds = this.cooldownsAt(id, e.type, tickNow)
      cds.forEach((c, k) => {
        const rr = R + k * 2.5
        const ready = c.left === 0
        const frac = ready ? 1 : 1 - c.left / Math.max(1, c.cooldown)
        stg.circle(cx, cy, rr).stroke({ width: 1.6, color: 0x000000, alpha: 0.45 })
        if (ready) stg.circle(cx, cy, rr).stroke({ width: 2, color: 0xf2c14e, alpha: 0.6 + 0.4 * Math.sin(wall * 6) })
        // 先 moveTo 到弧的起点：不然 arc 会从上一笔的终点连一条线过来
        else if (frac > 0) stg.moveTo(cx, cy - rr).arc(cx, cy, rr, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2).stroke({ width: 2, color: 0xf2c14e, alpha: 0.85 })
      })
      if (this.healingAt(id, e.type, tickNow)) stg.circle(cx, cy, R + cds.length * 2.5 + 1).stroke({ width: 1.5, color: 0x6ee36e, alpha: 0.5 + 0.3 * Math.sin(wall * 8) })
    }
    // 放技能（D-190）：释放者身上金色冲击波和放射光线，一道金光射向目标（点金的新金矿），目标处闪一颗星；持续 8 tick
    const cg = this.castLayer.clear()
    this.castFx = this.castFx.filter((c) => now - c.tick < 8)
    for (const c of this.castFx) {
      const age = Math.max(0, now - c.tick)
      const f = age / 8
      const alpha = 1 - f
      const p = this.centerOf(c.u) ?? (this.team === null ? { x: (c.x + 0.5) * TILE, y: (c.y + 0.5) * TILE } : null)
      if (!p) continue
      cg.circle(p.x, p.y, TILE * (0.5 + f * 2.2)).stroke({ width: 3 * alpha + 0.5, color: 0xf2c14e, alpha })
      cg.circle(p.x, p.y, TILE * (0.3 + f * 1.2)).fill({ color: 0xfff1b8, alpha: 0.35 * alpha })
      for (let k = 0; k < 8; k++) {
        const ang = (Math.PI / 4) * k + age * 0.3
        const r0 = TILE * (0.6 + f * 1.4)
        const r1 = r0 + TILE * 0.7
        cg.moveTo(p.x + Math.cos(ang) * r0, p.y + Math.sin(ang) * r0).lineTo(p.x + Math.cos(ang) * r1, p.y + Math.sin(ang) * r1).stroke({ width: 1.5, color: 0xf2c14e, alpha })
      }
      for (const tg of c.targets) {
        const tx = (tg.x + 0.5) * TILE
        const ty = (tg.y + 0.5) * TILE
        // 光束从释放者伸向目标（前 3 tick 伸过去，之后淡出）
        const reach = Math.min(1, age / 3)
        cg.moveTo(p.x, p.y).lineTo(p.x + (tx - p.x) * reach, p.y + (ty - p.y) * reach).stroke({ width: 3 * alpha + 0.5, color: 0xf2c14e, alpha: 0.9 * alpha })
        if (age >= 2) {
          const g = Math.min(1, (age - 2) / 3)
          const sr = TILE * (0.4 + g * 0.9)
          cg.poly([tx, ty - sr, tx + sr * 0.25, ty - sr * 0.25, tx + sr, ty, tx + sr * 0.25, ty + sr * 0.25, tx, ty + sr, tx - sr * 0.25, ty + sr * 0.25, tx - sr, ty, tx - sr * 0.25, ty - sr * 0.25]).fill({ color: 0xfff1b8, alpha: 0.9 * alpha })
          cg.circle(tx, ty, TILE * (0.5 + g)).stroke({ width: 1.5, color: 0xf2c14e, alpha })
        }
      }
    }
    // 回血（D-190）：绿色光圈往外扩、身上几颗绿色十字往上飘；持续 8 tick
    this.healFx = this.healFx.filter((h) => now - h.tick < 8)
    for (const h of this.healFx) {
      const p = this.centerOf(h.id)
      if (!p) continue
      const f = Math.max(0, now - h.tick) / 8
      const alpha = 1 - f
      cg.circle(p.x, p.y, TILE * (0.5 + f * 0.9)).stroke({ width: 2, color: 0x6ee36e, alpha })
      for (const [ox, oy] of [[-5, 2], [5, -1], [0, 5]]) {
        const x = p.x + ox
        const y = p.y + oy - f * TILE * 1.2
        cg.rect(x - 1.8, y - 0.6, 3.6, 1.2).fill({ color: 0x6ee36e, alpha })
        cg.rect(x - 0.6, y - 1.8, 1.2, 3.6).fill({ color: 0x6ee36e, alpha })
      }
    }
    // 飘字：往上飘、慢慢变淡；看不见的实体不飘
    this.texts = this.texts.filter((x) => {
      const age = now - x.tick
      if (age >= x.life || age < 0) {
        x.t.destroy()
        return false
      }
      const p = this.centerOf(x.id)
      x.t.visible = p !== null
      if (p) {
        x.t.position.set(p.x + x.dx, p.y - TILE * 0.9 - (age / x.life) * TILE * 1.4)
        x.t.alpha = Math.min(1, 1.6 * (1 - age / x.life))
      }
      return true
    })
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
