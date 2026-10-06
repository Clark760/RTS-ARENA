// 世界状态：地形、实体、占位、视野；同时实现规则包用的 SetupContext 和 RuleContext
import type { Game, GameEvent, PlayerInfo, TypeDef } from "../api/bot-api.ts"
import { FlowCache } from "./nav.ts"
import { PathFinder } from "./path.ts"
import { Mulberry32, mixSeed } from "./rng.ts"
import type {
  EntityState,
  Marker,
  MatchResult,
  PlayerState,
  Rect,
  Rng,
  RuleContext,
  RuleEvent,
  Ruleset,
  SetupContext,
  TypeSpec,
} from "./types.ts"

/** 每个玩家等着交给 bot 的事件上限，超出后丢弃新的 damaged 事件 */
const PENDING_SOFT_CAP = 200

export function resolveType(name: string, s: TypeSpec): TypeDef {
  return {
    name,
    kind: s.kind,
    w: s.w ?? 1,
    h: s.h ?? 1,
    maxHp: s.kind === "resource" ? 0 : (s.maxHp ?? 0),
    cost: s.cost ?? {},
    buildTicks: s.buildTicks ?? 0,
    moveTicks: s.kind === "unit" ? (s.moveTicks ?? 0) : 0,
    sight: s.sight ?? 0,
    attack: s.attack ?? null,
    gather: s.gather ?? null,
    dropOff: s.dropOff ?? false,
    produces: s.produces ?? [],
    builds: s.kind === "unit" ? (s.builds ?? []) : [],
    resource: s.resource ?? null,
  }
}

/** 两个矩形之间的曼哈顿距离（重叠为 0，贴着为 1） */
export function rectDist(a: Rect, b: Rect): number {
  const dx = Math.max(0, b.x - (a.x + a.w - 1), a.x - (b.x + b.w - 1))
  const dy = Math.max(0, b.y - (a.y + a.h - 1), a.y - (b.y + b.h - 1))
  return dx + dy
}

export function attackable(e: EntityState): boolean {
  return e.def.kind !== "resource" && e.def.maxHp > 0
}

export class World implements SetupContext, RuleContext {
  readonly rules: Ruleset
  readonly types: Record<string, TypeDef> = {}
  readonly seed: number
  readonly playerCount: number
  /** 规则包用的随机数 */
  readonly rng: Rng
  /** 内核用的随机数（移动先后顺序） */
  readonly simRng: Rng
  tick = 0
  width = 0
  height = 0
  terrain: string[] = []
  /** 地形能否通行 */
  walk = new Uint8Array(0)
  /** 建筑、资源点占的格子（存 id） */
  staticOcc = new Int32Array(0)
  /** 单位占的格子（存 id） */
  unitOcc = new Int32Array(0)
  /** 按创建先后插入，遍历顺序即创建顺序 */
  readonly ents = new Map<number, EntityState>()
  /**
   * id 随机分配、不重复使用：递增的 id 会让 bot 从自己新单位的 id 跳号推算出对手的产量。
   * 范围随实体数扩大，正常对局 id 都在 7 位以内。
   */
  private idRng: Rng
  private usedIds = new Set<number>()
  readonly players: PlayerState[]
  /** 本 tick 的事件（规则包看） */
  events: RuleEvent[] = []
  /** 本 tick 的攻击 [攻击者, 目标, ...]（回放用） */
  shots: number[] = []
  markers: Marker[] = []
  status = ""
  /** 每个玩家的视野格（tick 开始时算） */
  vis: Uint8Array[] = []
  pf!: PathFinder
  flow!: FlowCache
  /** 建筑、资源点每增减一次加 1，流场缓存据此作废 */
  staticVersion = 0

  /** 每个玩家的队伍编号 */
  readonly teams: number[]

  constructor(rules: Ruleset, names: string[], seed: number, teams?: number[]) {
    this.rules = rules
    this.seed = seed
    this.playerCount = names.length
    if (teams && teams.length !== names.length) throw new Error(`队伍编号有 ${teams.length} 个，玩家有 ${names.length} 个`)
    this.teams = teams ? [...teams] : names.map((_, i) => i)
    this.rng = new Mulberry32(mixSeed(seed, "rules"))
    this.simRng = new Mulberry32(mixSeed(seed, "sim"))
    this.idRng = new Mulberry32(mixSeed(seed, "ids"))
    for (const [name, spec] of Object.entries(rules.types)) this.types[name] = resolveType(name, spec)
    for (const d of Object.values(this.types))
      for (const b of d.builds)
        if (this.types[b]?.kind !== "building") throw new Error(`规则包 ${rules.id}：${d.name} 的 builds 里 "${b}" 不是建筑类型`)
    this.players = names.map((name, id) => ({
      id,
      name,
      alive: true,
      score: 0,
      resources: Object.fromEntries(rules.resources.map((r) => [r, 0])),
      pending: [],
    }))
  }

