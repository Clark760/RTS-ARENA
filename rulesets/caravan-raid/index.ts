// 规则包「劫镖」：四条商路上定时有中立商队带着镖师过境，劫下商队、押回自己的主基地或货栈交货得分。
// 队伍分数先到目标的队伍赢；主基地被摧毁的玩家出局，一队全出局就输。写法见 RULESET.md。
import type { Marker, Rect, RuleContext, Ruleset, TypeSpec } from "../../src/core/types.ts"
import {
  cornersFor,
  randomSymmetricMap,
  rotateK,
  rotationalTerrain,
  STANDARD_OBSTACLE_CHARS,
  STANDARD_TERRAIN,
  standardTypes,
} from "../common/standard.ts"
import type { CaravanInfo, Objectives, RouteInfo } from "./objectives.ts"

const SIZE = 40
const WAVE_FIRST = 60
const WAVE_EVERY = 300
const CARAVAN_SCORE = 100
const CARAVAN_GOLD = 40
const GUARDS_PER_CARAVAN = 2
const GUARD_BOUNTY = 20
const CAPTURE_RANGE = 2
const GUARD_RANGE = 5
const DELIVER_RANGE = 2
const GUARD_LEASH = 6
const POST_MIN_ENEMY_BASE = 10

const types: Record<string, TypeSpec> = {
  ...standardTypes(),
  post: { kind: "building", w: 2, h: 2, maxHp: 600, cost: { gold: 120 }, buildTicks: 80, sight: 5, dropOff: true, look: { shape: "hex", label: "栈", name: "货栈" } },
  caravan: { kind: "unit", maxHp: 250, moveTicks: 5, sight: 3, look: { shape: "diamond", label: "镖", name: "商队" } },
  guard: { kind: "unit", maxHp: 120, moveTicks: 3, sight: 6, attack: { damage: 10, range: 1, cooldown: 8 }, look: { shape: "circle", label: "师", color: "#b5651d", name: "镖师" } },
}
// 主基地加厚、能还手：拆家很难，主要靠劫镖分胜负
types.base.maxHp = 2000
types.base.attack = { damage: 6, range: 4, cooldown: 8 }
types.barracks.cost = { gold: 150 }
types.barracks.buildTicks = 100
types.worker.builds = ["post", "barracks"]

const terrain = {
  ...STANDARD_TERRAIN,
  "=": { walkable: true, color: "#8b6f47" },
}

// 地图：40×40，四重旋转对称。四条 2 格宽的商路把地图分成 3×3 的九块，四个角是玩家的家。
const LANE0: Rect = { x: 25, y: 0, w: 2, h: SIZE }
// 经典布局（D-141 之前的固定地图）；随机地图只换石头、水塘和四条边中间的中立矿，商路不变，所以判断商路用它就行
const TERRAIN = rotationalTerrain(SIZE, ".", [
  { ch: "#", x: 17, y: 17, w: 3, h: 3 }, // 中间一块石头
  { ch: "~", x: 17, y: 4, w: 5, h: 2 }, // 四条边中间的水塘
  { ch: "=", ...LANE0 }, // 商路最后画
])
/** 四条边中间那对中立矿（每个 400）的阵型；经典布局在 (18, 8) */
const EDGE_MINES = [
  { x: 0, y: 0 },
  { x: 3, y: 0 },
]
const CLASSIC_EDGE = { x: 18, y: 8 }
const SMALL_SHAPES: { w: [number, number]; h: [number, number] }[] = [
  { w: [2, 5], h: [1, 2] },
  { w: [1, 2], h: [2, 5] },
  { w: [2, 3], h: [2, 3] },
]

function routeOf(k: number): RouteInfo {
  const lane = rotateK(SIZE, LANE0, k)
  const from = rotateK(SIZE, { x: 25, y: 0, w: 1, h: 1 }, k)
  const to = rotateK(SIZE, { x: 25, y: SIZE - 1, w: 1, h: 1 }, k)
  return { id: k, lane, from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } }
}
const ROUTES: RouteInfo[] = [0, 1, 2, 3].map(routeOf)

function isRoad(x: number, y: number): boolean {
  return TERRAIN[y]?.[x] === "="
}

// 玩家 0 的角（左上）上的东西，其他角按旋转放
const HOME: { type: string; x: number; y: number; amount?: number }[] = [
  { type: "base", x: 3, y: 3 },
  { type: "barracks", x: 5, y: 9 },
  { type: "goldmine", x: 9, y: 2, amount: 500 },
  { type: "goldmine", x: 9, y: 6, amount: 500 },
  { type: "goldmine", x: 2, y: 9, amount: 500 },
]

