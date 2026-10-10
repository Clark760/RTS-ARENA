// 弑君（D-187）：歼灭、拓荒的基础上，开局每家送 1 个领主（lord）。主基地被拆或者领主阵亡都判负。
// 领主用的是平台的技能、光环、被动（D-186）：
// - 光环「领主光环」：视野（8 格）内自己的战士、弓手打出的伤害 +20%、受到的伤害 −20%（D-188：试写反馈光环太强，25% 降到 20%）
// - 被动「休养生息」：100 tick 没出手、没挨打以后，每 10 tick 回 10 生命
// - 技能「点金」（goldmine，弑君拓荒）：在领主 3 格内的空地上造一座 300 金的中立金矿，冷却 600 tick（落点见 mineSpot）
// - 技能「击退」（repel，弑君歼灭，D-197）：把领主视野内的敌方单位推到视野外，纯冷却 600 tick、不要钱（用户：想让两边打得更焦灼、时间更长）。
//   D-198 冷却 600 → 300。之前是召唤箭塔（D-192～196：500 金基本没用，降到 250 不亏不赚，兵营同时造 5 个以后没人放）
// 领主的移速、视野、攻击和克制规则包的侦察兵一样（走一格 1 tick、视野 8、攻击 1），生命 500（主基地 1500 的三分之一）
import type { CastInfo, MatchResult, RuleContext, SetupContext, TypeSpec } from "../../src/core/types.ts"
import { spawnMirrored, STANDARD_TERRAIN } from "./standard.ts"
import { creepStats } from "./creeps.ts"

/** 点金造出来的金矿储量 */
export const LORD_MINE_AMOUNT = 300
/** 点金的金矿最远放在离领主几格 */
export const LORD_MINE_RANGE = 3

/** 击退的冷却（tick）；D-198 用户：600 → 300，团战里能多放一次 */
export const LORD_REPEL_COOLDOWN = 300
/** 击退往外推的时候，最多沿路走几步去找落脚的空格（找不到就不推） */
const REPEL_SEARCH = 24

/** 领主的技能：点金（弑君拓荒）或者击退（弑君歼灭） */
export type LordSkill = "goldmine" | "repel"

/** 领主：troops 是光环加成的兵种，skill 是它的技能 */
export function lordType(troops: string[], skill: LordSkill = "goldmine"): TypeSpec {
  return {
    kind: "unit",
    maxHp: 500,
    moveTicks: 1,
    sight: 8,
    attack: { damage: 1, range: 1, cooldown: 10 },
    skills: [
      skill === "goldmine"
        ? { id: "goldmine", name: "点金", cooldown: 600, desc: `在领主 ${LORD_MINE_RANGE} 格内最近的空地上造一座 ${LORD_MINE_AMOUNT} 金的中立金矿（谁都能采）` }
        : {
            id: "repel",
            name: "击退",
            cooldown: LORD_REPEL_COOLDOWN,
            situational: true,
            desc: "把领主视野（8 格）内的敌方单位推到视野外（各自沿能走的路推到最近的空格，建筑和野怪不推）",
          },
    ],
    auras: [{ name: "领主光环", radius: -1, affects: "own", types: troops, damagePct: 20, defensePct: 20 }],
    passives: [{ kind: "regen", name: "休养生息", delay: 100, every: 10, amount: 10 }],
    look: { shape: "hex", label: "王", name: "领主" },
  }
}

/** 在单位表里加上领主（放在工人后面，单位表、图例按这个顺序列） */
export function withLord(types: Record<string, TypeSpec>, troops: string[], skill: LordSkill = "goldmine"): Record<string, TypeSpec> {
  const out: Record<string, TypeSpec> = {}
  for (const [k, v] of Object.entries(types)) {
    out[k] = v
    if (k === "worker") out.lord = lordType(troops, skill)
  }
  return out
}

/** 每家领主放成功几次技能（结果的 stats 用）；setup 时清零（规则包不进沙箱直接跑时顶层变量不会每局重新加载） */
let casts: Record<string, number[]> = {}

/** 结果的统计：野怪的击杀、赏金，加上领主放技能的次数（击退或点金） */
export function regicideStats(n: number): Record<string, number[]> {
  const out = creepStats(n)
  for (const [name, list] of Object.entries(casts)) out[name] = Array.from({ length: n }, (_, i) => list[i] ?? 0)
  return out
}

/** 开局每家 1 个领主：左上那家放在家里的角落 (1, 1)，右下那家放在中心对称的位置（歼灭、拓荒的开局这一格都空着） */
export function spawnLords(ctx: SetupContext, width: number, height: number, types: Record<string, TypeSpec>): void {
  casts = {}
  for (const k of types.lord?.skills ?? []) casts[k.name] = []
  spawnMirrored(ctx, width, height, types, [{ type: "lord", owner: 0, x: 1, y: 1 }])
}

