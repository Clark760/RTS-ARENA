// 规则包「牧野争牛」：荒原上有野牛游荡，围住它就能驯服；把驯服的牛赶到自己建在草场上的牧栏边就持续得分。
// 别人的牛也能偷；狼群定时从狼穴出来，冲着领先的队伍去。先攒够分数的队伍赢。玩法说明见 RULES.md。
import type { MatchResult, Marker, RuleContext, RuleEntity, Ruleset, TypeSpec } from "../../src/core/types.ts"
import { cornersFor, rotateK, rotationalTerrain, STANDARD_TERRAIN, standardTypes } from "../common/standard.ts"
import type { Objectives, Rect } from "./objectives.ts"

const S = 40
const PER_PLAYER_TARGET = 400
const SCORE_EVERY = 10
const PEN_RADIUS = 2
const PEN_CAP = 4
const TAME_EVERY = 10
const WOLF_FIRST = 800
const WOLF_EVERY = 500
const WOLF_BOUNTY = 25
const BISON_RESPAWN = 200

const WILD: Rect = { x: 15, y: 15, w: 10, h: 10 }
const DEN: Rect = { x: 19, y: 19, w: 2, h: 2 }
const PASTURES: Rect[] = []
for (let k = 0; k < 4; k++) PASTURES.push(rotateK(S, { x: 10, y: 10, w: 4, h: 4 }, k))
for (let k = 0; k < 4; k++) PASTURES.push(rotateK(S, { x: 18, y: 2, w: 4, h: 4 }, k))

const types: Record<string, TypeSpec> = {
  ...standardTypes(),
  pen: { kind: "building", w: 2, h: 2, maxHp: 500, cost: { gold: 100 }, buildTicks: 80, sight: 4, look: { shape: "hex", label: "栏" } },
  bison: { kind: "unit", maxHp: 160, moveTicks: 4, sight: 4, attack: { damage: 6, range: 1, cooldown: 10 }, look: { shape: "circle", label: "牛" } },
  wolf: {
    kind: "unit",
    maxHp: 90,
    moveTicks: 3,
    sight: 6,
    attack: { damage: 9, range: 1, cooldown: 8 },
    look: { shape: "triangle", label: "狼", color: "#a33b2b" },
  },
}
types.worker.builds = ["barracks", "pen"]

// 一个角（左上，转 0 次）的开局，别的角转 90° 的倍数
const CORNER: { type: string; x: number; y: number; amount?: number }[] = [
  { type: "base", x: 3, y: 3 },
  { type: "barracks", x: 9, y: 4 },
  { type: "worker", x: 7, y: 3 },
  { type: "worker", x: 7, y: 4 },
  { type: "worker", x: 7, y: 5 },
  { type: "worker", x: 3, y: 7 },
  { type: "goldmine", x: 1, y: 9 },
  { type: "goldmine", x: 3, y: 9 },
  { type: "goldmine", x: 5, y: 9 },
  { type: "goldmine", x: 9, y: 1 },
]

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}
function inside(a: Rect, outer: Rect): boolean {
  return a.x >= outer.x && a.y >= outer.y && a.x + a.w <= outer.x + outer.w && a.y + a.h <= outer.y + outer.h
}

// ---------- 每局状态（沙箱里每局重新加载；平台测试里直接跑时靠 setup 开头的 resetState） ----------
let nextWolves = WOLF_FIRST
let lastMarkerKey = ""
// 统计（结束时放进结果的 stats，联赛和战报会列出来）：每人驯服几头、偷到几头、被偷几头、打死几只狼、拿了多少赏金
const stat = { tamed: [0, 0, 0, 0], stolen: [0, 0, 0, 0], lost: [0, 0, 0, 0], wolves: [0, 0, 0, 0], bounty: [0, 0, 0, 0] }
let lastTamedKey = ""
let lastTamedMarkers: Marker[] = []

function resetState(): void {
  nextWolves = WOLF_FIRST
  lastMarkerKey = ""
  for (const a of [stat.tamed, stat.stolen, stat.lost, stat.wolves, stat.bounty]) a.fill(0)
  lastTamedKey = ""
  lastTamedMarkers = []
}

interface TeamInfo {
  team: number
  members: number[]
  score: number
  target: number
}