// ---------- 一局里的状态（沙箱里每局重新加载；平台测试里直接跑时靠 setup 开头的 resetState） ----------
interface CaravanState {
  route: number
  guards: number[]
  lastOwner: number
}
const caravans = new Map<number, CaravanState>()
const cornerOf: number[] = []
let nextWave = WAVE_FIRST
let target = 1000
let teamCount = 2
let caravanView: CaravanInfo[] = []
const delivered: number[] = []
/** 统计（结束时放进结果的 stats）：劫下中立商队、抢到别人押运的、被别人抢走、被镖师夺回 */
const robbed: number[] = []
const stolen: number[] = []
const lostTo: number[] = []
const retaken: number[] = []

function resetState(): void {
  caravans.clear()
  cornerOf.length = 0
  nextWave = WAVE_FIRST
  target = 1000
  teamCount = 2
  caravanView = []
  for (const a of [delivered, robbed, stolen, lostTo, retaken]) a.length = 0
}

function stats(ctx: RuleContext): Record<string, number[]> {
  const per = (a: number[]) => ctx.players.map((p) => a[p.id] ?? 0)
  return { 劫下商队: per(robbed), 抢到押运的: per(stolen), 被抢走: per(lostTo), 被镖师夺回: per(retaken), 交货: per(delivered) }
}

const inc = (a: number[], p: number) => (a[p] = (a[p] ?? 0) + 1)

function center(r: Rect): { x: number; y: number } {
  return { x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) }
}

function baseRect(p: number): Rect {
  return rotateK(SIZE, { x: 3, y: 3, w: 3, h: 3 }, cornerOf[p])
}

function teamScores(ctx: RuleContext): number[] {
  const s: number[] = Array(teamCount).fill(0)
  for (const p of ctx.players) s[ctx.teams[p.id]] += p.score
  return s
}

/** 战报里的队伍名：分队时写"队N"，不分队写"PN" */
function teamName(ctx: RuleContext, t: number): string {
  const ms = ctx.players.filter((p) => ctx.teams[p.id] === t)
  return ms.length === 1 ? `P${ms[0].id}` : `队${t + 1}`
}

function hasBase(ctx: RuleContext, p: number): boolean {
  return ctx.entities({ owner: p, type: "base" }).length > 0
}

/** 商队没了（交货、被打死）：还活着的镖师散伙离场 */
function releaseGuards(ctx: RuleContext, st: CaravanState): void {
  for (const g of st.guards) {
    const e = ctx.get(g)
    if (e && e.alive) ctx.remove(g)
  }
}

function spawnWave(ctx: RuleContext): void {
  for (const r of ROUTES) {
    const id = ctx.spawnNear("caravan", -1, r.from.x, r.from.y)
    if (id === null) continue
    const guards: number[] = []
    for (let i = 0; i < GUARDS_PER_CARAVAN; i++) {
      const g = ctx.spawnNear("guard", -1, r.from.x, r.from.y)
      if (g !== null) guards.push(g)
    }
    ctx.orderNeutral(id, { kind: "move", x: r.to.x, y: r.to.y })
    caravans.set(id, { route: r.id, guards, lastOwner: -1 })
  }
}

function nearestUnit<T extends Rect>(ctx: RuleContext, c: Rect, list: T[]): T {
  let best = list[0]
  let bd = Infinity
  for (const e of list) {
    const d = ctx.dist(e, c)
    if (d < bd) {
      bd = d
      best = e
    }
  }
  return best
}

