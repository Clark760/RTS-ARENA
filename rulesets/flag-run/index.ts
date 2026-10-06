// 规则包「夺旗」：每人一面旗插在家门口的旗台上，扛走敌旗、送回自己队的旗台得 1 分，本队先送回 3 面的赢。
// 地图中央有巡逻的巨魔（中立），会追杀路过的旗手。主基地被拆就出局（分队时单位交给队友）。
import type { MatchResult, Marker, Rect, RuleContext, Ruleset, SetupContext, TypeSpec } from "../../src/core/types.ts"
import { rotateK, rotationalTerrain, STANDARD_TERRAIN, standardTypes } from "../common/standard.ts"
import type { FlagInfo, Objectives } from "./objectives.ts"

const S = 40
const MAX_TICKS = 5000
/** 一个人一队时要送回 3 面；队里每多一个人多送 1 面 */
const BASE_TARGET = 3
/** 每队要送回几面，下标是队伍编号 */
let targets: number[] = []
function targetOf(t: number): number {
  return targets[t] ?? BASE_TARGET
}
/** 掉在地上的旗多久自动回家 */
const DROP_RETURN = 300
const TROLL_RESPAWN = 400
const TROLL_BOUNTY = 60

// 左上角（第 0 个角）的布局，其余角绕地图中心转 90° 得到
const BASE: Rect = { x: 2, y: 2, w: 3, h: 3 }
const BARRACKS: Rect = { x: 6, y: 3, w: 2, h: 2 }
const PLAZA: Rect = { x: 7, y: 7, w: 5, h: 5 }
const STAND: Rect = { x: 9, y: 9, w: 1, h: 1 }
const MINES: Rect[] = [
  { x: 1, y: 7, w: 1, h: 1 },
  { x: 3, y: 7, w: 1, h: 1 },
  { x: 8, y: 1, w: 1, h: 1 },
  { x: 10, y: 1, w: 1, h: 1 },
]
const WAYPOINT: Rect = { x: 19, y: 15, w: 1, h: 1 }

const TERRAIN = {
  ...STANDARD_TERRAIN,
  "+": { walkable: true, color: "#5a4a6a" },
  "^": { walkable: true, color: "#6b6b3a" },
}

const types: Record<string, TypeSpec> = {
  ...standardTypes(),
  flag: { kind: "building", w: 1, h: 1, maxHp: 0, sight: 6, look: { shape: "diamond", label: "旗" } },
  tower: {
    kind: "building",
    w: 2,
    h: 2,
    maxHp: 500,
    cost: { gold: 120 },
    buildTicks: 100,
    sight: 6,
    attack: { damage: 8, range: 4, cooldown: 10 },
    look: { shape: "hex", label: "塔" },
  },
  troll: {
    kind: "unit",
    maxHp: 400,
    moveTicks: 4,
    sight: 6,
    attack: { damage: 14, range: 1, cooldown: 12 },
    look: { shape: "circle", label: "魔", color: "#6a8f4e" },
  },
}
types.base.maxHp = 2500
types.barracks.cost = { gold: 150 }
types.barracks.buildTicks = 100
types.goldmine.amount = 500
types.worker.builds = ["barracks", "tower"]

// ---------- 一局里的状态（每局重新加载，不用自己清） ----------

interface FlagState {
  state: FlagInfo["state"]
  /** home / dropped 时地上那面旗的实体 id */
  entity: number
  carrier: number
  lastX: number
  lastY: number
  droppedAt: number
}

let corner: number[] = []
const stands: { x: number; y: number }[] = []
const plazas: Rect[] = []
const towerSpots: { x: number; y: number }[][] = []
const bases: { x: number; y: number }[] = []
const flags: FlagState[] = []
const out: boolean[] = []
const outTick: number[] = []
let waypoints: { x: number; y: number }[] = []
let trollCount = 2
const trollRespawn: number[] = []
const trollLeg = new Map<number, number>()

const st = {
  pick: [] as number[],
  cap: [] as number[],
  save: [] as number[],
  kill: [] as number[],
  troll: [] as number[],
  lostToTroll: [] as number[],
}

/** 每局开头清掉顶层状态（沙箱里每局重新加载；平台测试里直接跑时不会） */
function resetState(): void {
  targets = []
  corner = []
  for (const a of [stands, plazas, towerSpots, bases, flags, out, outTick, trollRespawn]) a.length = 0
  waypoints = []
  trollCount = 2
  trollLeg.clear()
  for (const a of Object.values(st)) a.length = 0
}