function teamList(ctx: RuleContext): TeamInfo[] {
  const map = new Map<number, TeamInfo>()
  for (const p of ctx.players) {
    const t = ctx.teams[p.id]
    let info = map.get(t)
    if (!info) {
      info = { team: t, members: [], score: 0, target: 0 }
      map.set(t, info)
    }
    info.members.push(p.id)
    info.score += p.score
  }
  const list = [...map.values()].sort((a, b) => a.team - b.team)
  for (const t of list) t.target = PER_PLAYER_TARGET * t.members.length
  return list
}

/** 领先的队伍（按 分数/目标 比，唯一最高且大于 0），没有为 null */
function leader(ctx: RuleContext): number | null {
  const ts = teamList(ctx)
  let best: TeamInfo | null = null
  let tie = false
  for (const t of ts) {
    const r = t.score / t.target
    if (!best || r > best.score / best.target) {
      best = t
      tie = false
    } else if (r === best.score / best.target) tie = true
  }
  if (!best || tie || best.score <= 0) return null
  return best.team
}

function pastureHolders(ctx: RuleContext): (number | null)[] {
  return PASTURES.map((r) => {
    const pen = ctx.entitiesIn(r.x, r.y, r.w, r.h).find((e) => e.type === "pen" && e.owner >= 0)
    return pen ? ctx.teams[pen.owner] : null
  })
}

function penOwnerOn(ctx: RuleContext, r: Rect): number | null {
  const pen = ctx.entitiesIn(r.x, r.y, r.w, r.h).find((e) => e.type === "pen" && e.owner >= 0)
  return pen ? pen.owner : null
}

function randomIn(ctx: RuleContext, r: Rect): { x: number; y: number } {
  return { x: r.x + ctx.rng.int(r.w), y: r.y + ctx.rng.int(r.h) }
}

function finish(ctx: RuleContext, why: string): MatchResult {
  const n = ctx.playerCount
  const stats = { 驯服: stat.tamed.slice(0, n), 偷到: stat.stolen.slice(0, n), 被偷: stat.lost.slice(0, n), 杀狼: stat.wolves.slice(0, n), 赏金: stat.bounty.slice(0, n) }
  const ts = teamList(ctx)
  const ratio = (t: TeamInfo) => t.score / t.target
  const sorted = [...ts].sort((a, b) => ratio(b) - ratio(a))
  const ranking: number[][] = []
  let prev = -1
  for (const t of sorted) {
    if (ranking.length > 0 && ratio(t) === prev) ranking[ranking.length - 1].push(...t.members)
    else ranking.push([...t.members])
    prev = ratio(t)
  }
  const top = sorted.filter((t) => ratio(t) === ratio(sorted[0]))
  const scoreText = ts.map((t) => `${t.members.map((m) => `P${m}`).join("+")} ${t.score}/${t.target}`).join(" : ")
  if (top.length > 1) return { winner: null, reason: `${why}，并列第一（${scoreText}）`, ranking, stats }
  const win = top[0]
  return { winner: win.members[0], winners: [...win.members], reason: `${why}（${scoreText}）`, ranking, stats }
}

// ---------- 每 tick 的规则 ----------

function tame(ctx: RuleContext, bisons: readonly RuleEntity[]): void {
  for (const b of bisons) {
    const near = ctx.entitiesIn(b.x - 1, b.y - 1, 3, 3)
    const byTeam = new Map<number, number>()
    const byPlayer = new Map<number, number>()
    for (const e of near) {
      if (e.id === b.id || e.owner < 0 || e.def.kind !== "unit" || e.type === "bison") continue
      const t = ctx.teams[e.owner]
      byTeam.set(t, (byTeam.get(t) ?? 0) + 1)
      byPlayer.set(e.owner, (byPlayer.get(e.owner) ?? 0) + 1)
    }
    if (byTeam.size === 0) continue
    const ownTeam = b.owner >= 0 ? ctx.teams[b.owner] : -999
    if (b.owner >= 0 && (byTeam.get(ownTeam) ?? 0) > 0) continue // 有自己人守着偷不走
    let bestTeam = -1
    let bestN = 0
    let tie = false
    for (const [t, n] of byTeam) {
      if (t === ownTeam) continue
      if (n > bestN) {
        bestTeam = t
        bestN = n
        tie = false
      } else if (n === bestN) tie = true
    }
    if (bestN < 2 || tie) continue
    let who = -1
    let whoN = 0
    for (const [p, n] of byPlayer) {
      if (ctx.teams[p] !== bestTeam) continue
      if (n > whoN || (n === whoN && p < who)) {
        who = p
        whoN = n
      }
    }
    if (b.owner === -1) stat.tamed[who]++
    else {
      stat.stolen[who]++
      stat.lost[b.owner]++
    }
    ctx.setOwner(b.id, who)
  }
}