/**
 * 点金的落点（D-188，试写反馈：原来按走路找空位，四周四格放满就拒绝，斜对角空着也不放；领主还能拿金矿把自己围死、近战打不到）：
 * 离领主曼哈顿距离 1～3 格里最近的空格（地形能走、没有任何实体，单位站着的也不算空）；同样近的选离地图中心近的（曼哈顿距离），再一样随机挑。
 * 放了以后领主要还能走到自家主基地旁边（只算地形、建筑和资源点挡路，单位不算），不然这一格不放（不能把领主或主基地的路堵死）
 */
export function mineSpot(ctx: RuleContext, lord: { x: number; y: number }, player: number): { x: number; y: number } | null {
  const W = ctx.width
  const H = ctx.height
  const { free, reachable } = placeCheck(ctx, lord, player)
  for (let d = 1; d <= LORD_MINE_RANGE; d++) {
    const ring: { x: number; y: number; c: number; r: number }[] = []
    for (let dx = -d; dx <= d; dx++)
      for (const dy of Math.abs(dx) === d ? [0] : [d - Math.abs(dx), -(d - Math.abs(dx))]) {
        const x = lord.x + dx
        const y = lord.y + dy
        if (x < 0 || y < 0 || x >= W || y >= H || !free[y * W + x]) continue
        ring.push({ x, y, c: Math.abs(2 * x - (W - 1)) + Math.abs(2 * y - (H - 1)), r: ctx.rng.next() })
      }
    ring.sort((a, b) => a.c - b.c || a.r - b.r)
    for (const s of ring) if (reachable(s.y * W + s.x)) return { x: s.x, y: s.y }
  }
  return null
}

/** 放金矿用的格子检查：free 是空着的格子（地形能走、没有任何实体）；reachable(格子) 是放上去以后领主还能走到自家主基地旁边 */
function placeCheck(ctx: RuleContext, lord: { x: number; y: number }, player: number): { free: Uint8Array; reachable: (cell: number) => boolean } {
  const W = ctx.width
  const H = ctx.height
  const open = new Uint8Array(W * H) // 地形能走、没有建筑和资源点
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) open[y * W + x] = STANDARD_TERRAIN[ctx.terrain[y][x]]?.walkable ? 1 : 0
  const free = open.slice() // 再去掉单位站着的
  for (const e of ctx.entities()) {
    for (let y = e.y; y < e.y + e.h; y++)
      for (let x = e.x; x < e.x + e.w; x++) {
        if (e.def.kind !== "unit") open[y * W + x] = 0
        free[y * W + x] = 0
      }
  }
  const base = ctx.entities({ owner: player, type: "base" })[0]
  // 领主到主基地旁边还走得通吗（mine 这格当成挡路）
  const reachable = (mine: number): boolean => {
    if (!base) return true
    const seen = new Uint8Array(W * H)
    const start = lord.y * W + lord.x
    const q = [start]
    seen[start] = 1
    for (let h = 0; h < q.length; h++) {
      const c = q[h]
      const x = c % W
      const y = (c - x) / W
      if (ctx.dist({ x, y, w: 1, h: 1 }, base) <= 1) return true
      for (const n of [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, y > 0 ? c - W : -1, y < H - 1 ? c + W : -1]) {
        if (n < 0 || seen[n] || !open[n] || n === mine) continue
        seen[n] = 1
        q.push(n)
      }
    }
    return false
  }
  return { free, reachable }
}

/** 点金：在领主 3 格内找空地放一座中立金矿，放不下就拒绝；击退：把视野里的敌方单位推出去，视野里没有敌方单位就拒绝（拒绝的不进冷却） */
export function regicideCast(ctx: RuleContext, c: CastInfo): string | null {
  const lord = ctx.get(c.unit)
  if (!lord) return "领主不在了"
  if (c.skill === "repel") {
    const pushed = repel(ctx, lord, c.player)
    if (pushed < 0) return `领主视野（${lord.def.sight} 格）里没有敌方单位，不用击退`
    ctx.note(`P${c.player} 的领主在 (${lord.x}, ${lord.y}) 击退了 ${pushed} 个敌方单位`, c.player)
    count("击退", c.player)
    return null
  }
  if (c.skill !== "goldmine") return `没有技能 ${c.skill}`
  const spot = mineSpot(ctx, lord, c.player)
  if (!spot) return `领主 ${LORD_MINE_RANGE} 格内没有能放金矿的空地（单位站着的格子不算空，也不能把领主到主基地的路堵死），换个地方再放`
  ctx.spawnNear("goldmine", -1, spot.x, spot.y, { amount: LORD_MINE_AMOUNT })
  ctx.note(`P${c.player} 的领主在 (${spot.x}, ${spot.y}) 点出一座金矿`, c.player)
  count("点金", c.player)
  return null
}

