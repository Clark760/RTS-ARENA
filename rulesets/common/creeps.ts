// 野怪营地（D-189，弑君歼灭、弑君拓荒用）：地图上有几处中立野怪，打死一只给最后一击的玩家高额赏金，
// 一个营地清空以后过一段时间原地刷新。用来把双方从家门口引出来（试写反馈：守家方优势太大，两边都守就拖成平局）。
// - 营地成对摆放，两两中心对称，都在离两家主基地一样远的那条斜线上（内圈一对离地图中心近、外圈一对靠边）
// - 野怪平时站在营地里不动；挨了打、或者玩家的东西走进营地 2 格内，整个营地一起出手，追打营地 8 格内离它最近的玩家实体（单位和建筑）；
//   营地 8 格内没有玩家的东西了就走回营地，回到原位就回满血（风筝出 8 格、在营地外放箭塔都占不到便宜）。
//   8 格是按目标离营地算的，野怪自己绕路去追时可能走到营地 10 多格外（试写实测最远 13 格）
// - 玩家的兵不会自动打中立实体，要用 cmd.attack 指定，或者 cmd.attackMove 写 { neutral: true }（D-191）
// - 到时间上限、原来的判法是平局时，比野怪赏金（D-191，试写反馈：两个守家的 bot 对打常常 0:0 平局）
import type { MatchResult, RuleContext, SetupContext, TypeSpec } from "../../src/core/types.ts"
import { STANDARD_TERRAIN } from "./standard.ts"

/** 每只野怪的赏金（金） */
export const CREEP_BOUNTY = 100
/** 营地清空后多少 tick 刷新 */
export const CREEP_RESPAWN = 900
/** 追打范围：离营地这么多格以内 */
const LEASH = 8
/** 警戒范围：玩家的东西走进营地这么多格以内，营地就出手 */
const AGGRO = 2

export function creepType(): TypeSpec {
  return {
    kind: "unit",
    maxHp: 300,
    moveTicks: 3,
    sight: 6,
    attack: { damage: 15, range: 1, cooldown: 10 },
    look: { shape: "circle", label: "怪", color: "#8a6a3b", name: "野怪" },
  }
}

interface Camp {
  /** 营地里每只野怪的位置（刷新时放回这里） */
  spots: { x: number; y: number }[]
  /** 活着的野怪 id */
  ids: number[]
  /** 清空了：哪个 tick 刷新；没清空是 null */
  respawnAt: number | null
  /** 正在出手 */
  angry: boolean
}

// 一局的状态（setup 时重置：规则包不进沙箱直接跑时，顶层变量不会每局重新加载）
let camps: Camp[] = []
const homeOf = new Map<number, { x: number; y: number; camp: number }>()
const lastHp = new Map<number, number>()
let kills: number[] = []
let bounty: number[] = []

/** 给 bot 看的营地信息（位置公开，和金矿一样） */
export interface CampInfo {
  /** 营地第一只野怪的位置 */
  x: number
  y: number
  /** 营地的每一格（满员时每格一只；中心对称的那一半营地朝左、朝上长） */
  cells: { x: number; y: number }[]
  /** 正在出手（挨了打、或者有玩家的东西进了营地 2 格内，还没回去） */
  angry: boolean
  /** 满员几只 */
  size: number
  /** 现在活着几只（看不见的也算） */
  alive: number
  /** 清空以后哪个 tick 刷新；没清空是 null */
  respawnAt: number | null
}

export function campInfo(): CampInfo[] {
  return camps.map((c) => ({
    x: c.spots[0].x,
    y: c.spots[0].y,
    cells: c.spots.map((p) => ({ x: p.x, y: p.y })),
    angry: c.angry,
    size: c.spots.length,
    alive: c.ids.length,
    respawnAt: c.respawnAt,
  }))
}

/** 每个玩家拿到的野怪赏金（给 bot 看：到时间上限平局时比这个） */
export function creepBounty(n: number): number[] {
  return Array.from({ length: n }, (_, i) => bounty[i] ?? 0)
}

/** 每个玩家打死几只野怪、拿了多少赏金（对局结果的 stats 用） */
export function creepStats(n: number): Record<string, number[]> {
  return { 击杀野怪: Array.from({ length: n }, (_, i) => kills[i] ?? 0), 野怪赏金: Array.from({ length: n }, (_, i) => bounty[i] ?? 0) }
}

/**
 * 到时间上限：原来的判法（击杀价值、主基地生命）分出了胜负就照旧；平局时野怪赏金多的赢，再一样才平局。
 * 结果带上野怪统计
 */
export function creepTimeUp(ctx: RuleContext, r: MatchResult): MatchResult {
  const stats = creepStats(ctx.playerCount)
  if (r.winner !== null || ctx.playerCount !== 2) return { ...r, stats }
  const a = bounty[0] ?? 0
  const b = bounty[1] ?? 0
  if (a === b) return { ...r, reason: r.reason.replace(/平局$/, "野怪赏金也一样（" + a + "），平局"), stats }
  return { winner: a > b ? 0 : 1, reason: `时间到，击杀价值和主基地生命都相同，野怪赏金 ${a} : ${b}`, stats }
}

/**
 * 摆营地。inner / outer 是内圈、外圈那一对里左下那个营地的目标位置（另一个是中心对称的）：在目标附近找一块空地，
 * 营地的格子能走、没有实体，2 格内没有建筑和资源点（别挡矿、别贴着家）。只找一边，另一边取镜像，两边保证一样
 */