function rot(r: Rect, k: number): Rect {
  return rotateK(S, r, k)
}

function rectDist(a: Rect, b: Rect): number {
  const dx = Math.max(0, a.x - (b.x + b.w - 1), b.x - (a.x + a.w - 1))
  const dy = Math.max(0, a.y - (b.y + b.h - 1), b.y - (a.y + a.h - 1))
  return dx + dy
}

/** 各座位坐哪个角：同队的坐相邻的角；两人坐对角 */
function cornersOf(ctx: SetupContext): number[] {
  const n = ctx.playerCount
  const cs = n === 2 ? [0, 2] : [0, 1, 2, 3].slice(0, n)
  const seats = Array.from({ length: n }, (_, i) => i).sort((a, b) => ctx.teams[a] - ctx.teams[b] || a - b)
  const res: number[] = []
  seats.forEach((s, i) => (res[s] = cs[i]))
  return res
}

function teamIds(ctx: RuleContext): number[] {
  return Array.from(new Set(ctx.teams)).sort((a, b) => a - b)
}

function members(ctx: RuleContext, t: number): number[] {
  const res: number[] = []
  ctx.teams.forEach((tt, p) => {
    if (tt === t) res.push(p)
  })
  return res
}

function teamScore(ctx: RuleContext, t: number): number {
  let s = 0
  for (const p of members(ctx, t)) s += ctx.players[p].score
  return s
}

function teamOut(ctx: RuleContext, t: number): boolean {
  return members(ctx, t).every((p) => out[p])
}

function statsOf(): Record<string, number[]> {
  return {
    夺旗: st.pick,
    送回: st.cap,
    救回自家旗: st.save,
    截杀旗手: st.kill,
    杀巨魔: st.troll,
    旗手死于巨魔: st.lostToTroll,
  }
}

/** 名次：没出局的队按送回数占目标的比例排，出局的排在后面、出局越晚越靠前 */
function rankingOf(ctx: RuleContext): number[][] {
  const ts = teamIds(ctx)
  const key = (t: number): number => {
    if (teamOut(ctx, t)) return Math.max(...members(ctx, t).map((p) => outTick[p] ?? 0)) - 1e6
    return teamScore(ctx, t) / targetOf(t)
  }
  ts.sort((a, b) => key(b) - key(a))
  const res: number[][] = []
  let last: number | null = null
  for (const t of ts) {
    const k = key(t)
    if (last !== null && k === last) res[res.length - 1].push(...members(ctx, t))
    else res.push(members(ctx, t))
    last = k
  }
  return res
}

function finish(ctx: RuleContext, reason: string): MatchResult {
  const ranking = rankingOf(ctx)
  const top = ranking[0]
  const topTeams = new Set(top.map((p) => ctx.teams[p]))
  if (topTeams.size !== 1) return { winner: null, reason, ranking, stats: statsOf() }
  const winner = top.find((p) => !out[p]) ?? top[0]
  return { winner, winners: top, reason, ranking, stats: statsOf() }
}

function teamLabel(ctx: RuleContext, t: number): string {
  const ms = members(ctx, t)
  return ctx.teams.length === teamIds(ctx).length ? `P${ms[0]}` : `队${t + 1}`
}

// ---------- 旗 ----------

function placeFlagHome(ctx: RuleContext, f: number): void {
  const id = ctx.spawnNear("flag", f, stands[f].x, stands[f].y)
  if (id === null) return // 旗台周围全被堵死：下个 tick 再试
  flags[f] = { state: "home", entity: id, carrier: -1, lastX: stands[f].x, lastY: stands[f].y, droppedAt: 0 }
}

function dropFlag(ctx: RuleContext, f: number, x: number, y: number): void {
  const id = ctx.spawnNear("flag", f, x, y)
  if (id === null) {
    placeFlagHome(ctx, f)
    return
  }
  flags[f] = { state: "dropped", entity: id, carrier: -1, lastX: x, lastY: y, droppedAt: ctx.tick }
}

function isCarrier(id: number): boolean {
  return flags.some((fl) => fl.state === "carried" && fl.carrier === id)
}

