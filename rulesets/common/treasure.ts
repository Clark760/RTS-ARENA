// 中央宝箱（D-202，弑君歼灭用）：每 900 tick（和野怪刷新同一时刻）在地图正中刷一个中立宝箱，
// 600 血、不会动、不会还手，打掉它（最后一击）的玩家马上得 600 金。不算击杀价值。
// 用户：希望大模型更灵活地去打仗而不是龟缩——后半局家门口的矿采完以后，有一个必须出门去抢的目标。
// （原来打算在正中刷金矿，算下来工人从正中走回主基地交货一趟 200 tick 出头、只带 5 金，10 个工人采完 600 金要 2700 tick，没人会去抢）
// - 正中那块 2×2（宽高都是偶数的地图，正中 2×2 刚好中心对称）被墙、水、资源点挡住时（约一成的随机地图），
//   改在离正中最近、中心对称的两处各放一个，各值一半
// - 上一个宝箱还在（没被打掉）就不刷新，不叠加
// - 刷新那一刻宝箱的位置（2×2）上站着玩家的单位：只有一方的，这一方直接捡到宝箱、马上得金子，宝箱不刷出来；
//   双方都有，单位多的一方捡到；一样多就把单位挤到旁边，照常刷出宝箱（D-205，用户：占位的直接给占位的一方，方便写抢箱子的打法）。
//   野怪站在上面就挤开。打掉和捡到都放一个画面特效（ctx.effect）
import type { RuleContext, SetupContext, TypeSpec } from "../../src/core/types.ts"
import { STANDARD_TERRAIN } from "./standard.ts"

/** 打掉一轮宝箱一共得多少金（两处各放一个时各一半） */
export const TREASURE_GOLD = 600
/** 每隔多少 tick 刷新（和野怪的定时刷新同一时刻） */
export const TREASURE_EVERY = 900

export function treasureType(): TypeSpec {
  return {
    kind: "building",
    w: 2,
    h: 2,
    maxHp: 600,
    look: { shape: "square", label: "宝", color: "#e0b53a", name: "宝箱" },
  }
}

// 一局的状态（setup 时重置）
let spots: { x: number; y: number }[] = []
let pending = false
let opened: number[] = []
let gold: number[] = []

/** 摆宝箱的位置：正中 2×2 能放就放一个；不然找离正中最近、中心对称的一对 2×2 */
export function setupTreasure(ctx: SetupContext, W: number, H: number): void {
  spots = []
  pending = false
  opened = []
  gold = []
  const ents = ctx.entities()
  const free = (x: number, y: number) => {
    for (let yy = y; yy < y + 2; yy++)
      for (let xx = x; xx < x + 2; xx++) {
        if (xx < 0 || yy < 0 || xx >= W || yy >= H || STANDARD_TERRAIN[ctx.terrain[yy][xx]]?.walkable !== true) return false
        if (ents.some((e) => e.def.kind !== "unit" && xx >= e.x && xx < e.x + e.w && yy >= e.y && yy < e.y + e.h)) return false
      }
    return true
  }
  const cx = W / 2 - 1
  const cy = H / 2 - 1
  if (free(cx, cy)) {
    spots = [{ x: cx, y: cy }]
    return
  }
  // 离正中由近到远找一对：(x, y) 和它的中心对称 (W - 2 - x, H - 2 - y)，两块不重叠
  for (let r = 1; r <= 12 && spots.length === 0; r++)
    for (let dy = -r; dy <= r && spots.length === 0; dy++)
      for (const dx of [r - Math.abs(dy), -(r - Math.abs(dy))]) {
        const x = cx + dx
        const y = cy + dy
        const mx = W - 2 - x
        const my = H - 2 - y
        if (Math.abs(x - mx) < 2 && Math.abs(y - my) < 2) continue
        if (free(x, y) && free(mx, my)) {
          spots = [{ x, y }, { x: mx, y: my }]
          break
        }
      }
}