  get maxTicks(): number {
    return this.rules.maxTicks
  }

  // ---------- 地形与占位 ----------

  setTerrain(rows: string[]): void {
    if (rows.length === 0 || rows[0].length === 0) throw new Error("地图不能为空")
    const w = rows[0].length
    rows.forEach((row, y) => {
      if (row.length !== w) throw new Error(`地图第 ${y} 行长度 ${row.length}，应为 ${w}`)
      for (const ch of row) if (!this.rules.terrain[ch]) throw new Error(`地图第 ${y} 行有未定义的地形字符 "${ch}"`)
    })
    this.width = w
    this.height = rows.length
    this.terrain = rows.slice()
    const n = w * rows.length
    this.walk = new Uint8Array(n)
    this.staticOcc = new Int32Array(n)
    this.unitOcc = new Int32Array(n)
    for (let y = 0; y < this.height; y++)
      for (let x = 0; x < w; x++) this.walk[y * w + x] = this.rules.terrain[rows[y][x]].walkable ? 1 : 0
    this.pf = new PathFinder(w, this.height)
    this.flow = new FlowCache(this)
    this.staticVersion++
    // 视野按队伍算：同队的玩家共用一张视野格
    const byTeam = new Map<number, Uint8Array>()
    this.vis = this.players.map((p) => {
      const t = this.teams[p.id]
      if (!byTeam.has(t)) byTeam.set(t, new Uint8Array(n))
      return byTeam.get(t)!
    })
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height
  }

  /** 地形可走且没有建筑、资源点 */
  staticFree(i: number): boolean {
    return this.walk[i] === 1 && this.staticOcc[i] === 0
  }

  canPlace(def: TypeDef, x: number, y: number): boolean {
    for (let yy = y; yy < y + def.h; yy++)
      for (let xx = x; xx < x + def.w; xx++) {
        if (!this.inBounds(xx, yy)) return false
        const i = yy * this.width + xx
        if (!this.staticFree(i) || this.unitOcc[i] !== 0) return false
      }
    return true
  }

  private occupy(e: EntityState, val: number): void {
    if (e.def.kind !== "unit") this.staticVersion++
    const grid = e.def.kind === "unit" ? this.unitOcc : this.staticOcc
    for (let yy = e.y; yy < e.y + e.h; yy++)
      for (let xx = e.x; xx < e.x + e.w; xx++) grid[yy * this.width + xx] = val
  }

  moveUnit(e: EntityState, to: number): void {
    this.unitOcc[e.y * this.width + e.x] = 0
    e.x = to % this.width
    e.y = (to - e.x) / this.width
    this.unitOcc[to] = e.id
  }

  // ---------- 实体 ----------

  private create(type: string, owner: number, x: number, y: number, amount?: number): EntityState {
    const def = this.types[type]
    if (!def) throw new Error(`未定义的实体类型 "${type}"`)
    if (owner < -1 || owner >= this.playerCount || !Number.isInteger(owner)) throw new Error(`玩家编号 ${owner} 不存在`)
    const e: EntityState = {
      id: this.newId(),
      type,
      def,
      owner,
      x,
      y,
      w: def.w,
      h: def.h,
      hp: def.maxHp,
      amount: def.kind === "resource" ? (amount ?? this.rules.types[type].amount ?? 0) : 0,
      order: { kind: "idle" },
      carrying: null,
      queue: [],
      construction: null,
      attackCd: 0,
      moveCd: 0,
      gatherCd: 0,
      lastHitBy: -1,
      path: [],
      pathKey: "",
      planX: 0,
      planY: 0,
      stuck: 0,
      want: -1,
      alive: true,
    }
    this.ents.set(e.id, e)
    this.occupy(e, e.id)
    return e
  }

  private newId(): number {
    const range = Math.max(1_000_000, this.usedIds.size * 4)
    for (;;) {
      const id = 1 + this.idRng.int(range - 1)
      if (this.usedIds.has(id)) continue
      this.usedIds.add(id)
      return id
    }
  }

  spawn(type: string, owner: number, x: number, y: number, opts?: { amount?: number }): number {
    const def = this.types[type]
    if (!def) throw new Error(`未定义的实体类型 "${type}"`)
    if (!this.canPlace(def, x, y)) throw new Error(`${type} 放不到 (${x}, ${y})：越界、地形不可走或已被占`)
    return this.create(type, owner, x, y, opts?.amount).id
  }

  /** 生产出来的单位、规则包刷出来的实体都走这里，会发 created 事件 */
  spawnLive(type: string, owner: number, x: number, y: number, amount?: number): EntityState {
    const e = this.create(type, owner, x, y, amount)
    this.events.push({ kind: "created", id: e.id, type, owner })
    if (owner >= 0) this.pushEvent(owner, { kind: "created", tick: this.tick, id: e.id, type })
    return e
  }