function stepCaravan(ctx: RuleContext, id: number, st: CaravanState): void {
  const c = ctx.get(id)
  if (!c || !c.alive) {
    caravans.delete(id)
    return
  }
  const near = ctx
    .entitiesIn(c.x - CAPTURE_RANGE, c.y - CAPTURE_RANGE, 2 * CAPTURE_RANGE + 1, 2 * CAPTURE_RANGE + 1)
    .filter((e) => e.alive && e.def.kind === "unit" && e.owner >= 0 && e.type !== "caravan" && ctx.dist(e, c) <= CAPTURE_RANGE)
  const liveGuards = st.guards.map((g) => ctx.get(g)).filter((g) => g !== undefined && g.alive)
  const guardsNear = liveGuards.filter((g) => ctx.dist(g!, c) <= GUARD_RANGE).length

  if (c.owner === -1) {
    const r = ROUTES[st.route]
    if (Math.abs(c.x - r.to.x) + Math.abs(c.y - r.to.y) <= 1) {
      // 平安过境
      for (const g of liveGuards) ctx.remove(g!.id)
      caravans.delete(id)
      ctx.remove(id)
      return
    }
    if (guardsNear === 0 && near.length > 0) {
      const teamsHere = new Set(near.map((e) => ctx.teams[e.owner]))
      if (teamsHere.size === 1) {
        const taker = nearestUnit(ctx, c, near).owner
        ctx.setOwner(id, taker)
        st.lastOwner = taker
        inc(robbed, taker)
      }
    } else if (c.order.kind === "idle") ctx.orderNeutral(id, { kind: "move", x: r.to.x, y: r.to.y })
  } else {
    st.lastOwner = c.owner
    // 交货
    const drops = ctx
      .entitiesIn(c.x - DELIVER_RANGE - 2, c.y - DELIVER_RANGE - 2, 2 * DELIVER_RANGE + 5, 2 * DELIVER_RANGE + 5)
      .filter((e) => e.alive && (e.type === "base" || e.type === "post") && e.construction === null && ctx.isAlly(e.owner, c.owner) && ctx.dist(e, c) <= DELIVER_RANGE)
    if (drops.length > 0) {
      ctx.addScore(c.owner, CARAVAN_SCORE)
      ctx.addResource(c.owner, "gold", CARAVAN_GOLD)
      delivered[c.owner] = (delivered[c.owner] ?? 0) + 1
      caravans.delete(id)
      releaseGuards(ctx, st)
      ctx.remove(id)
      return
    }
    const friendly = near.filter((e) => ctx.isAlly(e.owner, c.owner))
    const hostile = near.filter((e) => !ctx.isAlly(e.owner, c.owner))
    if (friendly.length === 0) {
      const guardAdj = liveGuards.some((g) => ctx.dist(g!, c) <= CAPTURE_RANGE)
      if (guardAdj && hostile.length === 0) {
        // 镖师夺回，接着走商路
        inc(retaken, c.owner)
        ctx.setOwner(id, -1)
        ctx.orderNeutral(id, { kind: "move", x: ROUTES[st.route].to.x, y: ROUTES[st.route].to.y })
      } else if (hostile.length > 0 && !guardAdj) {
        const teamsHere = new Set(hostile.map((e) => ctx.teams[e.owner]))
        if (teamsHere.size === 1) {
          const taker = nearestUnit(ctx, c, hostile).owner
          inc(lostTo, c.owner)
          inc(stolen, taker)
          ctx.setOwner(id, taker)
          st.lastOwner = taker
        }
      }
    }
  }

  // 镖师跟着商队：离远了直接走回来，否则朝商队攻击移动（路上打靠近的玩家单位）
  if (ctx.tick % 5 === 0) {
    const cc = ctx.get(id)
    if (!cc) return
    for (const g of liveGuards) {
      const d = ctx.dist(g!, cc)
      if (d > GUARD_LEASH) ctx.orderNeutral(g!.id, { kind: "move", x: cc.x, y: cc.y })
      else if (g!.order.kind === "idle" && d > 1) ctx.orderNeutral(g!.id, { kind: "attackMove", x: cc.x, y: cc.y })
    }
  }
}