/** 每 tick：发赏金；到了刷新时刻把空着的位置补上宝箱（位置上站着单位就等下一 tick） */
export function treasureTick(ctx: RuleContext): void {
  for (const ev of ctx.events) {
    if (ev.kind !== "died" || ev.type !== "treasure" || ev.killer < 0) continue
    const n = give(ctx, ev.killer, { x: ev.x, y: ev.y })
    ctx.note(`P${ev.killer} 打开了中央宝箱，得 ${n} 金`)
  }
  if (ctx.tick > 0 && ctx.tick % TREASURE_EVERY === 0) pending = true
  if (!pending) return
  let waiting = false
  let spawned = 0
  for (const s of spots) {
    let here = ctx.entitiesIn(s.x, s.y, 2, 2)
    if (here.some((e) => e.type === "treasure")) continue
    // 占着位置的玩家：只有一方，或者一方单位比另一方多，就直接捡到
    const count = new Map<number, number>()
    for (const u of here) if (u.owner >= 0) count.set(u.owner, (count.get(u.owner) ?? 0) + 1)
    const ranked = [...count].sort((a, b) => b[1] - a[1])
    if (ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1])) {
      const p = ranked[0][0]
      const n = give(ctx, p, s)
      ctx.note(`P${p} 占住了宝箱的位置，直接捡到宝箱，得 ${n} 金`)
      continue
    }
    // 一样多（或者只有野怪）：挤到旁边最近的空格，照常刷出宝箱
    for (const u of here) if (u.def.kind === "unit") nudge(ctx, u, s)
    here = ctx.entitiesIn(s.x, s.y, 2, 2)
    if (here.length) {
      waiting = true
      continue
    }
    if (ctx.spawnNear("treasure", -1, s.x, s.y) !== null) spawned++
  }
  if (!waiting) pending = false
  if (spawned) ctx.note("地图正中刷出了宝箱")
}

/** 把一个宝箱的金子给玩家 p（打掉或者占位捡到），记统计，在宝箱的位置放特效；返回给了多少 */
function give(ctx: RuleContext, p: number, at: { x: number; y: number }): number {
  const n = TREASURE_GOLD / Math.max(1, spots.length)
  ctx.addResource(p, "gold", n)
  opened[p] = (opened[p] ?? 0) + 1
  gold[p] = (gold[p] ?? 0) + n
  ctx.effect({ x: at.x, y: at.y, w: 2, h: 2, text: `P${p} +${n}`, color: "#f2c14e" })
  return n
}

/** 把站在宝箱位置上的单位挪到 2×2 外面最近的空格（地形能走、没有实体）；附近都满了就不动（等下一 tick） */
function nudge(ctx: RuleContext, u: { id: number; x: number; y: number }, s: { x: number; y: number }): void {
  const inside = (x: number, y: number) => x >= s.x && x < s.x + 2 && y >= s.y && y < s.y + 2
  for (let r = 1; r <= 6; r++)
    for (let dy = -r; dy <= r; dy++)
      for (const dx of [r - Math.abs(dy), -(r - Math.abs(dy))]) {
        const x = u.x + dx
        const y = u.y + dy
        if (inside(x, y) || x < 0 || y < 0 || x >= ctx.width || y >= ctx.height) continue
        if (STANDARD_TERRAIN[ctx.terrain[y][x]]?.walkable !== true || ctx.entitiesIn(x, y, 1, 1).length) continue
        ctx.teleport(u.id, x, y)
        return
      }
}

/** 给 bot 看的宝箱信息（位置公开，和金矿一样） */
export interface TreasureInfo {
  /** 现在在场的宝箱（左上角、剩余生命、打掉得多少金） */
  chests: { x: number; y: number; hp: number; gold: number }[]
  /** 宝箱的位置（正中一个，或者中心对称的两个），在不在场都列出来 */
  spots: { x: number; y: number }[]
  /** 下一次刷新在第几 tick（900 的整数倍） */
  nextAt: number
}

export function treasureInfo(ctx: RuleContext): TreasureInfo {
  const chests = ctx.entities({ type: "treasure" }).map((e) => ({ x: e.x, y: e.y, hp: e.hp, gold: TREASURE_GOLD / Math.max(1, spots.length) }))
  return { chests, spots: spots.map((s) => ({ ...s })), nextAt: (Math.floor(ctx.tick / TREASURE_EVERY) + 1) * TREASURE_EVERY }
}

/** 每个玩家打开了几个宝箱、拿了多少金（对局结果的 stats 用） */
export function treasureStats(n: number): Record<string, number[]> {
  return { 打开宝箱: Array.from({ length: n }, (_, i) => opened[i] ?? 0), 宝箱金子: Array.from({ length: n }, (_, i) => gold[i] ?? 0) }
}