  /** 放下地基：生命从 1/10 开始，随建造进度涨到满（被打掉的不补） */
  placeSite(type: string, owner: number, x: number, y: number): EntityState {
    const e = this.spawnLive(type, owner, x, y)
    e.construction = { done: 0, total: Math.max(1, e.def.buildTicks) }
    e.hp = Math.max(1, Math.ceil(e.def.maxHp / 10))
    return e
  }

  /** 实体死亡或被移除：发事件、清占位 */
  destroy(e: EntityState, killer: number): void {
    if (!e.alive) return
    e.alive = false
    this.occupy(e, 0)
    this.ents.delete(e.id)
    this.events.push({ kind: "died", id: e.id, type: e.type, owner: e.owner, x: e.x, y: e.y, killer, ...(e.construction ? { unfinished: true as const } : {}) })
    for (const p of this.players) {
      if (p.id === e.owner || this.visibleTo(p.id, e))
        this.pushEvent(p.id, { kind: "died", tick: this.tick, id: e.id, type: e.type, owner: e.owner, x: e.x, y: e.y })
    }
  }

  pushEvent(player: number, ev: GameEvent): void {
    const p = this.players[player]
    if (ev.kind === "damaged" && p.pending.length >= PENDING_SOFT_CAP) return
    p.pending.push(ev)
  }

/**
   * 在矩形周围找能放下 def 的位置。单位（1×1）：从贴着矩形的可走格出发按步数往外找（不会隔墙出生），
   * 最多 maxRing 步；多格实体：按曼哈顿圈找。同样远的选离地图中心最近的，再一样随机挑（对称地图上两边一样）。
   */
  findSpotAround(def: TypeDef, around: Rect, maxRing: number): { x: number; y: number } | null {
    if (def.w === 1 && def.h === 1) return this.findUnitSpot(around, maxRing)
    const cx2 = this.width - def.w
    const cy2 = this.height - def.h
    const ties: { x: number; y: number }[] = []
    for (let d = 1; d <= maxRing; d++) {
      let bestC = Number.MAX_SAFE_INTEGER
      ties.length = 0
      for (let y = around.y - d - def.h + 1; y <= around.y + around.h - 1 + d; y++)
        for (let x = around.x - d - def.w + 1; x <= around.x + around.w - 1 + d; x++) {
          if (rectDist({ x, y, w: def.w, h: def.h }, around) !== d) continue
          if (!this.canPlace(def, x, y)) continue
          // 到中心的距离（坐标乘 2 免得出现小数）
          const c = Math.abs(2 * x - cx2) + Math.abs(2 * y - cy2)
          if (c < bestC) {
            bestC = c
            ties.length = 0
          }
          if (c === bestC) ties.push({ x, y })
        }
      if (ties.length > 0) return ties.length === 1 ? ties[0] : ties[this.simRng.int(ties.length)]
    }
    return null
  }

  private findUnitSpot(around: Rect, maxRing: number): { x: number; y: number } | null {
    const W = this.width
    const depth = new Map<number, number>()
    let frontier: number[] = []
    for (let y = around.y - 1; y <= around.y + around.h; y++)
      for (let x = around.x - 1; x <= around.x + around.w; x++) {
        if (!this.inBounds(x, y) || rectDist({ x, y, w: 1, h: 1 }, around) !== 1) continue
        const i = y * W + x
        if (!this.staticFree(i)) continue
        depth.set(i, 1)
        frontier.push(i)
      }
    for (let d = 1; d <= maxRing && frontier.length > 0; d++) {
      let bestC = Number.MAX_SAFE_INTEGER
      const ties: number[] = []
      for (const i of frontier) {
        if (this.unitOcc[i] !== 0) continue
        const x = i % W
        const y = (i - x) / W
        const c = Math.abs(2 * x - (W - 1)) + Math.abs(2 * y - (this.height - 1))
        if (c < bestC) {
          bestC = c
          ties.length = 0
        }
        if (c === bestC) ties.push(i)
      }
      if (ties.length > 0) {
        const i = ties.length === 1 ? ties[0] : ties[this.simRng.int(ties.length)]
        return { x: i % W, y: Math.floor(i / W) }
      }
      const next: number[] = []
      for (const i of frontier) {
        const x = i % W
        const y = (i - x) / W
        for (const [nx, ny] of [[x, y - 1], [x + 1, y], [x, y + 1], [x - 1, y]]) {
          if (!this.inBounds(nx, ny)) continue
          const ni = ny * W + nx
          if (depth.has(ni) || !this.staticFree(ni)) continue
          depth.set(ni, d + 1)
          next.push(ni)
        }
      }
      frontier = next
    }
    return null
  }

  // ---------- 视野 ----------