function score(ctx: RuleContext, bisons: readonly RuleEntity[]): void {
  const pens = ctx.entities({ type: "pen" }).filter((p) => p.construction === null && p.owner >= 0)
  for (let p = 0; p < ctx.playerCount; p++) {
    const mine = bisons.filter((b) => b.owner === p)
    if (mine.length === 0) continue
    const used = new Set<number>()
    for (const pen of pens) {
      if (pen.owner !== p) continue
      let c = 0
      for (const b of mine) {
        if (c >= PEN_CAP) break
        if (used.has(b.id)) continue
        if (ctx.dist(b, pen) <= PEN_RADIUS) {
          used.add(b.id)
          c++
        }
      }
    }
    if (used.size > 0) ctx.addScore(p, used.size)
  }
}

function wander(ctx: RuleContext, bisons: readonly RuleEntity[]): void {
  for (const b of bisons) {
    if (b.owner !== -1) continue
    const near = ctx.entitiesIn(b.x - 3, b.y - 3, 7, 7).some((e) => e.owner >= 0 && e.def.kind === "unit")
    if (near) {
      if (b.order.kind === "move") ctx.orderNeutral(b.id, { kind: "stop" }) // 有人靠近就站住迎战
      continue
    }
    const outside = !inside({ x: b.x, y: b.y, w: 1, h: 1 }, WILD)
    if ((b.order.kind === "idle" && ctx.rng.int(6) === 0) || (outside && b.order.kind === "idle")) {
      const to = randomIn(ctx, WILD)
      ctx.orderNeutral(b.id, { kind: "move", x: to.x, y: to.y })
    }
  }
}

/** 狼的目标点：领先队伍离狼最近的牧栏；没有领先的队伍就找最近的牧栏；没有牧栏就找领先队伍的主基地，再没有就最近的玩家实体 */
function wolfGoal(ctx: RuleContext, wolf: Rect, lead: number | null): { x: number; y: number } | null {
  const pens = ctx.entities({ type: "pen" }).filter((p) => p.owner >= 0 && (lead === null || ctx.teams[p.owner] === lead))
  let pool: readonly RuleEntity[] = pens
  if (pool.length === 0 && lead !== null) pool = ctx.entities({ type: "base" }).filter((b) => b.owner >= 0 && ctx.teams[b.owner] === lead)
  if (pool.length === 0) pool = ctx.entities({ kind: "building" }).filter((b) => b.owner >= 0)
  let best: RuleEntity | null = null
  let bd = Infinity
  for (const e of pool) {
    const d = ctx.dist(wolf, e)
    if (d < bd) {
      bd = d
      best = e
    }
  }
  return best ? { x: best.x, y: best.y } : null
}

function wolves(ctx: RuleContext): void {
  const lead = leader(ctx)
  if (ctx.tick >= nextWolves) {
    nextWolves += WOLF_EVERY
    const alive = ctx.entities({ type: "wolf" }).length
    const cap = 3 + 2 * ctx.playerCount
    const wave = Math.min(2 + Math.floor(ctx.tick / 2000) + (ctx.playerCount > 2 ? 1 : 0), cap - alive)
    for (let i = 0; i < wave; i++) {
      const id = ctx.spawnNear("wolf", -1, DEN.x, DEN.y)
      const w = DEN
      const g = w ? wolfGoal(ctx, w, lead) : null
      // 先一路跑过去（途中不打），到了停下后再由下面的 attackMove 找人咬
      if (id !== null && g) ctx.orderNeutral(id, { kind: "move", x: g.x, y: g.y })
    }
  }
  if (ctx.tick % 20 !== 0) return
  for (const w of ctx.entities({ type: "wolf" })) {
    if (w.order.kind !== "idle") continue
    const g = wolfGoal(ctx, w, lead)
    if (g) ctx.orderNeutral(w.id, { kind: "attackMove", x: g.x, y: g.y })
  }
}