function updateFlags(ctx: RuleContext): void {
  for (let f = 0; f < flags.length; f++) {
    const fl = flags[f]
    if (fl.state === "gone") continue
    if (fl.state === "carried") {
      const c = ctx.get(fl.carrier)
      if (!c || !c.alive) {
        dropFlag(ctx, f, fl.lastX, fl.lastY)
        continue
      }
      fl.lastX = c.x
      fl.lastY = c.y
      // 走到自己队任何一个（没出局的）旗台 2 格以内：送回
      const home = stands.findIndex((s, q) => !out[q] && ctx.isAlly(q, c.owner) && Math.abs(s.x - c.x) + Math.abs(s.y - c.y) <= 2)
      if (home >= 0) {
        ctx.addScore(c.owner, 1)
        st.cap[c.owner]++
        flags[f] = { state: "home", entity: -1, carrier: -1, lastX: 0, lastY: 0, droppedAt: 0 }
        placeFlagHome(ctx, f)
      }
      continue
    }
    if (fl.entity < 0 || !ctx.get(fl.entity)) {
      placeFlagHome(ctx, f)
      continue
    }
    const e = ctx.get(fl.entity)!
    const near = ctx
      .entitiesIn(e.x - 1, e.y - 1, 3, 3)
      .filter((u) => u.alive && u.owner >= 0 && u.def.kind === "unit" && !out[u.owner])
    const thief = near.find((u) => !ctx.isAlly(u.owner, f) && !isCarrier(u.id))
    if (thief) {
      ctx.remove(fl.entity)
      flags[f] = { state: "carried", entity: -1, carrier: thief.id, lastX: thief.x, lastY: thief.y, droppedAt: 0 }
      st.pick[thief.owner]++
      continue
    }
    if (fl.state === "dropped") {
      const friend = near.find((u) => ctx.isAlly(u.owner, f))
      if (friend || ctx.tick - fl.droppedAt >= DROP_RETURN) {
        if (friend) st.save[friend.owner]++
        ctx.remove(fl.entity)
        placeFlagHome(ctx, f)
      }
    }
  }
}

// ---------- 出局 ----------

function knockOut(ctx: RuleContext, p: number): void {
  out[p] = true
  outTick[p] = ctx.tick
  ctx.eliminate(p)
  const fl = flags[p]
  if (fl.state === "home" || fl.state === "dropped") ctx.remove(fl.entity)
  flags[p] = { state: "gone", entity: -1, carrier: -1, lastX: stands[p].x, lastY: stands[p].y, droppedAt: 0 }
  const mate = ctx.players.find((q) => q.id !== p && !out[q.id] && ctx.isAlly(q.id, p))
  for (const e of ctx.entities({ owner: p })) {
    if (mate && e.def.kind === "unit") ctx.setOwner(e.id, mate.id)
    else ctx.remove(e.id)
  }
}

// ---------- 巨魔 ----------

function trolls(ctx: RuleContext): void {
  for (let i = trollRespawn.length - 1; i >= 0; i--) {
    if (ctx.tick < trollRespawn[i]) continue
    const w = waypoints[ctx.rng.int(waypoints.length)]
    if (ctx.spawnNear("troll", -1, w.x, w.y) !== null) trollRespawn.splice(i, 1)
  }
  if (ctx.tick % 10 !== 0) return
  const carriers = flags.filter((fl) => fl.state === "carried").map((fl) => ctx.get(fl.carrier)).filter((c) => c && c.alive)
  for (const t of ctx.entities({ type: "troll" })) {
    // 优先追附近的旗手
    let prey: { id: number; d: number } | null = null
    for (const c of carriers) {
      const d = Math.abs(c!.x - t.x) + Math.abs(c!.y - t.y)
      if (d <= 9 && (!prey || d < prey.d)) prey = { id: c!.id, d }
    }
    if (prey) {
      if (t.order.kind !== "attack" || t.order.target !== prey.id) ctx.orderNeutral(t.id, { kind: "attack", target: prey.id })
      continue
    }
    // 离中心太远就回去（不打架，直接走回来）
    const fromCenter = Math.abs(t.x - S / 2) + Math.abs(t.y - S / 2)
    if (fromCenter > 12) {
      if (t.order.kind !== "move") {
        const w = waypoints[trollLeg.get(t.id) ?? 0]
        ctx.orderNeutral(t.id, { kind: "move", x: w.x, y: w.y })
      }
      continue
    }
    if (t.order.kind === "idle") {
      const leg = ((trollLeg.get(t.id) ?? ctx.rng.int(4)) + 1) % waypoints.length
      trollLeg.set(t.id, leg)
      ctx.orderNeutral(t.id, { kind: "attackMove", x: waypoints[leg].x, y: waypoints[leg].y })
    }
  }
}