/**
 * 击退（D-197）：领主视野内（曼哈顿距离不超过视野）的敌方单位一个个往外推，先推离领主远的（免得挡住后面的）：
 * 从它站的格子沿能走的路（地形、建筑、资源点挡路，单位不挡）往外找，离它最近的、离领主超过视野的空格（没有任何实体，
 * 也没被这次推过去的占着）；同样近的选离领主远的，再一样随机挑。走 24 步（REPEL_SEARCH）都找不到（被墙堵死）就不推。
 * 返回推走了几个；视野里一个敌方单位都没有返回 -1
 */
export function repel(ctx: RuleContext, lord: { x: number; y: number; def: { sight: number } }, player: number): number {
  const W = ctx.width
  const H = ctx.height
  const R = lord.def.sight
  const foes = ctx
    .entities({ kind: "unit" })
    .filter((e) => e.owner >= 0 && e.owner !== player && !ctx.isAlly(e.owner, player) && Math.abs(e.x - lord.x) + Math.abs(e.y - lord.y) <= R)
  if (foes.length === 0) return -1
  const open = new Uint8Array(W * H) // 地形能走、没有建筑和资源点（推的路线）
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) open[y * W + x] = STANDARD_TERRAIN[ctx.terrain[y][x]]?.walkable ? 1 : 0
  const free = open.slice() // 再去掉单位站着的（落脚点）
  for (const e of ctx.entities())
    for (let y = e.y; y < e.y + e.h; y++)
      for (let x = e.x; x < e.x + e.w; x++) {
        if (e.def.kind !== "unit") open[y * W + x] = 0
        free[y * W + x] = 0
      }
  const far = (i: number) => Math.abs((i % W) - lord.x) + Math.abs(Math.floor(i / W) - lord.y)
  foes.sort((a, b) => far(b.y * W + b.x) - far(a.y * W + a.x))
  let moved = 0
  const seen = new Int32Array(W * H)
  let mark = 0
  for (const f of foes) {
    mark++
    let level = [f.y * W + f.x]
    seen[level[0]] = mark
    let spot = -1
    for (let step = 0; step < REPEL_SEARCH && level.length && spot < 0; step++) {
      const next: number[] = []
      for (const c of level) {
        const x = c % W
        for (const n of [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, c >= W ? c - W : -1, c < W * (H - 1) ? c + W : -1]) {
          if (n < 0 || seen[n] === mark || !open[n]) continue
          seen[n] = mark
          next.push(n)
        }
      }
      // 这一圈里能落脚的：离领主超过视野、空着；挑离领主最远的，一样远随机
      let best = -1
      let bestFar = -1
      let bestR = 0
      for (const n of next) {
        if (!free[n] || far(n) <= R) continue
        const r = ctx.rng.next()
        if (far(n) > bestFar || (far(n) === bestFar && r < bestR)) {
          best = n
          bestFar = far(n)
          bestR = r
        }
      }
      spot = best
      level = next
    }
    if (spot < 0) continue
    free[f.y * W + f.x] = 1
    free[spot] = 0
    ctx.teleport(f.id, spot % W, Math.floor(spot / W))
    moved++
  }
  return moved
}

function count(name: string, p: number): void {
  const list = (casts[name] ??= [])
  list[p] = (list[p] ?? 0) + 1
}

function baseHp(ctx: RuleContext, p: number): number {
  let hp = 0
  for (const e of ctx.entities({ owner: p, type: "base" })) hp += e.hp
  return hp
}

/** 主基地被拆或领主阵亡就出局；只剩一家时它赢，两家同一 tick 出局算平局 */
export function regicideResult(ctx: RuleContext): MatchResult | null {
  const why: string[] = []
  for (const p of ctx.players) {
    if (!p.alive) continue
    const noBase = baseHp(ctx, p.id) === 0
    const noLord = ctx.entities({ owner: p.id, type: "lord" }).length === 0
    if (!noBase && !noLord) continue
    ctx.eliminate(p.id)
    why[p.id] = noLord && noBase ? "击杀了对方的领主、摧毁了主基地" : noLord ? "击杀了对方的领主" : "摧毁了对方的主基地"
  }
  const alive = ctx.players.filter((p) => p.alive)
  if (alive.length === 1) return { winner: alive[0].id, reason: why.find((x) => x) ?? "对方出局", stats: regicideStats(ctx.playerCount) }
  if (alive.length === 0) return { winner: null, reason: "双方同一 tick 出局（领主阵亡或主基地被毁），平局", stats: regicideStats(ctx.playerCount) }
  return null
}
