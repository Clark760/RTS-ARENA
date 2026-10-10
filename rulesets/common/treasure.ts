// 中央宝箱（D-202，弑君歼灭用）：每 900 tick（和野怪刷新同一时刻）在地图正中刷宝箱，不会动、不会还手，
// 打掉它（最后一击）的玩家马上得金子，不算击杀价值。
// 用户：希望大模型更灵活地去打仗而不是龟缩——后半局家门口的矿采完以后，有一个必须出门去抢的目标。
// （原来打算在正中刷金矿，算下来工人从正中走回主基地交货一趟 200 tick 出头、只带 5 金，10 个工人采完 600 金要 2700 tick，没人会去抢）
// - D-206（用户：宝箱改成 1×1，去掉把单位挤开这种容易出 bug 的机制）：宝箱 1×1、300 血、值 300 金。地图宽高是偶数，
//   正中没有一个格子能对两边公平，所以放两个中心对称的宝箱（正中 2×2 里斜对着的两格，一轮一共 600 金）；
//   这两格被墙、水、资源点挡住时（约一成的随机地图），在离正中最近、中心对称的一对格子放
// - 上一个宝箱还在（没被打掉）就不刷新，不叠加
// - 刷新那一刻宝箱的格子被玩家的单位（或者建筑）占着：这一方直接捡到宝箱、马上得金子，宝箱不刷出来（D-205，用户：占位的直接给
//   占位的一方，方便写抢箱子的打法）；一格只站得下一个，不会有两方同时占着。站着野怪就等它走开再刷
// - D-207（第八轮试写）：每个格子每轮只结算一次（原来一格站着野怪在等、另一格站着玩家的单位时，每 tick 都给一次 300 金）；
//   每一方每轮最多直接捡一个（先到的一方两个通吃，188 次刷新里 55% 被一方包圆）：同一方两格都站着，捡格子顺序在前的那个，
//   另一格等它走开再刷出来，要打
// - 打掉和捡到都放一个画面特效（ctx.effect）
import type { RuleContext, SetupContext, TypeSpec } from "../../src/core/types.ts"
import { STANDARD_TERRAIN } from "./standard.ts"

/** 一轮宝箱一共多少金（两个宝箱各一半） */
export const TREASURE_GOLD = 600
/** 每隔多少 tick 刷新（和野怪的定时刷新同一时刻） */
export const TREASURE_EVERY = 900

export function treasureType(): TypeSpec {
  return {
    kind: "building",
    w: 1,
    h: 1,
    maxHp: 300,
    look: { shape: "square", label: "宝", color: "#e0b53a", name: "宝箱" },
  }
}

// 一局的状态（setup 时重置）
let spots: { x: number; y: number }[] = []
/** 这一轮还没结算的格子（下标）；捡到或者刷出来就去掉 */
let todo: number[] = []
/** 这一轮已经直接捡过的玩家 */
let took = new Set<number>()
let opened: number[] = []
let gold: number[] = []

/** 每个宝箱值多少金 */
function each(): number {
  return TREASURE_GOLD / Math.max(1, spots.length)
}

/** 摆宝箱的位置：正中 2×2 里斜对着的两格（中心对称）；被挡住就找离正中最近、中心对称的一对格子 */
export function setupTreasure(ctx: SetupContext, W: number, H: number): void {
  spots = []
  todo = []
  took = new Set()
  opened = []
  gold = []
  const ents = ctx.entities()
  const free = (x: number, y: number) =>
    x >= 0 &&
    y >= 0 &&
    x < W &&
    y < H &&
    STANDARD_TERRAIN[ctx.terrain[y][x]]?.walkable === true &&
    !ents.some((e) => e.def.kind !== "unit" && x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h)
  const cx = W / 2 - 1
  const cy = H / 2 - 1
  // (x, y) 和它的中心对称 (W - 1 - x, H - 1 - y)，离正中由近到远找
  for (let r = 0; r <= 12 && spots.length === 0; r++)
    for (let dy = -r; dy <= r && spots.length === 0; dy++)
      for (const dx of r === Math.abs(dy) ? [0] : [r - Math.abs(dy), -(r - Math.abs(dy))]) {
        const x = cx + dx
        const y = cy + dy
        const mx = W - 1 - x
        const my = H - 1 - y
        if (x === mx && y === my) continue
        if (free(x, y) && free(mx, my)) {
          spots = [{ x, y }, { x: mx, y: my }]
          break
        }
      }
}