// ---------- 叠加层 ----------

function markers(withCarriers: boolean): Marker[] {
  const ms: Marker[] = []
  for (let p = 0; p < plazas.length; p++) {
    const r = plazas[p]
    ms.push({ kind: "zone", ...r, owner: out[p] ? null : p, label: out[p] ? "已出局" : "旗台" })
  }
  ms.push({ kind: "zone", x: 16, y: 16, w: 8, h: 8, owner: null, label: "巨魔巡逻区", color: "#3d5a2e" })
  if (withCarriers) {
    for (let f = 0; f < flags.length; f++) {
      const fl = flags[f]
      if (fl.state !== "carried") continue
      ms.push({ kind: "label", x: fl.lastX, y: fl.lastY, text: `扛着 P${f} 的旗`, owner: f })
    }
  }
  return ms
}

const ruleset: Ruleset = {
  id: "flag-run",
  name: "夺旗",
  summary: "扛起敌人的旗送回自家旗台，先送够的队赢；地图中央的巨魔专追旗手",
  players: { min: 2, max: 4 },
  teams: true,
  maxTicks: MAX_TICKS,
  tickRate: 10,
  decisionInterval: 5,
  fuel: 100,
  unitCap: 30,
  fog: true,
  resources: ["gold"],
  terrain: TERRAIN,
  types,

  setup(ctx) {
    resetState()
    ctx.setTerrain(
      rotationalTerrain(S, ".", [
        { ch: "+", ...PLAZA },
        { ch: "^", x: 13, y: 8, w: 2, h: 2 },
        { ch: "^", x: 8, y: 13, w: 2, h: 2 },
        { ch: "#", x: 16, y: 5, w: 2, h: 8 },
        { ch: "~", x: 18, y: 18, w: 4, h: 4 },
      ]),
    )
    corner = cornersOf(ctx)
    waypoints = [0, 1, 2, 3].map((k) => rot(WAYPOINT, k))
    for (let p = 0; p < ctx.playerCount; p++) {
      const k = corner[p]
      const b = rot(BASE, k)
      bases[p] = { x: b.x, y: b.y }
      ctx.spawn("base", p, b.x, b.y)
      const br = rot(BARRACKS, k)
      ctx.spawn("barracks", p, br.x, br.y)
      for (const m of MINES) {
        const r = rot(m, k)
        ctx.spawn("goldmine", -1, r.x, r.y)
      }
      // 工人：直接从主基地的坐标开始找空位
      for (let i = 0; i < 4; i++) ctx.spawnNear("worker", p, b.x, b.y)
      ctx.spawnNear("soldier", p, br.x, br.y)
      ctx.spawnNear("soldier", p, br.x, br.y)
      const s = rot(STAND, k)
      stands[p] = { x: s.x, y: s.y }
      plazas[p] = rot(PLAZA, k)
      const id = ctx.spawn("flag", p, s.x, s.y)
      flags[p] = { state: "home", entity: id, carrier: -1, lastX: s.x, lastY: s.y, droppedAt: 0 }
      out[p] = false
      st.pick[p] = st.cap[p] = st.save[p] = st.kill[p] = st.troll[p] = st.lostToTroll[p] = 0
      // 能建哨塔的地方：2×2 都是高地
      const spots: { x: number; y: number }[] = []
      for (let y = 0; y < S - 1; y++)
        for (let x = 0; x < S - 1; x++) {
          if (ctx.terrain[y][x] !== "^" || ctx.terrain[y][x + 1] !== "^" || ctx.terrain[y + 1][x] !== "^" || ctx.terrain[y + 1][x + 1] !== "^") continue
          if (rectDist({ x, y, w: 2, h: 2 }, plazas[p]) <= 3) spots.push({ x, y })
        }
      towerSpots[p] = spots
      ctx.setResources(p, { gold: 150 })
    }
    trollCount = ctx.playerCount === 2 ? 2 : 3
    const sizes = new Map<number, number>()
    for (const t of ctx.teams) sizes.set(t, (sizes.get(t) ?? 0) + 1)
    targets = []
    for (const [t, n] of sizes) targets[t] = BASE_TARGET + n - 1
    for (let i = 0; i < trollCount; i++) {
      const w = waypoints[i]
      const id = ctx.spawnNear("troll", -1, w.x, w.y)
      if (id !== null) trollLeg.set(id, i)
    }
    ctx.setMarkers(markers(false))
    ctx.setStatus(`扛走敌旗、送回自家旗台；本队先送回 ${targets.join("/")} 面的赢`)
  },

  onTick(ctx) {
    let changed = false
    for (const ev of ctx.events) {
      if (ev.kind !== "died") continue
      if (ev.type === "troll") {
        trollRespawn.push(ctx.tick + TROLL_RESPAWN)
        if (ev.killer >= 0) {
          st.troll[ev.killer]++
          ctx.addResource(ev.killer, "gold", TROLL_BOUNTY)
        }
        continue
      }
      const f = flags.findIndex((fl) => fl.state === "carried" && fl.carrier === ev.id)
      if (f >= 0) {
        if (ev.killer >= 0) st.kill[ev.killer]++
        else if (!ev.removed && ev.owner >= 0) st.lostToTroll[ev.owner]++
        dropFlag(ctx, f, ev.x, ev.y)
        changed = true
      }
    }
    for (let p = 0; p < ctx.playerCount; p++) {
      if (!out[p] && ctx.entities({ owner: p, type: "base" }).length === 0) {
        knockOut(ctx, p)
        changed = true
      }
    }
    updateFlags(ctx)
    trolls(ctx)
    if (changed || flags.some((fl) => fl.state === "carried") || ctx.tick % 50 === 0) ctx.setMarkers(markers(true))
    const ts = teamIds(ctx)
    ctx.setStatus(`送回 ${ts.map((t) => `${teamLabel(ctx, t)} ${teamScore(ctx, t)}/${targetOf(t)}`).join(" : ")}`)
  },

  objectives(ctx, player): Objectives {
    const ts = teamIds(ctx)
    const scores: number[] = []
    for (const t of ts) scores[t] = teamScore(ctx, t)
    return {
      target: targetOf(ctx.teams[player]),
      teamTargets: targets.slice(),
      myTeam: ctx.teams[player],
      teamScores: scores,
      flags: flags.map((fl, f) => {
        const carried = fl.state === "carried"
        const e = fl.state === "home" || fl.state === "dropped" ? ctx.get(fl.entity) : undefined
        const c = carried ? ctx.get(fl.carrier) : undefined
        return {
          owner: f,
          state: fl.state,
          x: e ? e.x : c ? c.x : fl.lastX,
          y: e ? e.y : c ? c.y : fl.lastY,
          carrier: carried ? fl.carrier : null,
          carrierOwner: c ? c.owner : null,
          returnAt: fl.state === "dropped" ? fl.droppedAt + DROP_RETURN : null,
        }
      }),
      stands: stands.map((s, p) => ({ owner: p, ...s })),
      plazas: plazas.map((r, p) => ({ owner: p, ...r })),
      towerSpots: towerSpots[player] ?? [],
      trolls: ctx.entities({ type: "troll" }).map((t) => ({ id: t.id, x: t.x, y: t.y, hp: t.hp })),
      bases: bases.map((b, p) => ({ owner: p, ...b, alive: !out[p] })),
    }
  },

  buildCheck(ctx, player, type, x, y) {
    const spec = types[type]
    const w = spec.w ?? 1
    const h = spec.h ?? 1
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++) {
        const ch = ctx.terrain[y + dy]?.[x + dx]
        if (ch === "+") return "旗台广场（+）上不能建任何建筑"
        if (type === "tower" && ch !== "^") return "哨塔只能建在高地（^）上，整个 2×2 都要是高地"
      }
    return null
  },

  result(ctx) {
    const ts = teamIds(ctx)
    const alive = ts.filter((t) => !teamOut(ctx, t))
    if (alive.length === 0) return finish(ctx, "所有主基地同时被拆")
    if (alive.length === 1 && ts.length > 1) {
      const sc = teamScore(ctx, alive[0])
      if (sc < targetOf(alive[0])) return finish(ctx, "其余队伍的主基地都被拆了")
    }
    const done = alive.filter((t) => teamScore(ctx, t) >= targetOf(t))
    if (done.length > 0) return finish(ctx, `先送够了要送回的敌旗（${done.map((t) => targetOf(t)).join("、")} 面）`)
    return null
  },

  timeUp(ctx) {
    return finish(ctx, "时间到，比送回的旗数")
  },
}

export default ruleset