export function setupCamps(ctx: SetupContext, W: number, H: number, inner: { x: number; y: number }, outer: { x: number; y: number }): void {
  camps = []
  homeOf.clear()
  lastHp.clear()
  kills = []
  bounty = []
  const walk = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && STANDARD_TERRAIN[ctx.terrain[y][x]]?.walkable === true
  const ents = ctx.entities()
  const blocked = (x: number, y: number) => !walk(x, y) || ents.some((e) => ctx.dist(e, { x, y, w: 1, h: 1 }) === 0)
  const nearStatic = (x: number, y: number) => ents.some((e) => e.def.kind !== "unit" && ctx.dist(e, { x, y, w: 1, h: 1 }) <= 2)
  const mirror = (p: { x: number; y: number }) => ({ x: W - 1 - p.x, y: H - 1 - p.y })
  // 营地的格子：中心、右边、下边（3 只）或者中心、右边（2 只）
  const shape = (size: number) => (size === 3 ? [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }] : [{ x: 0, y: 0 }, { x: 1, y: 0 }])
  const place = (target: { x: number; y: number }, size: number) => {
    const offs = shape(size)
    for (let r = 0; r <= 8; r++)
      for (let dx = -r; dx <= r; dx++)
        for (const dy of Math.abs(dx) === r ? [0] : [r - Math.abs(dx), -(r - Math.abs(dx))]) {
          const c = { x: target.x + dx, y: target.y + dy }
          const cells = offs.map((o) => ({ x: c.x + o.x, y: c.y + o.y }))
          // 镜像那一边的格子也要空着（中心对称的地图上一般一样，保险起见一起查）
          const all = [...cells, ...cells.map(mirror)]
          if (all.every((p) => !blocked(p.x, p.y) && !nearStatic(p.x, p.y))) return cells
        }
    return null
  }
  for (const [target, size] of [[inner, 3], [outer, 2]] as const) {
    const cells = place(target, size)
    if (!cells) continue
    for (const spots of [cells, cells.map(mirror)]) {
      const camp: Camp = { spots, ids: [], respawnAt: null, angry: false }
      camps.push(camp)
      for (const p of spots) {
        const id = ctx.spawn("creep", -1, p.x, p.y)
        camp.ids.push(id)
        homeOf.set(id, { x: p.x, y: p.y, camp: camps.length - 1 })
      }
    }
  }
}

/** 每 tick：发赏金、刷新、野怪的行为 */
export function creepTick(ctx: RuleContext): void {
  // 赏金：最后一击的玩家拿；营地清空了记下刷新时间
  for (const ev of ctx.events) {
    if (ev.kind !== "died" || ev.type !== "creep") continue
    const home = homeOf.get(ev.id)
    homeOf.delete(ev.id)
    lastHp.delete(ev.id)
    if (ev.killer >= 0) {
      ctx.addResource(ev.killer, "gold", CREEP_BOUNTY)
      kills[ev.killer] = (kills[ev.killer] ?? 0) + 1
      bounty[ev.killer] = (bounty[ev.killer] ?? 0) + CREEP_BOUNTY
      ctx.note(`P${ev.killer} 打死一只野怪，赏金 ${CREEP_BOUNTY}`, ev.killer)
    }
    if (!home) continue
    const camp = camps[home.camp]
    camp.ids = camp.ids.filter((id) => id !== ev.id)
    if (camp.ids.length === 0) {
      camp.respawnAt = ctx.tick + CREEP_RESPAWN
      camp.angry = false
      ctx.note(`(${camp.spots[0].x}, ${camp.spots[0].y}) 的野怪营地清空了，第 ${camp.respawnAt} tick 刷新`)
    }
  }
  // 刷新：放回原位（被占了就放在旁边）
  camps.forEach((camp, k) => {
    if (camp.respawnAt === null || ctx.tick < camp.respawnAt) return
    for (const p of camp.spots) {
      const id = ctx.spawnNear("creep", -1, p.x, p.y)
      if (id === null) continue
      camp.ids.push(id)
      homeOf.set(id, { x: p.x, y: p.y, camp: k })
    }
    if (camp.ids.length) {
      camp.respawnAt = null
      ctx.note(`(${camp.spots[0].x}, ${camp.spots[0].y}) 的野怪营地刷新了`)
    }
  })
  if (ctx.tick % 2 !== 0) return
  const creeps = ctx.entities({ type: "creep" })
  if (creeps.length === 0) return
  const players = ctx.entities().filter((e) => e.owner >= 0 && e.def.maxHp > 0)
  camps.forEach((camp) => {
    const mine = creeps.filter((c) => camp.ids.includes(c.id))
    if (mine.length === 0) return
    const near = (dist: number) => players.filter((e) => camp.spots.some((p) => ctx.dist(e, { x: p.x, y: p.y, w: 1, h: 1 }) <= dist))
    // 挨了打，或者有人走进警戒范围：整个营地出手
    if (mine.some((c) => c.hp < (lastHp.get(c.id) ?? c.hp)) || near(AGGRO).length) camp.angry = true
    for (const c of mine) lastHp.set(c.id, c.hp)
    const prey = camp.angry ? near(LEASH) : []
    if (prey.length === 0) camp.angry = false
    for (const c of mine) {
      const home = homeOf.get(c.id)!
      if (prey.length) {
        let best = prey[0]
        for (const e of prey) if (ctx.dist(c, e) < ctx.dist(c, best)) best = e
        if (c.order.kind !== "attack" || c.order.target !== best.id) ctx.orderNeutral(c.id, { kind: "attack", target: best.id })
      } else if (c.x !== home.x || c.y !== home.y) {
        if (c.order.kind !== "move") ctx.orderNeutral(c.id, { kind: "move", x: home.x, y: home.y })
      } else if (c.hp < c.def.maxHp) {
        // 回到原位、附近没人：回满血
        ctx.setHp(c.id, c.def.maxHp)
        lastHp.set(c.id, c.def.maxHp)
      }
    }
  })
}