function markers(ctx: RuleContext): void {
  const owners = PASTURES.map((r) => penOwnerOn(ctx, r))
  // 回放不记录实体换主人，驯服的牛在回放里还是灰色：每 10 tick 在它脚下画一格主人颜色的区域
  const tamed = ctx.tick % 10 === 0 ? ctx.entities({ type: "bison" }).filter((b) => b.owner >= 0) : null
  const tamedKey = tamed ? tamed.map((b) => `${b.owner}@${b.x},${b.y}`).join(";") : lastTamedKey
  const key = owners.join(",") + "|" + tamedKey
  if (key === lastMarkerKey) return
  lastTamedKey = tamedKey
  lastTamedMarkers = tamed ? tamed.map((b) => ({ kind: "zone", x: b.x, y: b.y, w: 1, h: 1, owner: b.owner }) as Marker) : lastTamedMarkers
  lastMarkerKey = key
  const ms: Marker[] = [
    { kind: "zone", ...WILD, owner: null, label: "荒原", color: "#8d6e63" },
    { kind: "zone", ...DEN, owner: null, label: "狼穴", color: "#b71c1c" },
  ]
  PASTURES.forEach((r, i) => {
    const o = owners[i]
    if (o === null) ms.push({ kind: "zone", ...r, owner: null, label: "草场", color: "#7cb342" })
    else ms.push({ kind: "zone", ...r, owner: o, label: `草场·${ctx.teams[o]}队` })
  })
  ms.push(...lastTamedMarkers)
  ctx.setMarkers(ms)
}