const ruleset: Ruleset = {
  id: "caravan-raid",
  name: "劫镖",
  summary: "劫下商路上过境的中立商队、押回家交货得分，押运途中会被别人抢走",
  players: { min: 2, max: 4 },
  teams: true,
  maxTicks: 4000,
  tickRate: 10,
  decisionInterval: 5,
  fuel: 150,
  unitCap: 30,
  fog: true,
  resources: ["gold"],
  terrain,
  types,

  setup(ctx) {
    resetState()
    // 地图按种子随机生成（四重旋转对称，四个角一样）：家、商路固定，石头、水塘和四条边中间的那对矿每局不同
    const map = randomSymmetricMap(ctx.rng, {
      width: SIZE,
      height: SIZE,
      symmetry: "rot4",
      base: rotationalTerrain(SIZE, ".", [{ ch: "=", ...LANE0 }]),
      terrain,
      keepClear: [{ x: 0, y: 0, w: 12, h: 12 }, LANE0],
      obstacles: { count: [3, 5], shapes: SMALL_SHAPES, chars: STANDARD_OBSTACLE_CHARS },
      mines: [{ region: { x: 15, y: 3, w: 6, h: 8 }, offsets: EDGE_MINES }],
      connect: [{ x: 7, y: 7 }, { x: 24, y: 2 }, { x: 20, y: 20 }],
    })
    ctx.setTerrain(map?.terrain ?? TERRAIN)
    const n = ctx.playerCount
    teamCount = Math.max(...ctx.teams) + 1
    const realTeams = new Set(ctx.teams).size
    target = realTeams <= 2 ? 1000 : realTeams === 3 ? 800 : 700
    // 同队的坐相邻的角：按队伍编号排座位，再依次分角
    const order = [...Array(n).keys()].sort((a, b) => ctx.teams[a] - ctx.teams[b] || a - b)
    const corners = cornersFor(n)
    order.forEach((p, i) => (cornerOf[p] = corners[i]))
    for (let p = 0; p < n; p++) {
      for (const it of HOME) {
        const spec = types[it.type]
        const r = rotateK(SIZE, { x: it.x, y: it.y, w: spec.w ?? 1, h: spec.h ?? 1 }, cornerOf[p])
        ctx.spawn(it.type, it.type === "goldmine" ? -1 : p, r.x, r.y, { amount: it.amount })
      }
      // 工人：在主基地旁边找空位
      // 工人、战士：从左上角那家的 (6,4)、(5,8) 转到自己的角上，再在附近找空位（从主基地正中间找会找不到）
      const wp = rotateK(SIZE, { x: 6, y: 4, w: 1, h: 1 }, cornerOf[p])
      for (let i = 0; i < 3; i++) if (ctx.spawnNear("worker", p, wp.x, wp.y) === null) throw new Error(`P${p} 的工人放不下`)
      const sp = rotateK(SIZE, { x: 5, y: 8, w: 1, h: 1 }, cornerOf[p])
      for (let i = 0; i < 2; i++) if (ctx.spawnNear("soldier", p, sp.x, sp.y) === null) throw new Error(`P${p} 的战士放不下`)
      ctx.setResources(p, { gold: 150 })
      delivered[p] = 0
    }
    // 四条边中间的空地上各 2 个中立金矿（每个 400），谁都能去采
    if (map) for (const m of map.mines) ctx.spawn("goldmine", -1, m.x, m.y, { amount: 400 })
    else
      for (let k = 0; k < 4; k++)
        for (const o of EDGE_MINES) {
          const r = rotateK(SIZE, { x: CLASSIC_EDGE.x + o.x, y: CLASSIC_EDGE.y + o.y, w: 1, h: 1 }, k)
          ctx.spawn("goldmine", -1, r.x, r.y, { amount: 400 })
        }
    const markers: Marker[] = ROUTES.map((r) => ({ kind: "label", x: r.from.x, y: r.from.y, text: `商路${r.id}起点` }))
    ctx.setMarkers(markers)
    ctx.setStatus(`劫镖：第一批商队在 tick ${WAVE_FIRST} 出发，目标 ${target} 分`)
  },

  onTick(ctx) {
    for (const ev of ctx.events) {
      if (ev.kind !== "died") continue
      if (ev.type === "guard") {
        if (ev.killer >= 0) ctx.addResource(ev.killer, "gold", GUARD_BOUNTY)
      } else if (ev.type === "caravan") {
        const st = caravans.get(ev.id)
        if (st) {
          caravans.delete(ev.id)
          releaseGuards(ctx, st)
        }
      }
    }
    if (ctx.tick >= nextWave) {
      spawnWave(ctx)
      nextWave += WAVE_EVERY
    }
    for (const [id, st] of [...caravans]) stepCaravan(ctx, id, st)
    // 主基地没了就出局
    for (const p of ctx.players) if (p.alive && !hasBase(ctx, p.id)) ctx.eliminate(p.id)

    // 给 bot 的商队列表，每 tick 算一次
    caravanView = []
    for (const [id, st] of caravans) {
      const c = ctx.get(id)
      if (!c) continue
      let guards = 0
      for (const g of st.guards) {
        const ge = ctx.get(g)
        if (ge && ge.alive && ctx.dist(ge, c) <= GUARD_RANGE) guards++
      }
      caravanView.push({ id, x: c.x, y: c.y, owner: c.owner, route: st.route, guards, hp: c.hp })
    }
    const ts = teamScores(ctx)
    ctx.setStatus(`队伍分数 ${ts.join(" : ")}（目标 ${target}）｜交货 ${delivered.join("/")}｜下一批商队 tick ${nextWave}`)
  },

  objectives(ctx, player): Objectives {
    const enemyBases: { owner: number; x: number; y: number }[] = []
    const allyBases: { owner: number; x: number; y: number }[] = []
    for (let p = 0; p < ctx.playerCount; p++) {
      const r = baseRect(p)
      ;(ctx.isAlly(p, player) ? allyBases : enemyBases).push({ owner: p, x: r.x, y: r.y })
    }
    return {
      target,
      myTeam: ctx.teams[player],
      teamScores: teamScores(ctx),
      nextWave,
      routes: ROUTES,
      caravans: caravanView,
      enemyBases,
      allyBases,
      rules: {
        captureRange: CAPTURE_RANGE,
        guardRange: GUARD_RANGE,
        deliverRange: DELIVER_RANGE,
        caravanScore: CARAVAN_SCORE,
        caravanGold: CARAVAN_GOLD,
        postMinEnemyBaseDist: POST_MIN_ENEMY_BASE,
      },
    }
  },

  buildCheck(ctx, player, type, x, y) {
    if (type !== "post") return null
    const w = 2
    const h = 2
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (isRoad(xx, yy)) return "货栈不能压在道路上（地基里有 '=' 格）"
    let touches = false
    for (let yy = y - 1; yy <= y + h; yy++)
      for (let xx = x - 1; xx <= x + w; xx++) {
        const inside = xx >= x && xx < x + w && yy >= y && yy < y + h
        if (!inside && isRoad(xx, yy)) touches = true
      }
    if (!touches) return "货栈必须挨着道路：地基四周 1 格内（含斜角）要有 '=' 格"
    for (let p = 0; p < ctx.playerCount; p++) {
      if (ctx.isAlly(p, player)) continue
      if (ctx.dist({ x, y, w, h }, baseRect(p)) < POST_MIN_ENEMY_BASE) return `货栈离非盟友的主基地至少 ${POST_MIN_ENEMY_BASE} 格`
    }
    return null
  },

  result(ctx) {
    const ts = teamScores(ctx)
    const teamIds = [...new Set(ctx.teams)]
    const members = (t: number) => ctx.players.filter((p) => ctx.teams[p.id] === t).map((p) => p.id)
    const aliveTeams = teamIds.filter((t) => members(t).some((p) => ctx.players[p].alive))
    const rank = (): number[][] => {
      const sorted = [...teamIds].sort((a, b) => {
        const aa = aliveTeams.includes(a) ? 1 : 0
        const bb = aliveTeams.includes(b) ? 1 : 0
        return bb - aa || ts[b] - ts[a]
      })
      const out: number[][] = []
      let prev: string | null = null
      for (const t of sorted) {
        const key = `${aliveTeams.includes(t)}:${ts[t]}`
        if (key === prev) out[out.length - 1].push(...members(t))
        else out.push(members(t))
        prev = key
      }
      return out
    }
    if (aliveTeams.length === 0) return { winner: null, reason: "所有主基地都被摧毁", ranking: [ctx.players.map((p) => p.id)] }
    if (aliveTeams.length === 1 && teamIds.length > 1) {
      const t = aliveTeams[0]
      return { winner: members(t)[0], winners: members(t), reason: `${teamName(ctx, t)}以外的主基地全被摧毁`, ranking: rank() }
    }
    const reached = aliveTeams.filter((t) => ts[t] >= target)
    if (reached.length > 0) {
      const best = Math.max(...reached.map((t) => ts[t]))
      const top = reached.filter((t) => ts[t] === best)
      if (top.length > 1) return { winner: null, reason: `几队同时达到 ${target} 分`, ranking: rank() }
      const t = top[0]
      return { winner: members(t)[0], winners: members(t), reason: `${teamName(ctx, t)}先劫够 ${target} 分（${ts.join(" : ")}）`, ranking: rank() }
    }
    return null
  },

  timeUp(ctx) {
    const ts = teamScores(ctx)
    const teamIds = [...new Set(ctx.teams)].sort((a, b) => ts[b] - ts[a])
    const members = (t: number) => ctx.players.filter((p) => ctx.teams[p.id] === t).map((p) => p.id)
    const ranking: number[][] = []
    let prev = -1
    for (const t of teamIds) {
      if (ts[t] === prev) ranking[ranking.length - 1].push(...members(t))
      else ranking.push(members(t))
      prev = ts[t]
    }
    if (teamIds.length > 1 && ts[teamIds[0]] === ts[teamIds[1]]) return { winner: null, reason: `时间到，最高分并列（${ts.join(" : ")}）`, ranking }
    const t = teamIds[0]
    return { winner: members(t)[0], winners: members(t), reason: `时间到，队伍分数 ${ts.join(" : ")}`, ranking }
  },
}

// 结果里带上统计（劫下、抢到、被抢、被镖师夺回、交货），联赛和战报会列出来
const judge = ruleset.result
const judgeTimeUp = ruleset.timeUp
ruleset.result = (ctx) => {
  const r = judge(ctx)
  return r && { ...r, stats: stats(ctx) }
}
ruleset.timeUp = (ctx) => ({ ...judgeTimeUp(ctx), stats: stats(ctx) })

export default ruleset