  computeVisibility(): void {
    if (!this.rules.fog) return
    const W = this.width
    for (const v of new Set(this.vis)) v.fill(0)
    for (const e of this.ents.values()) {
      if (e.owner < 0) continue
      const v = this.vis[e.owner]
      const s = e.def.sight
      const y0 = Math.max(0, e.y - s)
      const y1 = Math.min(this.height - 1, e.y + e.h - 1 + s)
      for (let y = y0; y <= y1; y++) {
        const dy = Math.max(0, e.y - y, y - (e.y + e.h - 1))
        const rem = s - dy
        const x0 = Math.max(0, e.x - rem)
        const x1 = Math.min(W - 1, e.x + e.w - 1 + rem)
        v.fill(1, y * W + x0, y * W + x1 + 1)
      }
    }
  }

  isAlly(a: number, b: number): boolean {
    return a >= 0 && b >= 0 && this.teams[a] === this.teams[b]
  }

  /** 资源点和地形一样始终可见（位置、储量都公开）；盟友的实体总是看得见，盟友看得见的你也看得见 */
  visibleTo(player: number, e: EntityState): boolean {
    if (!this.rules.fog || this.isAlly(e.owner, player) || e.def.kind === "resource") return true
    const v = this.vis[player]
    for (let y = e.y; y < e.y + e.h; y++)
      for (let x = e.x; x < e.x + e.w; x++) if (v[y * this.width + x]) return true
    return false
  }

  // ---------- 给 bot 的静态信息 ----------

  gameInfo(player: number): Game {
    const walkable: Record<string, boolean> = {}
    for (const [ch, t] of Object.entries(this.rules.terrain)) walkable[ch] = t.walkable
    return {
      me: player,
      playerNames: this.players.map((p) => p.name),
      teams: [...this.teams],
      width: this.width,
      height: this.height,
      terrain: this.terrain,
      walkable,
      types: this.types,
      resources: this.rules.resources,
      maxTicks: this.rules.maxTicks,
      decisionInterval: this.rules.decisionInterval,
      fuel: this.rules.fuel,
      unitCap: this.rules.unitCap,
      fog: this.rules.fog,
    }
  }

  playerInfos(): PlayerInfo[] {
    return this.players.map((p) => ({ id: p.id, name: p.name, team: this.teams[p.id], alive: p.alive, score: p.score }))
  }

  /** 玩家现有单位数 + 生产队列里的单位数 */
  unitCount(player: number): number {
    let n = 0
    for (const e of this.ents.values()) {
      if (e.owner !== player) continue
      if (e.def.kind === "unit") n++
      for (const q of e.queue) if (this.types[q.type].kind === "unit") n++
    }
    return n
  }

  // ---------- SetupContext / RuleContext ----------

  setResources(player: number, resources: Record<string, number>): void {
    for (const [r, n] of Object.entries(resources)) {
      if (!this.rules.resources.includes(r)) throw new Error(`未定义的资源 "${r}"`)
      this.players[player].resources[r] = n
    }
  }

  /** 按创建顺序 */
  entities(): readonly EntityState[] {
    return [...this.ents.values()]
  }

  get(id: number): EntityState | undefined {
    return this.ents.get(id)
  }

  dist(a: Rect, b: Rect): number {
    return rectDist(a, b)
  }

  entitiesIn(x: number, y: number, w: number, h: number): EntityState[] {
    const r = { x, y, w, h }
    const out: EntityState[] = []
    for (const e of this.ents.values()) if (rectDist(e, r) === 0) out.push(e)
    return out
  }

  addScore(player: number, n: number): void {
    this.players[player].score += n
  }

  setScore(player: number, n: number): void {
    this.players[player].score = n
  }

  addResource(player: number, resource: string, n: number): void {
    if (!this.rules.resources.includes(resource)) throw new Error(`未定义的资源 "${resource}"`)
    this.players[player].resources[resource] += n
  }

  spawnNear(type: string, owner: number, x: number, y: number, opts?: { amount?: number }): number | null {
    const def = this.types[type]
    if (!def) throw new Error(`未定义的实体类型 "${type}"`)
    if (this.canPlace(def, x, y)) return this.spawnLive(type, owner, x, y, opts?.amount).id
    const spot = this.findSpotAround(def, { x, y, w: 1, h: 1 }, 8)
    return spot ? this.spawnLive(type, owner, spot.x, spot.y, opts?.amount).id : null
  }

  remove(id: number): void {
    const e = this.ents.get(id)
    if (e) this.destroy(e, -1)
  }

  eliminate(player: number): void {
    this.players[player].alive = false
  }

  setMarkers(markers: Marker[]): void {
    this.markers = markers
  }

  setStatus(text: string): void {
    this.status = text
  }

  // ---------- 结果 ----------

  ended: (MatchResult & { tick: number }) | null = null
}