const ruleset: Ruleset = {
  id: "wild-herd",
  name: "牧野争牛",
  summary: "驯服荒原上游荡的野牛赶回牧栏得分，可以偷别人的牛，狼群专冲领先的队",
  players: { min: 2, max: 4 },
  teams: true,
  maxTicks: 6000,
  tickRate: 20,
  decisionInterval: 5,
  fuel: 200,
  unitCap: 40,
  fog: true,
  resources: ["gold"],
  terrain: STANDARD_TERRAIN,
  types,

  setup(ctx) {
    resetState()
    ctx.setTerrain(
      rotationalTerrain(S, ".", [
        { ch: "#", x: 16, y: 8, w: 2, h: 3 },
        { ch: "~", x: 6, y: 15, w: 2, h: 2 },
      ]),
    )
    // 按队伍排好再分角：同队的坐相邻的角（2v2 是上边两角对下边两角）
    const order = [...Array(ctx.playerCount).keys()].sort((a, b) => ctx.teams[a] - ctx.teams[b] || a - b)
    const corners = cornersFor(ctx.playerCount)
    order.forEach((p, i) => {
      const k = corners[i]
      for (const it of CORNER) {
        const spec = types[it.type]
        const r = rotateK(S, { x: it.x, y: it.y, w: spec.w ?? 1, h: spec.h ?? 1 }, k)
        ctx.spawn(it.type, it.type === "goldmine" ? -1 : p, r.x, r.y, { amount: it.amount })
      }
      ctx.setResources(p, { gold: 150 })
    })
    // 野牛：荒原左上四分之一里随机挑 ceil((2×人数+2)/4) 个位置，再转 90° 的倍数铺满四个象限（四重对称，对每个角都公平）
    const used = new Set<string>()
    // 3 人局空着的那个角对应的象限不放牛（不然它两边的玩家近水楼台，夹在中间的玩家吃亏）
    const quads = ctx.playerCount === 3 ? corners : [0, 1, 2, 3]
    const per = ctx.playerCount === 3 ? 2 : Math.ceil((2 * ctx.playerCount + 2) / 4)
    let placed = 0
    for (let tries = 0; placed < per && tries < 500; tries++) {
      const x = WILD.x + ctx.rng.int(WILD.w / 2)
      const y = WILD.y + ctx.rng.int(WILD.h / 2)
      const k = `${x},${y}`
      if (used.has(k) || overlaps({ x, y, w: 1, h: 1 }, DEN)) continue
      used.add(k)
      for (const r of quads) {
        const p = rotateK(S, { x, y, w: 1, h: 1 }, r)
        ctx.spawn("bison", -1, p.x, p.y)
      }
      placed++
    }
    ctx.setStatus("野牛在荒原游荡，围住它（周围 8 格里同队 2 个单位）就能驯服")
  },

  onTick(ctx) {
    for (const ev of ctx.events) {
      // 赏金只给不是狼群目标的队伍（领先的队伍打狼没钱拿）
      if (ev.kind === "died" && ev.type === "wolf" && ev.killer >= 0) {
        stat.wolves[ev.killer]++
        if (ctx.teams[ev.killer] !== leader(ctx)) {
          ctx.addResource(ev.killer, "gold", WOLF_BOUNTY)
          stat.bounty[ev.killer] += WOLF_BOUNTY
        }
      }
    }
    const bisons = ctx.entities({ type: "bison" })
    if (ctx.tick % TAME_EVERY === 0) tame(ctx, bisons)
    if (ctx.tick % SCORE_EVERY === 0) score(ctx, ctx.entities({ type: "bison" }))
    if (ctx.tick % 10 === 5) wander(ctx, bisons)
    wolves(ctx)
    // 荒原补牛：野牛少于 人数+1 头、全图的牛少于 4×人数+2 头时补一头
    const wildCount = bisons.filter((b) => b.owner === -1).length
    if (ctx.tick % BISON_RESPAWN === 0 && wildCount < ctx.playerCount + 1 && bisons.length < 4 * ctx.playerCount + 2) {
      const c = ctx.rng.int(4) // 从正中间 2×2 的随机一格补，离每个角一样远
      ctx.spawnNear("bison", -1, S / 2 - 1 + (c % 2), S / 2 - 1 + Math.floor(c / 2))
    }
    markers(ctx)
    if (ctx.tick % 10 === 0) {
      const ts = teamList(ctx)
      const lead = leader(ctx)
      ctx.setStatus(
        `${ts.map((t) => `${t.team}队 ${t.score}/${t.target}`).join(" : ")} · 下一波狼 ${nextWolves}` +
          (lead === null ? "" : ` · 狼盯着 ${lead}队`),
      )
    }
  },

  objectives(ctx, player): Objectives {
    const holders = pastureHolders(ctx)
    return {
      scoreEvery: SCORE_EVERY,
      penRadius: PEN_RADIUS,
      penCapacity: PEN_CAP,
      tameEvery: TAME_EVERY,
      teams: teamList(ctx),
      pastures: PASTURES.map((r, i) => ({ ...r, holder: holders[i] })),
      wild: WILD,
      den: DEN,
      bison: ctx.entities({ type: "bison" }).map((b) => ({ id: b.id, x: b.x, y: b.y, owner: b.owner, hp: b.hp })),
      wolves: ctx.entities({ type: "wolf" }).map((w) => ({ id: w.id, x: w.x, y: w.y })),
      nextWolves,
      wolfTarget: leader(ctx),
      wolfBounty: WOLF_BOUNTY,
    }
  },

  buildCheck(ctx, player, type, x, y) {
    const spec = types[type]
    const r = { x, y, w: spec.w ?? 1, h: spec.h ?? 1 }
    if (type === "pen") {
      const p = PASTURES.find((q) => inside(r, q))
      if (!p) return "牧栏只能整块建在草场里（见 objectives.pastures）"
      const other = ctx.entitiesIn(p.x, p.y, p.w, p.h).find((e) => e.type === "pen" && e.owner >= 0 && !ctx.isAlly(e.owner, player))
      if (other) return `这块草场上已经有别的队伍（玩家 ${other.owner}）的牧栏，拆掉它才能建`
      return null
    }
    if (PASTURES.some((q) => overlaps(r, q))) return "草场上只能建牧栏"
    return null
  },

  result(ctx) {
    const done = teamList(ctx).filter((t) => t.score >= t.target)
    if (done.length === 0) return null
    return finish(ctx, "先攒够分数")
  },

  timeUp(ctx) {
    return finish(ctx, "时间到，比分数")
  },
}

export default ruleset