/** 每 tick：发宝箱的金子；到了刷新时刻把空着的位置补上宝箱（被这一轮还没捡过的玩家占着就直接归它，不然等下一 tick） */
export function treasureTick(ctx: RuleContext): void {
  for (const ev of ctx.events) {
    if (ev.kind !== "died" || ev.type !== "treasure" || ev.killer < 0) continue
    const n = give(ctx, ev.killer, { x: ev.x, y: ev.y })
    ctx.note(`P${ev.killer} 打开了中央宝箱，得 ${n} 金`)
  }
  if (ctx.tick > 0 && ctx.tick % TREASURE_EVERY === 0) {
    // 新的一轮：宝箱还在的格子不刷
    todo = spots.map((_, i) => i).filter((i) => !ctx.entitiesIn(spots[i].x, spots[i].y, 1, 1).some((e) => e.type === "treasure"))
    took = new Set()
  }
  if (todo.length === 0) return
  let spawned = 0
  todo = todo.filter((i) => {
    const s = spots[i]
    const here = ctx.entitiesIn(s.x, s.y, 1, 1)
    const who = here.find((e) => e.owner >= 0)
    if (who && !took.has(who.owner)) {
      took.add(who.owner)
      const n = give(ctx, who.owner, s)
      ctx.note(`P${who.owner} 的 ${who.type} #${who.id} 占住了 (${s.x}, ${s.y}) 的宝箱格子，直接捡到宝箱，得 ${n} 金`)
      return false
    }
    // 站着野怪、或者这一轮已经捡过一个的玩家：等它走开
    if (here.length) return true
    if (ctx.spawnNear("treasure", -1, s.x, s.y) === null) return true
    spawned++
    return false
  })
  if (spawned) ctx.note("地图正中刷出了宝箱")
}

/** 把一个宝箱的金子给玩家 p（打掉或者占位捡到），记统计，在宝箱的位置放特效；返回给了多少 */
function give(ctx: RuleContext, p: number, at: { x: number; y: number }): number {
  const n = each()
  ctx.addResource(p, "gold", n)
  opened[p] = (opened[p] ?? 0) + 1
  gold[p] = (gold[p] ?? 0) + n
  ctx.effect({ x: at.x, y: at.y, text: `P${p} +${n}`, color: "#f2c14e" })
  return n
}

/** 给 bot 看的宝箱信息（位置公开，和金矿一样） */
export interface TreasureInfo {
  /** 现在在场的宝箱（位置、剩余生命、打掉得多少金） */
  chests: { x: number; y: number; hp: number; gold: number }[]
  /** 宝箱的两个位置（中心对称），在不在场都列出来 */
  spots: { x: number; y: number }[]
  /** 下一次刷新在第几 tick（900 的整数倍） */
  nextAt: number
}

export function treasureInfo(ctx: RuleContext): TreasureInfo {
  const chests = ctx.entities({ type: "treasure" }).map((e) => ({ x: e.x, y: e.y, hp: e.hp, gold: each() }))
  return { chests, spots: spots.map((s) => ({ ...s })), nextAt: (Math.floor(ctx.tick / TREASURE_EVERY) + 1) * TREASURE_EVERY }
}

/** 每个玩家打开了几个宝箱、拿了多少金（对局结果的 stats 用） */
export function treasureStats(n: number): Record<string, number[]> {
  return { 打开宝箱: Array.from({ length: n }, (_, i) => opened[i] ?? 0), 宝箱金子: Array.from({ length: n }, (_, i) => gold[i] ?? 0) }
}
