// 文字战报：给看不了网页回放的人和大模型 agent。从回放还原整局，按时间抽样双方的经济、兵力、建筑，
// 列出关键事件、战斗、损失，估算采集量，最后给几条只基于事实的"可能的问题"。
import { applyFrame, ReplayModel, type State } from "../core/replay-model.ts"
import type { EntSnap, Replay } from "../core/types.ts"
import { fighterTest, groupBattles, isRout, MIN_BATTLE } from "./battles.ts"

export interface ReportOptions {
  /** 从这个玩家的角度写（"你"、"对手"），只给他的提示；不给就写全部玩家 */
  player?: number
  /** 每隔多少 tick 抽样一次；不给按整局长度挑（大约 10 行） */
  every?: number
  /** 关键事件、战斗全部列出，不省略 */
  full?: boolean
}

interface PlayerSample {
  res: Record<string, number>
  score: number
  alive: boolean
  /** 到这次抽样为止造东西一共花了多少（所有资源加起来） */
  spentSoFar: number
  /** 单位类型 → 数量、其中闲着的 */
  units: Map<string, { n: number; idle: number }>
  /** 建筑类型 → 数量、其中没建好的 */
  buildings: Map<string, { n: number; building: number }>
}

interface Death {
  t: number
  owner: number
  type: string
  x: number
  y: number
  /** 最后打它的玩家，-1 表示不知道（不是被打死的） */
  by: number
  /** 死的时候在执行的命令（回放里的命令文字） */
  ord: string
}

/** 一段闲着的时间 */
interface IdleSpan {
  id: number
  type: string
  owner: number
  from: number
  to: number
  x: number
  y: number
  /** 闲下来之前在做什么 */
  before: string
  /** 闲下来时在哪、在不在规则包标出的区域里 */
  sx: number
  sy: number
  zone: string | null
}

/** 报错和被拒命令按种类汇总（数字归一后算同一种），最多的在前 */
export function errorKinds(replay: Replay, p: number): { n: number; t: number; msg: string }[] {
  const kinds = new Map<string, { n: number; t: number; msg: string }>()
  for (const f of replay.frames) {
    for (const e of f.errs ?? []) {
      if (e.p !== p) continue
      const head = e.msg.split("\n")[0].replace(/\s+\{.*$/, "")
      const key = head.replace(/#\d+/g, "#").replace(/\d+/g, "N")
      const k = kinds.get(key)
      if (k) k.n++
      else kinds.set(key, { n: 1, t: f.t, msg: e.msg.split("\n").slice(0, 3).join(" | ") })
    }
  }
  return [...kinds.values()].sort((a, b) => b.n - a.n)
}

function pickEvery(last: number): number {
  for (const e of [50, 100, 200, 250, 500, 1000, 2000, 5000]) if (last / e <= 12) return e
  return 10_000
}

const fmtRes = (r: Record<string, number>) =>
  Object.entries(r)
    .map(([k, v]) => `${k} ${Math.round(v)}`)
    .join(" ")

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0)

function countList(m: Map<string, number>): string {
  return [...m].map(([k, n]) => `${k}×${n}`).join("、") || "无"
}

/** 闲着超过这么久的工人单独列出来 */
const LONG_IDLE = 300

/** 技能冷却好了这么久还没放，算晚放 */
const SKILL_LATE = 100

export function buildReport(replay: Replay, opts: ReportOptions = {}): string {
  const types = replay.types
  const n = replay.players.length
  const team = (p: number) => replay.players[p]?.team ?? p
  const enemies = (a: number, b: number) => a >= 0 && b >= 0 && team(a) !== team(b)
  const me = opts.player
  const who0 = (p: number) => (me === undefined ? `P${p}` : p === me ? "你" : team(p) === team(me) ? `盟友 P${p}` : `对手 P${p}`)
  /** 各节按这个顺序列玩家：写了 --player（或在 bot 目录里）时「你」排第一，其余按座位（D-195，试写反馈：先后随座位变，不好找） */
  const seatOrder = me === undefined ? [...Array(n).keys()] : [me, ...[...Array(n).keys()].filter((q) => q !== me)]
  /** 当主语用：P0 后面接汉字时补一个空格 */
  const who = (p: number) => (p === me ? "你" : who0(p) + " ")
  const kind = (type: string) => types[type]?.kind
  // 工人：能采集或能建造的单位（老回放没有这个标记，就当都是兵）
  const isWorker = (type: string) => types[type]?.worker === true
  const hasWorkers = Object.values(types).some((t) => t.worker === true)
  // 兵：要花钱造、不是工人的单位（白捡来的单位、老回放不算）
  const isArmy = (type: string) => hasWorkers && kind(type) === "unit" && !isWorker(type) && Object.values(types[type]?.cost ?? {}).some((c) => (c ?? 0) > 0)
  const hasArmy = Object.keys(types).some(isArmy)
  const model = new ReplayModel(replay)
  const last = model.lastTick
  const every = opts.every && opts.every > 0 ? opts.every : pickEvery(last)

  // ---------- 一遍扫完整局 ----------
  const s: State = model.initialState()
  const initialIds = new Set(s.ents.keys())
  const spentTotal = new Array<number>(n).fill(0)
  const samples: { t: number; players: PlayerSample[] }[] = []
  const takeSample = (t: number) => {
    const players: PlayerSample[] = s.players.map((ps, p) => ({
      res: { ...ps.resources },
      score: ps.score,
      alive: ps.alive,
      spentSoFar: spentTotal[p],
      units: new Map(),
      buildings: new Map(),
    }))
    for (const e of s.ents.values()) {
      if (e.owner < 0 || e.owner >= n) continue
      const k = kind(e.type)
      if (k === "unit") {
        const u = players[e.owner].units.get(e.type) ?? { n: 0, idle: 0 }
        u.n++
        if (e.ord === "idle") u.idle++
        players[e.owner].units.set(e.type, u)
      } else if (k === "building") {
        const b = players[e.owner].buildings.get(e.type) ?? { n: 0, building: 0 }
        b.n++
        if (e.bp !== undefined) b.building++
        players[e.owner].buildings.set(e.type, b)
      }
    }
    samples.push({ t, players })
  }
  takeSample(0)
  const initialRes = s.players.map((p) => ({ ...p.resources }))
  const deaths: Death[] = []
  /** 规则包 remove 掉的（不算死亡、损失）："owner|type" → 个数 */
  const removedBy = new Map<string, number>()
  const spent = Array.from({ length: n }, () => new Map<string, number>())
  /** cat：depleted 是资源点采完（太多时先省略），key 是"第一次……"、换主人这些（太多时也保留） */
  const events: { t: number; p: number; text: string; cat?: "depleted" | "key" }[] = []
  /** 第一次有兵的时间 */
  const firstArmy = new Array<number>(n).fill(-1)
  for (const e of s.ents.values()) if (e.owner >= 0 && e.owner < n && isArmy(e.type)) firstArmy[e.owner] = 0
  const firstMade = Array.from({ length: n }, () => new Set<string>())
  const firstHitTaken = new Array<number>(n).fill(-1)
  const firstHitDealt = new Array<number>(n).fill(-1)
  const firstBuildingHit = new Array<number>(n).fill(-1)
  let firstContact = -1
  /** 每个实体最后一次被哪个玩家打 */
  const lastHit = new Map<number, number>()
  /** 最后一击的攻击者：id、类型和当时的位置 */
  const lastHitter = new Map<number, { id: number; type: string; x: number; y: number }>()
  // 中立单位（野怪这类）按出生的地方分组：谁打死了几只、什么时候清空、它们打死了谁（D-191，试写反馈：战报看不出营地被谁清了、野怪打死了自己多少工人）
  const neutralGroups: { x: number; y: number; size: number; alive: number; kills: number[]; clears: { t: number; by: number }[]; slain: Map<number, Map<string, number>> }[] = []
  const groupOf = new Map<number, number>()
  const addNeutral = (e: EntSnap) => {
    if (e.owner >= 0 || groupOf.has(e.id) || kind(e.type) !== "unit" || !types[e.type]?.attack) return
    let g = neutralGroups.findIndex((x) => Math.abs(x.x - e.x) + Math.abs(x.y - e.y) <= 3)
    if (g < 0) {
      neutralGroups.push({ x: e.x, y: e.y, size: 0, alive: 0, kills: new Array<number>(n).fill(0), clears: [], slain: new Map() })
      g = neutralGroups.length - 1
    }
    groupOf.set(e.id, g)
    const grp = neutralGroups[g]
    grp.alive++
    grp.size = Math.max(grp.size, grp.alive)
  }
  for (const e of s.ents.values()) addNeutral(e)
  // 有技能的实体：什么时候出生、死掉，放技能的时间（「可能的问题」里看冷却好了多久才放）
  const skillOwners = new Map<number, { owner: number; type: string; born: number; died: number | null; casts: { t: number; s: string }[] }>()
  const trackSkills = (e: EntSnap, t: number) => {
    if (e.owner >= 0 && types[e.type]?.skills?.length && !skillOwners.has(e.id)) skillOwners.set(e.id, { owner: e.owner, type: e.type, born: t, died: null, casts: [] })
  }
  for (const e of s.ents.values()) trackSkills(e, 0)
  // 玩家的能攻击的建筑（箭塔这类）：开火几次、打死几个、被拆没有（D-194，试写反馈：塔的账要自己解析回放才算得出来）
  // D-195（第五轮试写：看不出塔是被谁拆的、放在哪）：每座记下位置、出现和被拆的 tick、最后一击是谁
  const armed = new Map<number, { owner: number; type: string; x: number; y: number; born: number; shots: number; kills: number; died: boolean; diedAt: number; by: number }>()
  const trackArmed = (e: EntSnap, t: number) => {
    if (e.owner >= 0 && e.owner < n && kind(e.type) === "building" && types[e.type]?.attack && !armed.has(e.id))
      armed.set(e.id, { owner: e.owner, type: e.type, x: e.x, y: e.y, born: t, shots: 0, kills: 0, died: false, diedAt: -1, by: -1 })
  }
  for (const e of s.ents.values()) trackArmed(e, 0)
  /** 工人闲着的开始时间 */
  const idleFrom = new Map<number, number>()
  const idleSpans: IdleSpan[] = []
  /** 工人最后一个不是 idle 的命令；闲下来时记下当时在做什么 */
  const lastOrd = new Map<number, string>()
  const idleBefore = new Map<number, string>()
  const idleAt = new Map<number, { x: number; y: number; zone: string | null }>()
  const at = (e: { x: number; y: number }) => `(${e.x}, ${e.y})`
  /** 两个实体占地之间的曼哈顿距离（贴着 = 1） */
  const snapDist = (a: EntSnap, b: EntSnap) => {
    const aw = types[a.type]?.w ?? 1, ah = types[a.type]?.h ?? 1, bw = types[b.type]?.w ?? 1, bh = types[b.type]?.h ?? 1
    return Math.max(0, b.x - (a.x + aw - 1), a.x - (b.x + bw - 1)) + Math.max(0, b.y - (a.y + ah - 1), a.y - (b.y + bh - 1))
  }
  const closeIdle = (e: EntSnap, t: number) => {
    const from = idleFrom.get(e.id)
    if (from === undefined) return
    idleFrom.delete(e.id)
    const st = idleAt.get(e.id) ?? { x: e.x, y: e.y, zone: null }
    if (t - from >= LONG_IDLE) idleSpans.push({ id: e.id, type: e.type, owner: e.owner, from, to: t, x: e.x, y: e.y, before: idleBefore.get(e.id) ?? "", sx: st.x, sy: st.y, zone: st.zone })
  }
  const startIdle = (id: number, t: number, born: string) => {
    if (idleFrom.has(id)) return
    idleFrom.set(id, t)
    const o = lastOrd.get(id)
    const m = o ? /#(\d+)/.exec(o) : null
    idleBefore.set(id, o ? `闲下来之前在 ${o}${m && !s.ents.has(Number(m[1])) ? `（#${m[1]} 这时已经没了）` : ""}` : born)
    const e = s.ents.get(id)
    if (e) {
      const z = s.markers.find((mk) => mk.kind === "zone" && e.x >= mk.x && e.x < mk.x + mk.w && e.y >= mk.y && e.y < mk.y + mk.h)
      idleAt.set(id, { x: e.x, y: e.y, zone: z && z.kind === "zone" ? (z.label ?? "") : null })
    }
  }
  for (const e of s.ents.values()) {
    if (e.owner < 0 || !isWorker(e.type)) continue
    if (e.ord === "idle") startIdle(e.id, 0, "开局就闲着")
    else lastOrd.set(e.id, e.ord)
  }

  // 白送的单位（侦察兵这类：不花钱、不是工人）：造不出来，丢了就没了；它戳一下不算「第一次交火」
  const isFree = (type: string) => kind(type) === "unit" && !isWorker(type) && !Object.values(types[type]?.cost ?? {}).some((c) => (c ?? 0) > 0)
  // 出兵顺序：每个玩家造出来的兵，按先后
  const armyOrder = Array.from({ length: n }, () => [] as string[])
  // 兵营利用率（前 UTIL_T tick）：能出兵的建筑建好后在场的时间，和造出来的兵的生产用时之和
  const UTIL_T = Math.min(last, 3000)
  /** 有能同时造好几个的建筑（D-196）：利用率按生产位算 */
  const multiSlot = Object.values(types).some((t) => (t.parallel ?? 1) > 1)
  const makesArmy = (type: string) => kind(type) === "building" && (types[type]?.produces ?? []).some(isArmy)
  const producerSince = new Map<number, number>()
  const producerTime = new Array<number>(n).fill(0)
  const armyBuildTime = new Array<number>(n).fill(0)
  const producerGone = (id: number, owner: number, t: number) => {
    const since = producerSince.get(id)
    if (since === undefined) return
    producerSince.delete(id)
    // 能同时造几个就算几个生产位（D-196）
    const slots = types[s.ents.get(id)?.type ?? ""]?.parallel ?? 1
    if (owner >= 0 && owner < n) producerTime[owner] += Math.max(0, Math.min(t, UTIL_T) - since) * slots
  }
  for (const e of s.ents.values()) if (e.owner >= 0 && e.owner < n && makesArmy(e.type) && e.bp === undefined) producerSince.set(e.id, 0)
  // 家里挨打：被兵打在自己建筑 10 格内的（派出去侦察的单位在对方家门口挨打、对方侦察兵路过戳一下都不算）
  const firstHomeHit = new Array<number>(n).fill(-1)
  const nearHome = (e: EntSnap) => {
    for (const b of s.ents.values()) if (b.owner === e.owner && kind(b.type) === "building" && snapDist(b, e) <= 10) return true
    return false
  }
  // 有兵种克制的规则包（attack.vs）：记下每一下打了多少、是不是打在被自己克的兵上，战斗一节按兵种列（D-167，试写反馈）
  const hasCounters = Object.values(types).some((t) => t.attack?.vs && Object.keys(t.attack.vs).length > 0)
  /** 有光环或者回放里出现过增益（D-186）：战斗一节列出增益覆盖了多少兵 */
  const hasBuffs = Object.values(types).some((t) => t.auras?.length) || replay.frames.some((f) => f.bf?.length)
  // 每一下都记（谁打的：战斗一节数「战场附近没出手的兵」也用它），伤害按克制倍数算
  const hits: { t: number; x: number; y: number; id: number; owner: number; from: string; to: string; dmg: number; bonus: boolean }[] = []
  // 采矿：工人的命令从"gather #矿 回程"变回"gather #矿"就是交了一次货（D-167，试写反馈：战报看不出采矿效率、工人挤在一个矿上）
  const mining = new Map<string, { owner: number; mine: number; x: number; y: number; w: number; h: number; deliveries: number; cycles: number[]; now: number; max: number; waiting: number }>()
  /** 上次看的时候工人在哪（判断是不是站着没动） */
  const waitPos = new Map<number, number>()
  const assigned = new Map<number, { owner: number; mine: number }>()
  const lastDelivery = new Map<number, { t: number; mine: number }>()
  const assign = (id: number, owner: number, ord: string | null) => {
    const m = ord ? /^gather #(\d+)/.exec(ord) : null
    const mine = m ? Number(m[1]) : -1
    const old = assigned.get(id)
    if (old && old.mine === mine) return
    if (old) mining.get(`${old.owner}|${old.mine}`)!.now--
    assigned.delete(id)
    if (mine < 0) return
    const r = s.ents.get(mine)
    const k = `${owner}|${mine}`
    const row = mining.get(k) ?? { owner, mine, x: r?.x ?? 0, y: r?.y ?? 0, w: types[r?.type ?? ""]?.w ?? 1, h: types[r?.type ?? ""]?.h ?? 1, deliveries: 0, cycles: [], now: 0, max: 0, waiting: 0 }
    row.now++
    row.max = Math.max(row.max, row.now)
    mining.set(k, row)
    assigned.set(id, { owner, mine })
  }
  for (const e of s.ents.values()) if (e.owner >= 0 && isWorker(e.type)) assign(e.id, e.owner, e.ord)

  for (const f of replay.frames) {
    // 交火、挨打：用这一帧之前的局面查归属（这一帧死的也还在）
    const sh = f.shots ?? []
    for (let i = 0; i < sh.length; i += 2) {
      const a = s.ents.get(sh[i])
      const tg = s.ents.get(sh[i + 1])
      if (!a || !tg) continue
      // 最后一击：玩家编号；中立实体打的记 -2
      lastHit.set(tg.id, a.owner >= 0 ? a.owner : -2)
      lastHitter.set(tg.id, { id: a.id, type: a.type, x: a.x, y: a.y })
      const ab = armed.get(a.id)
      if (ab) ab.shots++
      if (!enemies(a.owner, tg.owner)) continue
      if (firstContact < 0 && !isFree(a.type) && !isFree(tg.type)) {
        firstContact = f.t
        events.push({ t: f.t, p: -1, text: `第一次交火：P${a.owner} 的 ${a.type} 打 P${tg.owner} 的 ${tg.type}，在 ${at(tg)}`, cat: "key" })
      }
      if (firstHitTaken[tg.owner] < 0) firstHitTaken[tg.owner] = f.t
      if (firstHomeHit[tg.owner] < 0 && isArmy(a.type) && nearHome(tg)) firstHomeHit[tg.owner] = f.t
      const atk = types[a.type]?.attack
      const m = atk?.vs?.[tg.type]
      const dmg = a.st?.attack?.damage ?? atk?.damage ?? 0
      hits.push({ t: f.t, x: tg.x, y: tg.y, id: a.id, owner: a.owner, from: a.type, to: tg.type, dmg: m === undefined ? dmg : Math.round(dmg * m), bonus: (m ?? 1) > 1 })
      if (firstHitDealt[a.owner] < 0) firstHitDealt[a.owner] = f.t
      if (kind(tg.type) === "building" && firstBuildingHit[tg.owner] < 0) {
        firstBuildingHit[tg.owner] = f.t
        events.push({ t: f.t, p: tg.owner, text: `${who(tg.owner)}的建筑第一次挨打：${tg.type} ${at(tg)}，打它的是 P${a.owner} 的 ${a.type}`, cat: "key" })
      }
    }
    const removedNow = new Set(f.removed ?? [])
    for (const id of f.die ?? []) {
      const e = s.ents.get(id)
      if (!e) continue
      closeIdle(e, f.t)
      if (assigned.has(id)) assign(id, e.owner, null)
      producerGone(id, e.owner, f.t)
      if (removedNow.has(id)) {
        const k = `${e.owner}|${e.type}`
        removedBy.set(k, (removedBy.get(k) ?? 0) + 1)
        continue
      }
      if (kind(e.type) === "resource") {
        events.push({ t: f.t, p: -1, text: `${at(e)} 的 ${e.type} 采完了`, cat: "depleted" })
        continue
      }
      const by = lastHit.get(id) ?? -1
      deaths.push({ t: f.t, owner: e.owner, type: e.type, x: e.x, y: e.y, by, ord: e.ord })
      // 最后一击是谁的什么单位、在哪（D-188，试写反馈：只写玩家编号看不出领主是被塔还是兵打死的）
      const hitter = lastHitter.get(id)
      const killer = hitter ? armed.get(hitter.id) : undefined
      if (killer) killer.kills++
      const dead = armed.get(id)
      if (dead) {
        dead.died = true
        dead.diedAt = f.t
        dead.by = by
      }
      const so = skillOwners.get(id)
      if (so) so.died = f.t
      const ng = groupOf.get(id)
      if (ng !== undefined) {
        const grp = neutralGroups[ng]
        grp.alive--
        if (by >= 0 && by < n) grp.kills[by]++
        if (grp.alive === 0) grp.clears.push({ t: f.t, by })
      }
      const killerGroup = by === -2 && hitter ? groupOf.get(hitter.id) : undefined
      if (killerGroup !== undefined && e.owner >= 0) {
        const m = neutralGroups[killerGroup].slain.get(e.owner) ?? new Map<string, number>()
        m.set(e.type, (m.get(e.type) ?? 0) + 1)
        neutralGroups[killerGroup].slain.set(e.owner, m)
      }
      const byText = by >= 0 ? `，最后一击是 P${by}${hitter ? ` 的 ${hitter.type} ${at(hitter)}` : ""}` : by === -2 ? (hitter ? `，被中立的 ${hitter.type} 打死` : "，被中立实体打死") : ""
      if (e.owner < 0) events.push({ t: f.t, p: -1, text: `中立的 ${e.type} 死了 ${at(e)}${byText}` })
      else if (isFree(e.type)) events.push({ t: f.t, p: e.owner, text: `${who(e.owner)}失去 ${e.type}（这种单位造不出来，丢了就没了）${at(e)}${byText}`, cat: "key" })
      else if (kind(e.type) === "building") events.push({ t: f.t, p: e.owner, text: `${who(e.owner)}失去 ${e.type}${e.bp !== undefined ? "（还没建好）" : ""} ${at(e)}${byText}` })
    }
    for (const nt of f.notes ?? []) events.push({ t: f.t, p: nt.p, text: `（规则包）${nt.text}`, cat: "key" })
    const delta = applyFrame(s, f)
    // 换主人：同一 tick、同一对主人之间换了好几个（比如出局时整队交给队友）合成一行
    const moves = new Map<string, { from: number; to: number; ents: EntSnap[] }>()
    for (const o of delta.owned) {
      const e = s.ents.get(o.id)!
      const k = `${o.from}>${e.owner}`
      const g = moves.get(k) ?? { from: o.from, to: e.owner, ents: [] }
      g.ents.push(e)
      moves.set(k, g)
      if (e.owner >= 0 && e.owner < n && isArmy(e.type) && firstArmy[e.owner] < 0) firstArmy[e.owner] = f.t
      if (e.owner < 0) idleFrom.delete(e.id)
    }
    for (const g of moves.values()) {
      const to = g.to < 0 ? "中立" : g.to === me ? "你" : " " + who0(g.to)
      const from = g.from < 0 ? "中立" : who(g.from)
      if (g.ents.length <= 2)
        for (const e of g.ents) events.push({ t: f.t, p: -1, text: `${from}的 ${e.type} #${e.id} ${at(e)} 换主人，归了${to}`, cat: "key" })
      else {
        const m = new Map<string, number>()
        for (const e of g.ents) m.set(e.type, (m.get(e.type) ?? 0) + 1)
        events.push({ t: f.t, p: -1, text: `${from}的 ${g.ents.length} 个实体（${countList(m)}）换主人，归了${to}`, cat: "key" })
      }
    }
    for (const c of f.casts ?? []) skillOwners.get(c.u)?.casts.push({ t: f.t, s: c.s })
    for (const e of f.spawn ?? []) {
      addNeutral(e)
      trackSkills(e, f.t)
      trackArmed(e, f.t)
      if (initialIds.has(e.id) || e.owner < 0 || e.owner >= n) continue
      // 玩家放的地基一出来就有建造进度；直接是建好的建筑，是规则包放的
      if (kind(e.type) === "building" && e.bp === undefined) {
        if (makesArmy(e.type)) producerSince.set(e.id, Math.min(f.t, UTIL_T))
        events.push({ t: f.t, p: e.owner, text: `规则包给${e.owner === me ? "你" : ` ${who0(e.owner)} `}放了 ${e.type} ${at(e)}` })
        continue
      }
      const cost = types[e.type]?.cost ?? {}
      for (const [r, c] of Object.entries(cost)) {
        spent[e.owner].set(r, (spent[e.owner].get(r) ?? 0) + (c ?? 0))
        spentTotal[e.owner] += c ?? 0
      }
      if (isWorker(e.type)) {
        if (e.ord === "idle") startIdle(e.id, f.t, "造出来就闲着")
        else lastOrd.set(e.id, e.ord)
        assign(e.id, e.owner, e.ord)
      }
      if (isArmy(e.type) && firstArmy[e.owner] < 0) firstArmy[e.owner] = f.t
      if (isArmy(e.type)) {
        armyOrder[e.owner].push(e.type)
        if (f.t <= UTIL_T) armyBuildTime[e.owner] += types[e.type]?.buildTicks ?? 0
      }
      if (kind(e.type) === "building") events.push({ t: f.t, p: e.owner, text: `${who(e.owner)}放下 ${e.type} 的地基 ${at(e)}` })
      else if (kind(e.type) === "unit" && !firstMade[e.owner].has(e.type)) {
        firstMade[e.owner].add(e.type)
        events.push({ t: f.t, p: e.owner, text: `${who(e.owner)}第一次造出 ${e.type}`, cat: "key" })
      }
    }
    for (const [id, ord] of f.ord ?? []) {
      const e = s.ents.get(id)
      if (!e || e.owner < 0 || !isWorker(e.type)) continue
      // 交货：上一个命令是去某个矿的回程，这次变回去采同一个矿
      const prev = lastOrd.get(id)
      const back = prev ? /^gather #(\d+) 回程$/.exec(prev) : null
      if (back && ord === `gather #${back[1]}`) {
        const mine = Number(back[1])
        const row = mining.get(`${e.owner}|${mine}`)
        if (row) {
          row.deliveries++
          const ld = lastDelivery.get(id)
          if (ld && ld.mine === mine) row.cycles.push(f.t - ld.t)
        }
        lastDelivery.set(id, { t: f.t, mine })
      }
      assign(id, e.owner, ord)
      if (ord === "idle") startIdle(id, f.t, "造出来就闲着")
      else {
        closeIdle(e, f.t)
        lastOrd.set(id, ord)
      }
    }
    const bp = f.bp ?? []
    for (let i = 0; i < bp.length; i += 2) {
      if (bp[i + 1] < 100) continue
      const e = s.ents.get(bp[i])
      if (e && e.owner >= 0) events.push({ t: f.t, p: e.owner, text: `${who(e.owner)}的 ${e.type} 建好了` })
      if (e && e.owner >= 0 && makesArmy(e.type)) producerSince.set(e.id, Math.min(f.t, UTIL_T))
    }
    // 每 10 tick 看一次：派去采矿（不是回程）、没贴着矿、位置也没变的工人，就是在矿旁边排队等空位
    if (f.t % 10 === 0)
      for (const [id, a] of assigned) {
        const w = s.ents.get(id)
        const r = s.ents.get(a.mine)
        if (!w || !r) continue
        const pos = w.x * 4096 + w.y
        if (w.ord === `gather #${a.mine}` && snapDist(w, r) > 1 && waitPos.get(id) === pos) mining.get(`${a.owner}|${a.mine}`)!.waiting += 10
        waitPos.set(id, pos)
      }
    if (f.t % every === 0 || f.t === last) takeSample(f.t)
  }
  if (samples[samples.length - 1].t !== last) takeSample(last)
  for (const e of s.ents.values()) closeIdle(e, last)
  for (const [id] of producerSince) producerGone(id, s.ents.get(id)?.owner ?? -1, last)

  // ---------- 输出 ----------
  const r = replay.result
  const out: string[] = []
  const won = r.winners ?? []
  const outcome = won.length === 0 ? "平局" : `${won.map((p) => `P${p}（${replay.players[p].name}）`).join("、")}获胜`
  out.push(`# 战报：${replay.ruleset.name}（${replay.ruleset.id}），种子 ${replay.seed}`)
  out.push(`第 ${r.tick} tick 结束：${outcome}——${r.reason}`)
  out.push(`参赛：${replay.players.map((p, i) => `P${i} ${p.name}${n > 2 && new Set(replay.players.map((x) => x.team)).size < n ? `（队${team(i) + 1}）` : ""}`).join("，")}${me !== undefined ? `；你是 P${me}` : ""}`)
  out.push("")

  out.push(
    `## 局势（每 ${every} tick；收入是这一段采到的，估算：生产队列里还没造出来的已经扣了钱、还没算进花费，所以偶尔是负数；单位后面括号里是闲着的个数，建筑括号里是没建好的个数）`,
  )
  samples.forEach((smp, i) => {
    for (const p of seatOrder) {
      const ps = smp.players[p]
      const prev = i > 0 ? samples[i - 1].players[p] : null
      const income = prev ? sum(ps.res) - sum(prev.res) + ps.spentSoFar - prev.spentSoFar : 0
      const units = [...ps.units].map(([k, u]) => `${k}×${u.n}${u.idle ? `（闲 ${u.idle}）` : ""}`).join(" ") || "无"
      const blds = [...ps.buildings].map(([k, b]) => `${k}×${b.n}${b.building ? `（${b.building}）` : ""}`).join(" ") || "无"
      const head = p === seatOrder[0] ? `t${smp.t}`.padEnd(7) : "".padEnd(7)
      out.push(`${head} ${who0(p)}${ps.alive ? "" : "（已出局）"}：${fmtRes(ps.res)}${prev ? `（收入 ${income < 0 ? "−" : "+"}${Math.abs(Math.round(income))}）` : ""}，分 ${Math.round(ps.score)} | 单位 ${units} | 建筑 ${blds}`)
    }
  })
  out.push("")

  out.push("## 关键事件")
  const shown = events.filter((e) => me === undefined || e.p === -1 || e.p === me || enemies(e.p, me) || team(e.p) === team(me))
  // 太多时：先把资源点采完的合成一行；还多就保留开头和结尾（结尾往往是输掉的那几下），中间只留"第一次……"、换主人这些
  const HEAD = 15
  const TAIL = 30
  const line = (e: (typeof events)[number]) => `t${e.t}  ${e.text}`
  if (opts.full || shown.length <= HEAD + TAIL) for (const e of shown) out.push(line(e))
  else {
    const dep = shown.filter((e) => e.cat === "depleted")
    const rest = shown.filter((e) => e.cat !== "depleted")
    if (rest.length <= HEAD + TAIL) for (const e of rest) out.push(line(e))
    else {
      const mid = rest.slice(HEAD, -TAIL)
      const keep = mid.filter((e) => e.cat === "key").slice(0, 20)
      for (const e of rest.slice(0, HEAD)) out.push(line(e))
      for (const e of keep) out.push(line(e))
      out.push(`（t${mid[0].t}～t${mid[mid.length - 1].t} 之间略去 ${mid.length - keep.length} 条：放地基、建好、失去建筑这些）`)
      for (const e of rest.slice(-TAIL)) out.push(line(e))
    }
    if (dep.length) out.push(`资源点采完了 ${dep.length} 处（t${dep[0].t}～t${dep[dep.length - 1].t}）`)
    out.push("（加 --full 列出全部事件）")
  }
  if (firstContact < 0) out.push("整局双方没有交过火")
  out.push("")

  // 战斗：切分规则见 battles.ts（和精彩对局、联赛视频一样），3 个以上才列
  const big = groupBattles(deaths).filter((b) => b.length >= MIN_BATTLE)
  const fighter = fighterTest(types)
  const rout = (b: Death[]) => isRout(b.map((d) => ({ owner: d.owner, fighter: fighter(d.type) })), team)
  /** 这场开打前一刻各方的兵数（不算工人） */
  const armyBefore = (b: Death[]) => {
    const st = model.stateAt(Math.max(0, b[0].t - 1))
    const army = new Array<number>(n).fill(0)
    for (const e of st.ents.values()) if (e.owner >= 0 && e.owner < n && isArmy(e.type)) army[e.owner]++
    return army
  }
  /** 矿旁边站得下几个工人：贴着矿、地形能走、开局没被建筑和资源点占着的格子数（老回放没记地形能不能走时是 null） */
  const walkable = replay.map.walkable
  const blocked = new Set<number>()
  for (const e of model.initialState().ents.values()) {
    if (kind(e.type) === "unit") continue
    const t = types[e.type]
    for (let y = e.y; y < e.y + (t?.h ?? 1); y++) for (let x = e.x; x < e.x + (t?.w ?? 1); x++) blocked.add(y * 4096 + x)
  }
  const mineCapacity = (r: { x: number; y: number; w: number; h: number }): number | null => {
    if (!walkable) return null
    const cells: [number, number][] = []
    for (let x = r.x; x < r.x + r.w; x++) cells.push([x, r.y - 1], [x, r.y + r.h])
    for (let y = r.y; y < r.y + r.h; y++) cells.push([r.x - 1, y], [r.x + r.w, y])
    return cells.filter(([x, y]) => x >= 0 && y >= 0 && x < replay.map.width && y < replay.map.height && walkable[replay.map.terrain[y][x]] && !blocked.has(y * 4096 + x)).length
  }
  /** 一场战斗期间（开打前 60 tick 到最后一个死亡）、战场 15 格内打出的每一下 */
  const battleHits = (b: Death[]) => {
    const cx = b.reduce((a, x) => a + x.x, 0) / b.length
    const cy = b.reduce((a, x) => a + x.y, 0) / b.length
    return hits.filter((h) => h.t >= b[0].t - 60 && h.t <= b[b.length - 1].t && Math.abs(h.x - cx) + Math.abs(h.y - cy) <= 15)
  }
  /** 一场战斗开打 30 tick 时，战场 10 格内各方的兵里开打以来一下都没打的（在附近却没出手），按当时的命令分类 */
  const idleCache = new Map<Death[], Map<number, { near: number; n: number; ords: Map<string, number> }>>()
  const idleInBattle = (b: Death[]) => {
    const cached = idleCache.get(b)
    if (cached) return cached
    const tm = Math.min(b[0].t + 30, b[b.length - 1].t)
    const fired = new Set(battleHits(b).filter((h) => h.t <= tm).map((h) => h.id))
    const cx = b.reduce((a, x) => a + x.x, 0) / b.length
    const cy = b.reduce((a, x) => a + x.y, 0) / b.length
    const st = model.stateAt(tm)
    const res = new Map<number, { near: number; n: number; ords: Map<string, number> }>()
    for (const e of st.ents.values()) {
      if (e.owner < 0 || e.owner >= n || !isArmy(e.type) || Math.abs(e.x - cx) + Math.abs(e.y - cy) > 10) continue
      const r = res.get(e.owner) ?? { near: 0, n: 0, ords: new Map<string, number>() }
      r.near++
      if (!fired.has(e.id)) {
        r.n++
        const k = e.ord.split(" ")[0]
        r.ords.set(k, (r.ords.get(k) ?? 0) + 1)
      }
      res.set(e.owner, r)
    }
    idleCache.set(b, res)
    return res
  }
  /**
   * 开打时的队形（D-175，选手反馈）：这一仗打出第一下的那个 tick，战场 20 格内各方的兵占多大一块（外接矩形）、
   * 离自己这群兵的中心平均几格、几个离中心 FORM_FAR 格以上（掉队的），距离按横竖格数加起来算
   */
  const FORM_FAR = 6
  const formCache = new Map<Death[], { t: number; sides: Map<number, { n: number; w: number; h: number; avg: number; far: number }> }>()
  const formation = (b: Death[]) => {
    const cached = formCache.get(b)
    if (cached) return cached
    // 紧挨着上一仗的：从上一个死亡之后找第一下，不要算到上一仗的
    const prev = deaths.reduce((a, d) => (d.t < b[0].t ? Math.max(a, d.t) : a), -1)
    const t = battleHits(b).find((h) => h.t > prev)?.t ?? Math.max(0, b[0].t - 1)
    const cx = b.reduce((a, x) => a + x.x, 0) / b.length
    const cy = b.reduce((a, x) => a + x.y, 0) / b.length
    const pos = new Map<number, [number, number][]>()
    for (const e of model.stateAt(t).ents.values()) {
      if (e.owner < 0 || e.owner >= n || !isArmy(e.type) || Math.abs(e.x - cx) + Math.abs(e.y - cy) > 20) continue
      pos.set(e.owner, [...(pos.get(e.owner) ?? []), [e.x, e.y]])
    }
    const sides = new Map<number, { n: number; w: number; h: number; avg: number; far: number }>()
    for (const [p, ps] of pos) {
      const mx = ps.reduce((a, [x]) => a + x, 0) / ps.length
      const my = ps.reduce((a, [, y]) => a + y, 0) / ps.length
      const d = ps.map(([x, y]) => Math.abs(x - mx) + Math.abs(y - my))
      const xs = ps.map(([x]) => x)
      const ys = ps.map(([, y]) => y)
      sides.set(p, { n: ps.length, w: Math.max(...xs) - Math.min(...xs) + 1, h: Math.max(...ys) - Math.min(...ys) + 1, avg: d.reduce((a, x) => a + x, 0) / d.length, far: d.filter((x) => x >= FORM_FAR).length })
    }
    const res = { t, sides }
    formCache.set(b, res)
    return res
  }
  const ordText = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("、")
  out.push(`## 战斗（死 3 个以上的；只有一方在死人、有一方没死兵、或者死得少的一方不到对方的 1/4 的，标「一边倒」，精彩对局不算大战${hasCounters ? "。「伤害」一行是这一仗各方打出的伤害按 攻击方→目标 列，括号里是打在被自己克的兵上（吃到克制倍数）的比例" : ""}）`)
  if (big.length === 0) out.push("没有")
  const shownBattles = big.length > 15 && !opts.full ? [...big.slice(0, 5), null, ...big.slice(-10)] : big
  for (const b of shownBattles) {
    if (!b) {
      out.push(`（中间略去 ${big.length - 15} 场）`)
      continue
    }
    const cx = Math.round(b.reduce((a, x) => a + x.x, 0) / b.length)
    const cy = Math.round(b.reduce((a, x) => a + x.y, 0) / b.length)
    const loss = [...new Set(b.map((d) => d.owner))]
      .sort()
      .map((p) => {
        const m = new Map<string, number>()
        for (const d of b) if (d.owner === p) m.set(d.type, (m.get(d.type) ?? 0) + 1)
        return `${p < 0 ? "中立" : who(p)}损失 ${countList(m)}`
      })
    const sidesIn = [...new Set(b.map((d) => d.owner))].filter((p) => p >= 0).sort()
    const army = hasArmy && sidesIn.length > 0 ? armyBefore(b) : null
    out.push(`t${b[0].t}～${b[b.length - 1].t} 在 (${cx}, ${cy}) 附近${rout(b) ? "（一边倒）" : ""}：${loss.join("；")}${army ? `（开打时兵数：${sidesIn.map((p) => `${who0(p)} ${army[p]}`).join("，")}）` : ""}`)
    // 开打时各方的队形：散成一长串的一方往往是被逐个吃掉
    if (hasArmy) {
      const fm = formation(b)
      const forms = [...fm.sides].filter(([, f]) => f.n >= 2).sort((x, y) => x[0] - y[0])
      if (forms.length)
        out.push(
          `  队形：t${fm.t} 打出第一下时战场 20 格内，${forms.map(([p, f]) => `${who0(p)} ${f.n} 个兵占 ${f.w}×${f.h} 格、离自己中心平均 ${f.avg.toFixed(1)} 格${f.far ? `（${FORM_FAR} 格以上 ${f.far} 个）` : ""}`).join("；")}`,
        )
      // 增益（光环、技能）覆盖了多少兵、战场在不在能攻击的建筑（箭塔）射程里（D-188）
      const st = model.stateAt(fm.t)
      const near = [...st.ents.values()].filter((e) => e.owner >= 0 && e.owner < n && Math.abs(e.x - cx) + Math.abs(e.y - cy) <= 20)
      if (hasBuffs) {
        const parts = sidesIn.flatMap((p) => {
          const mine = near.filter((e) => e.owner === p && isArmy(e.type))
          if (mine.length === 0) return []
          const names = new Set(mine.flatMap((e) => e.bf ?? []))
          return [`${who0(p)} ${mine.filter((e) => e.bf?.length).length}/${mine.length} 个兵${names.size ? `（${[...names].join("、")}）` : ""}`]
        })
        if (parts.length) out.push(`  增益：开打时战场 20 格内带增益的兵 ${parts.join("，")}`)
      }
      const towers = new Map<number, Map<string, number>>()
      for (const e of near) {
        const atk = types[e.type]?.attack
        if (kind(e.type) !== "building" || !atk || e.bp !== undefined) continue
        const w = types[e.type]?.w ?? 1
        const h = types[e.type]?.h ?? 1
        const dx = Math.max(0, e.x - cx, cx - (e.x + w - 1))
        const dy = Math.max(0, e.y - cy, cy - (e.y + h - 1))
        if (dx + dy > (e.st?.attack?.range ?? atk.range) + 1) continue
        const m = towers.get(e.owner) ?? new Map<string, number>()
        m.set(e.type, (m.get(e.type) ?? 0) + 1)
        towers.set(e.owner, m)
      }
      if (towers.size) out.push(`  战场在${[...towers].map(([p, m]) => `${who(p)}${countList(m)}`).join("、")}的射程内（打出第一下时，离战场中心不超过射程 + 1 格）`)
    }
    // 在战场附近却一下都没打的兵（停着的兵只打射程内的，团战时没给命令就干站着）
    const idle = [...idleInBattle(b)].filter(([, r]) => r.n >= 3).sort((x, y) => x[0] - y[0])
    if (idle.length)
      out.push(
        `  没出手：开打 30 tick 时战场 10 格内，${idle.map(([p, r]) => `${who(p)}有 ${r.n} 个兵（共 ${r.near} 个）一下都没打（${ordText(r.ords)}）`).join("；")}` +
          // D-201（试写反馈：move 的兵看着像挨打不还手）：move 是还在路上
          (idle.some(([, r]) => r.ords.has("move")) ? "。move 的是还在路上（move 不还手），idle 的是停着没够着" : ""),
      )
    // 有克制的规则包：这一仗各方打出的伤害按"谁打谁"列，看兵是不是在打被自己克的
    if (hasCounters) {
      const inFight = battleHits(b)
      const parts = [...new Set(inFight.map((h) => h.owner))].sort().map((p) => {
        const mine = inFight.filter((h) => h.owner === p)
        const total = mine.reduce((a, h) => a + h.dmg, 0)
        const bonus = mine.filter((h) => h.bonus).reduce((a, h) => a + h.dmg, 0)
        const pairs = new Map<string, number>()
        for (const h of mine) pairs.set(`${h.from}→${h.to}`, (pairs.get(`${h.from}→${h.to}`) ?? 0) + h.dmg)
        const top = [...pairs].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, v]) => `${k} ${v}`)
        return `${who(p)}打出 ${total}（打在被自己克的兵上 ${total ? Math.round((100 * bonus) / total) : 0}%）：${top.join("、")}${pairs.size > 4 ? "……" : ""}`
      })
      if (parts.length) out.push(`  伤害：${parts.join("；")}`)
    }
  }
  out.push("")

  out.push("## 经济和损失")
  // 每家放了哪些技能、各几次（D-186）：释放者的归属按回放里的出生和换主人算
  const castsBy = [...Array(n)].map(() => new Map<string, number>())
  {
    const ownerOf = new Map<number, number>()
    for (const e of replay.initial.entities) ownerOf.set(e.id, e.owner)
    const skillName = (id: string) => Object.values(replay.types).flatMap((t) => t.skills ?? []).find((k) => k.id === id)?.name ?? id
    for (const f of replay.frames) {
      for (const e of f.spawn ?? []) ownerOf.set(e.id, e.owner)
      const ow = f.owner ?? []
      for (let i = 0; i < ow.length; i += 2) ownerOf.set(ow[i], ow[i + 1])
      for (const c of f.casts ?? []) {
        const p = ownerOf.get(c.u)
        if (p !== undefined && p >= 0 && p < n) castsBy[p].set(skillName(c.s), (castsBy[p].get(skillName(c.s)) ?? 0) + 1)
      }
    }
  }
  const after = samples.slice(1)
  const incomeOf: number[] = []
  for (let p = 0; p < n; p++) incomeOf[p] = sum(samples[samples.length - 1].players[p].res) - sum(initialRes[p]) + spentTotal[p]
  for (const p of seatOrder) {
    if (me !== undefined && p !== me && !enemies(p, me) && team(p) !== team(me)) continue
    const lost = new Map<string, number>()
    const killed = new Map<string, number>()
    for (const d of deaths) {
      if (d.owner === p) lost.set(d.type, (lost.get(d.type) ?? 0) + 1)
      if (d.by === p && d.owner !== p) killed.set(d.owner < 0 ? `中立 ${d.type}` : d.type, (killed.get(d.owner < 0 ? `中立 ${d.type}` : d.type) ?? 0) + 1)
    }
    const fin = samples[samples.length - 1].players[p].res
    const income = Object.keys(fin)
      .map((k) => `${k} ${Math.round(fin[k] - (initialRes[p][k] ?? 0) + (spent[p].get(k) ?? 0))}`)
      .join(" ")
    const spentText = [...spent[p]].map(([k, v]) => `${k} ${v}`).join(" ") || "0"
    const bank = Object.keys(fin)
      .map((k) => `${k} ${Math.round(after.reduce((a, smp) => a + (smp.players[p].res[k] ?? 0), 0) / Math.max(1, after.length))}`)
      .join(" ")
    out.push(`${who0(p)}：采集约 ${income}（估算：结束时剩的 − 开局的 + 造东西花掉的），花掉 ${spentText}，抽样时平均手上留着 ${bank}；整局损失 ${countList(lost)}；整局击杀 ${countList(killed)}`)
    if (castsBy[p].size) out.push(`  放技能：${[...castsBy[p]].map(([k, v]) => `${k} ×${v}`).join("、")}`)
    else if (Object.values(replay.types).some((t) => t.skills?.length)) out.push("  放技能：一次都没放（规则包里有技能，见说明书单位表下面）")
    const byNeutral = new Map<string, number>()
    for (const d of deaths) if (d.owner === p && d.by === -2) byNeutral.set(d.type, (byNeutral.get(d.type) ?? 0) + 1)
    if (byNeutral.size) out.push(`  被中立单位打死：${countList(byNeutral)}${neutralGroups.length ? "（在哪儿见「中立单位」一节）" : ""}`)
    const towers = [...armed.values()].filter((b) => b.owner === p)
    if (towers.length) {
      const m = new Map<string, number>()
      for (const b of towers) m.set(b.type, (m.get(b.type) ?? 0) + 1)
      const shots = towers.reduce((a, b) => a + b.shots, 0)
      const kills = towers.reduce((a, b) => a + b.kills, 0)
      const idle = towers.filter((b) => b.shots === 0).length
      out.push(
        `  能攻击的建筑：${countList(m)}，被拆 ${towers.filter((b) => b.died).length} 座；一共开火 ${shots} 次、最后一击打死 ${kills} 个（平均每座开火 ${(shots / towers.length).toFixed(1)} 次）${idle ? `；${idle} 座一次都没开火` : ""}`,
      )
      const byText = (b: (typeof towers)[number]) =>
        !b.died ? "留到最后" : `t${b.diedAt} 被${b.by >= 0 ? (b.by === me ? "你" : ` ${who0(b.by)} `) : b.by === -2 ? "中立单位" : "规则包"}拆掉${b.by === -2 ? "（对手不得分）" : ""}`
      for (const b of towers.slice(0, 10)) out.push(`    ${b.type} (${b.x}, ${b.y}) t${b.born} 出现，${byText(b)}：开火 ${b.shots} 次、打死 ${b.kills} 个`)
      if (towers.length > 10) out.push(`    另有 ${towers.length - 10} 座`)
    }
    // 出兵顺序（连着出同一种的合成一个，比如 spearman×2）：看对手按什么规律出兵
    if (armyOrder[p].length) {
      const runs: string[] = []
      const list = armyOrder[p].slice(0, 24)
      for (let i = 0; i < list.length; ) {
        let j = i
        while (j < list.length && list[j] === list[i]) j++
        runs.push(j - i > 1 ? `${list[i]}×${j - i}` : list[i])
        i = j
      }
      if (producerTime[p] > 0) out.push(`  兵营利用率：前 ${UTIL_T} tick 里能出兵的建筑大约 ${Math.round((100 * armyBuildTime[p]) / producerTime[p])}% 的时间在出兵${multiSlot ? "（能同时造几个就按几个生产位算）" : ""}`)
      out.push(`  出兵顺序（前 ${list.length} 个${armyOrder[p].length > list.length ? `，一共 ${armyOrder[p].length} 个` : ""}）：${runs.join("、")}`)
    }
  }
  out.push("")
  if (neutralGroups.length) {
    out.push("## 中立单位（按出生的地方分组：谁打死了几只、什么时候被清空、它们打死了谁）")
    const named = (p: number) => (p === -2 ? "中立" : p < 0 ? "没人" : who0(p))
    for (const g of neutralGroups) {
      const kills = g.kills.map((k, p) => (k ? `${who(p)}打死 ${k} 只` : "")).filter(Boolean)
      const clears = g.clears.map((c) => `t${c.t} ${named(c.by)}`)
      const slain = [...g.slain].sort((a, b) => a[0] - b[0]).map(([p, m]) => `打死${p === me ? "你" : ` ${who0(p)} `}的 ${countList(m)}`)
      const parts = [kills.length ? kills.join("、") : "没人打死过", clears.length ? `清空 ${clears.length} 次：${clears.slice(0, 6).join("、")}${clears.length > 6 ? "……" : ""}` : "", ...slain].filter(Boolean)
      out.push(`(${g.x}, ${g.y}) 一带（${g.size} 只）：${parts.join("；")}`)
    }
    out.push("")
  }
  if (mining.size) {
    out.push(
      "## 采矿（每个矿：交了几次货；采一次来回平均几 tick，交货点离矿越近越短；最多同时派了几个工人 / 矿旁边站得下几个；排队是工人站在矿附近等空位的总时间，站满了不会自己换矿）",
    )
    for (const p of seatOrder) {
      if (me !== undefined && p !== me && !enemies(p, me) && team(p) !== team(me)) continue
      const rows = [...mining.values()].filter((r) => r.owner === p && (r.deliveries > 0 || r.max > 0)).sort((a, b) => b.deliveries - a.deliveries)
      if (!rows.length) continue
      const text = rows.slice(0, 8).map((r) => {
        const cap = mineCapacity(r)
        const cyc = r.cycles.length ? `来回约 ${Math.round(r.cycles.reduce((a, c) => a + c, 0) / r.cycles.length)} tick` : "来回 —"
        return `(${r.x}, ${r.y}) 交货 ${r.deliveries} 次、${cyc}、最多派 ${r.max} 人${cap === null ? "" : ` / 站得下 ${cap}`}${r.waiting ? `、排队 ${r.waiting} tick` : ""}`
      })
      out.push(`${who0(p)}：${text.join("；")}${rows.length > 8 ? `；另有 ${rows.length - 8} 个矿` : ""}`)
    }
    out.push("")
  }
  if (removedBy.size) {
    // 规则包按玩法移除的（交了货的商队、过期的道具……）：不算死亡、损失、击杀
    out.push("## 规则包移除的（按玩法移除，不算死亡和损失）")
    const owners = [...new Set([...removedBy.keys()].map((k) => Number(k.split("|")[0])))].sort((a, b) => a - b)
    for (const o of owners) {
      const m = new Map<string, number>()
      for (const [k, v] of removedBy) if (Number(k.split("|")[0]) === o) m.set(k.split("|")[1], v)
      out.push(`${o < 0 ? "中立" : who0(o)}：${countList(m)}`)
    }
    out.push("")
  }
  const custom = replay.result.stats
  if (custom && Object.keys(custom).length) {
    out.push("## 规则包统计（规则包在结果里给的）")
    for (const [k, v] of Object.entries(custom)) out.push(`${k}：${v.map((x, p) => `${who0(p)} ${Math.round(x * 100) / 100}`).join("，")}`)
    out.push("")
  }

  // ---------- 可能的问题（只写看得出来的事实） ----------
  const hintFor = me === undefined ? [...Array(n).keys()] : [me]
  out.push("## 可能的问题")
  let any = false
  for (const p of hintFor) {
    const hints: string[] = []
    const st = replay.bots[p]
    if (st?.status === "dead") hints.push(`bot 停止运行了：${st.deadReason}`)
    if (st && (st.errors > 0 || st.fuelOuts > 0)) hints.push(`报错 ${st.errors} 次、燃料耗尽 ${st.fuelOuts} 次（那几次的命令全部作废）`)
    const kinds = errorKinds(replay, p)
    const rej = kinds.filter((k) => k.msg.startsWith("命令被拒"))
    if (rej.length) hints.push(`被拒命令 ${rej.reduce((a, k) => a + k.n, 0)} 条，最多的一种 ×${rej[0].n}（首次第 ${rej[0].t} tick）：${rej[0].msg.slice(0, 160)}`)
    // 兵营空着：前 UTIL_T tick 里，能出兵的建筑在场的时间里有多少在出兵
    if (producerTime[p] >= 1000 && armyBuildTime[p] / producerTime[p] < 0.35)
      hints.push(
        `前 ${UTIL_T} tick 里能出兵的建筑大约只有 ${Math.round((100 * armyBuildTime[p]) / producerTime[p])}% 的时间在出兵（造出来的兵生产用时加起来 ${armyBuildTime[p]} tick，兵营建好后在场的时间加起来 ${producerTime[p]} tick${multiSlot ? "，能同时造几个就乘几" : ""}）：兵营空着的时候钱去哪了（先补了工人、攒着没花，还是钱不够）`,
      )
    // 工人挤在一个矿上排队（站满了不会自己换矿）
    const queued = [...mining.values()].filter((r) => r.owner === p && r.waiting >= 300).sort((a, b) => b.waiting - a.waiting)
    if (queued.length)
      hints.push(
        `工人在矿旁边排队等空位：${queued
          .slice(0, 3)
          .map((r) => {
            const cap = mineCapacity(r)
            return `(${r.x}, ${r.y}) 一共 ${r.waiting} tick（最多同时派了 ${r.max} 人${cap === null ? "" : `，矿旁边站得下 ${cap} 个`}）`
          })
          .join("、")}。站满了不会自己换矿，把多出来的人分到别的矿（见「采矿」一节）`,
      )
    // 团战时兵在附近停着（idle）干站着：挑停着最多的一仗
    let worst: { t: number; r: { near: number; n: number; ords: Map<string, number> } } | null = null
    for (const b of big) {
      const r = idleInBattle(b).get(p)
      const idleN = r?.ords.get("idle") ?? 0
      if (r && idleN >= 4 && (!worst || idleN > (worst.r.ords.get("idle") ?? 0))) worst = { t: b[0].t, r }
    }
    if (worst)
      hints.push(
        `t${worst.t} 那一仗开打 30 tick 时，战场 10 格内有 ${worst.r.n} 个兵（共 ${worst.r.near} 个）还一下都没打，当时的命令：${ordText(worst.r.ords)}；其中 ${worst.r.ords.get("idle")} 个停着（idle）。停着的兵只打射程内的敌人，团战时要给附近的兵下 attack 或 attackMove（见「战斗」一节的「没出手」行）`,
      )
    // 开打时自己的兵比对手散得多、这一仗又死得多：挑差距最大的一仗
    if (hasArmy) {
      let loose: { t: number; mine: number; foe: number; far: number; lost: number; killed: number } | null = null
      for (const b of big) {
        if (rout(b)) continue
        const fm = formation(b)
        const f = fm.sides.get(p)
        const foes = [...fm.sides].filter(([q]) => enemies(q, p)).map(([, x]) => x)
        const foeN = foes.reduce((a, x) => a + x.n, 0)
        if (!f || f.n < 5 || foeN < 5) continue
        const foeAvg = foes.reduce((a, x) => a + x.avg * x.n, 0) / foeN
        const lost = b.filter((d) => d.owner === p).length
        const killed = b.filter((d) => enemies(d.owner, p)).length
        if (lost > killed && f.avg >= 2 && f.avg >= foeAvg * 1.5 && (!loose || lost - killed > loose.lost - loose.killed))
          loose = { t: b[0].t, mine: f.avg, foe: foeAvg, far: f.far, lost, killed }
      }
      if (loose)
        hints.push(
          `t${loose.t} 那一仗开打时你的兵比对手散（离自己中心平均 ${loose.mine.toFixed(1)} 格，对手 ${loose.foe.toFixed(1)} 格${loose.far ? `；${loose.far} 个离中心 ${FORM_FAR} 格以上` : ""}），这一仗你死了 ${loose.lost} 个、对手 ${loose.killed} 个。接敌前先聚拢、等走得慢的跟上再一起上（各仗的队形见「战斗」一节的「队形」行）`,
        )
    }
    // 有克制的规则包：能打被自己克的兵的时候，攻击有没有打在它们身上
    if (hasCounters) {
      let chance = 0
      let onCounter = 0
      for (const b of big) {
        const inFight = battleHits(b)
        const present = new Set([...inFight.filter((h) => enemies(h.owner, p)).map((h) => h.from), ...inFight.filter((h) => h.owner === p).map((h) => h.to)])
        for (const h of inFight) {
          if (h.owner !== p) continue
          const vs = Object.entries(types[h.from]?.attack?.vs ?? {}).filter(([, m]) => (m ?? 1) > 1).map(([k]) => k)
          if (!vs.some((k) => present.has(k))) continue
          chance++
          if (h.bonus) onCounter++
        }
      }
      if (chance >= 30 && onCounter / chance < 0.4)
        hints.push(`战场上有被自己克的兵时，只有 ${Math.round((100 * onCounter) / chance)}% 的攻击打在它们身上（${chance} 下里 ${onCounter} 下）。自动攻击只挑最近的、不看克制，要用 cmd.attack 自己挑目标（各仗打谁见「战斗」一节的「伤害」行）`)
    }
    // 工人闲着才算问题（兵在集结点待命是正常的）
    const idleWorkers = after.map((smp) => [...smp.players[p].units].filter(([t]) => isWorker(t)).reduce((a, [, u]) => a + u.idle, 0))
    const avgIdle = idleWorkers.reduce((a, b) => a + b, 0) / Math.max(1, idleWorkers.length)
    if (avgIdle >= 1.5) hints.push(`抽样时平均有 ${avgIdle.toFixed(1)} 个工人闲着（命令是 idle）：没去采集、也没在建造`)
    const longest = idleSpans.filter((sp) => sp.owner === p).sort((a, b) => b.to - b.from - (a.to - a.from))
    for (const sp of longest.slice(0, 3))
      hints.push(
        `${sp.type} #${sp.id} 从 t${sp.from} 闲到 t${sp.to}（${sp.to - sp.from} tick），闲下来时在 (${sp.sx}, ${sp.sy})${sp.sx !== sp.x || sp.sy !== sp.y ? `，${sp.to === last ? "最后" : "当时"}在 (${sp.x}, ${sp.y})` : ""}；${sp.before}${sp.zone !== null ? `（站在规则包标出的区域${sp.zone ? `「${sp.zone}」` : ""}里，可能是故意的）` : ""}`,
      )
    if (longest.length > 3) hints.push(`另有 ${longest.length - 3} 段工人闲了 ${LONG_IDLE} tick 以上`)
    const cheapest = Math.min(...Object.values(types).map((t) => Object.values(t.cost ?? {}).reduce((a: number, c) => a + (c ?? 0), 0)).filter((c) => c > 0))
    const inGame = after.filter((smp) => smp.players[p].alive)
    const avgBank = inGame.reduce((a, smp) => a + sum(smp.players[p].res), 0) / Math.max(1, inGame.length)
    if (Number.isFinite(cheapest) && avgBank >= cheapest * 4) {
      // 兵营差不多满负荷时钱多是出兵的瓶颈，不是不会花（D-194，试写反馈：这条在兵营利用率 83% 时也出，会误导）
      const util = producerTime[p] >= 1000 ? armyBuildTime[p] / producerTime[p] : 0
      hints.push(
        util >= 0.7
          ? `手上钱多：抽样时平均留着 ${Math.round(avgBank)}，但能出兵的建筑大约 ${Math.round(util * 100)}% 的时间在出兵，已经差不多满负荷，多的钱只能花在别处（多造能出兵的建筑、技能这些，看规则包有什么）`
          : `钱囤着没花：抽样时平均手上留着 ${Math.round(avgBank)}（最便宜的东西才 ${cheapest}）`,
      )
    }
    if (firstHitDealt[p] < 0 && firstHitTaken[p] >= 0) hints.push("整局没打到过敌人，只挨了打")
    // 同一个位置的建筑反复被拆
    const razed = new Map<string, { type: string; x: number; y: number; n: number }>()
    for (const d of deaths) {
      if (d.owner !== p || kind(d.type) !== "building") continue
      const k = `${d.type}@${d.x},${d.y}`
      const r = razed.get(k) ?? { type: d.type, x: d.x, y: d.y, n: 0 }
      r.n++
      razed.set(k, r)
    }
    const again = [...razed.values()].filter((r) => r.n >= 2).sort((a, b) => b.n - a.n)
    if (again.length)
      hints.push(`同一个位置的建筑反复被拆：${again.slice(0, 3).map((r) => `${r.type} (${r.x}, ${r.y}) ${r.n} 次`).join("、")}（拆了又在原地建；换个安全点的位置，或者先派兵守住）`)
    if (hasWorkers) {
      // 工人被卷进战斗：一场里死了 3 个以上工人的
      const bad = big
        .map((b) => ({ b, lost: b.filter((d) => d.owner === p), workers: b.filter((d) => d.owner === p && isWorker(d.type)).length }))
        .filter((x) => x.workers >= 3)
      if (bad.length) {
        const where = bad.slice(0, 3).map(({ b, lost, workers }) => {
          const cx = Math.round(b.reduce((a, x) => a + x.x, 0) / b.length)
          const cy = Math.round(b.reduce((a, x) => a + x.y, 0) / b.length)
          // 死的时候在干什么：撤退路上被追着打、还在采矿、还是上去打了
          const doing = new Map<string, number>()
          for (const d of lost) {
            if (!isWorker(d.type)) continue
            const k = d.ord.startsWith("gather") && d.ord.endsWith("回程") ? "gather 回程" : d.ord.split(" ")[0]
            doing.set(k, (doing.get(k) ?? 0) + 1)
          }
          const how = [...doing].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join("、")
          return `t${b[0].t} 在 (${cx}, ${cy}) 附近死了 ${workers} 个工人（这一仗一共损失 ${lost.length} 个单位，含这些工人；整局的损失见「经济和损失」；工人死的时候的命令：${how}）`
        })
        // 工人走得不比兵快时躲不掉（被追上就跑不掉），建议换成留兵、建塔、早换矿
        const ticksOf = (worker: boolean) =>
          Math.min(...Object.entries(types).filter(([k, t]) => t.kind === "unit" && t.attack && (t.moveTicks ?? 0) > 0 && (worker ? isWorker(k) : isArmy(k))).map(([, t]) => t.moveTicks!))
        const wt = ticksOf(true)
        const ft = ticksOf(false)
        // 不比工人慢的兵按走一格几 tick 列出来（兵种走得不一样快时，比如骑兵 2 tick、枪兵 3 tick，不能笼统说"兵"）
        const catching = new Map<number, string[]>()
        for (const [k, t] of Object.entries(types))
          if (t.kind === "unit" && t.attack && (t.moveTicks ?? 0) > 0 && isArmy(k) && t.moveTicks! <= wt) catching.set(t.moveTicks!, [...(catching.get(t.moveTicks!) ?? []), k])
        const catchText = [...catching].sort((a, b) => a[0] - b[0]).map(([n, ks]) => `${ks.join("、")} ${n} tick`).join("，")
        // 能建会攻击的建筑（箭塔这类）才建议建塔
        const tower = Object.values(types).some((t) => (t.builds ?? []).some((b) => types[b]?.attack))
        const advice =
          Number.isFinite(wt) && Number.isFinite(ft) && wt >= ft
            ? `工人走得不比这些兵快（工人走一格 ${wt} tick；${catchText}），被追上就跑不掉：在采集的地方留兵${tower ? "或建塔" : ""}、提前出兵，看到打不过的敌兵靠近就早点换到安全的矿`
            : "敌人打过来时可以让工人躲开，或者在采集的地方留兵"
        hints.push(`工人被卷进战斗：${where.join("；")}${bad.length > 3 ? `，另有 ${bad.length - 3} 场` : ""}。${advice}`)
      }
    }
    // 工人被中立单位（野怪这类）打死（D-191，试写反馈：只写"工人被卷进战斗"，看不出是野怪打的）
    const workersByNeutral = deaths.filter((d) => d.owner === p && d.by === -2 && isWorker(d.type))
    if (workersByNeutral.length >= 3) {
      const where = neutralGroups
        .map((g) => ({ g, k: [...(g.slain.get(p) ?? [])].filter(([t]) => isWorker(t)).reduce((a, [, c]) => a + c, 0) }))
        .filter((x) => x.k > 0)
        .sort((a, b) => b.k - a.k)
        .map((x) => `(${x.g.x}, ${x.g.y}) 一带 ${x.k} 个`)
      hints.push(
        `工人被中立单位打死 ${workersByNeutral.length} 个${where.length ? `（${where.slice(0, 3).join("、")}）` : ""}：多半是采矿、交货的路线贴着营地走，或者营地打起来时在它附近采矿。工人的路线绕开营地，别人在旁边清野时把工人挪开（见「中立单位」一节）`,
      )
    }
    // 技能冷却好了很久没放（D-191，试写反馈：领主被挡在路上，点金每次晚一百多 tick，被拒命令、报错里都看不出来）
    {
      const late: { name: string; type: string; n: number; total: number; worst: { from: number; to: number } | null }[] = []
      for (const so of skillOwners.values()) {
        if (so.owner !== p) continue
        for (const sk of types[so.type]?.skills ?? []) {
          // 要花钱的技能（D-192）：没钱放不了、攒着钱不放都可能是故意的，不算晚放
          if (Object.values(sk.cost ?? {}).some((c) => (c ?? 0) > 0)) continue
          // 看时机放的技能（击退这类，D-197）：等敌人来了才放是正常的
          if (sk.situational) continue
          const end = so.died ?? last
          let ready = so.born + (sk.initialCooldown ?? 0)
          let row: (typeof late)[number] | null = null
          const note = (from: number, to: number) => {
            if (to - from < SKILL_LATE) return
            row ??= { name: sk.name, type: so.type, n: 0, total: 0, worst: null }
            row.n++
            row.total += to - from
            if (!row.worst || to - from > row.worst.to - row.worst.from) row.worst = { from, to }
          }
          for (const c of so.casts) {
            if (c.s !== sk.id) continue
            note(ready, c.t)
            ready = c.t + sk.cooldown
          }
          if (ready < end) note(ready, end)
          if (row) late.push(row)
        }
      }
      for (const r of late.sort((a, b) => b.total - a.total).slice(0, 2))
        hints.push(
          `${r.type} 的技能「${r.name}」冷却好了没马上放：${r.n} 次等了 ${SKILL_LATE} tick 以上，一共 ${r.total} tick（最长一次 t${r.worst!.from}～t${r.worst!.to}）。不是故意留着的话，看看是不是想放的位置走不到（在采矿、建造的自己人不让路）、或者放的条件写得太严`,
        )
    }
    if (hasArmy) {
      if (firstArmy[p] < 0 && firstHitTaken[p] >= 0) hints.push(`整局没有兵（只有工人），第 ${firstHitTaken[p]} tick 起挨打`)
      // 只算家里挨打（自己建筑 10 格内）：派出去侦察的单位在对方家门口挨打不算
      else if (firstArmy[p] > 0 && firstHomeHit[p] >= 0 && firstArmy[p] > firstHomeHit[p]) hints.push(`第 ${firstHomeHit[p]} tick 家里（自己建筑 10 格内）就被敌方的兵打了，第一个兵到 t${firstArmy[p]} 才有`)
      // 第一场战斗开打时的兵力
      const first = big.find((b) => b.some((d) => d.owner === p))
      if (first) {
        const army = armyBefore(first)
        const foes = [...new Set(first.map((d) => d.owner))].filter((q) => enemies(p, q))
        const most = Math.max(0, ...foes.map((q) => army[q]))
        if (foes.length && army[p] < most) {
          const cx = Math.round(first.reduce((a, x) => a + x.x, 0) / first.length)
          const cy = Math.round(first.reduce((a, x) => a + x.y, 0) / first.length)
          hints.push(`第一场战斗（t${first[0].t}，(${cx}, ${cy}) 附近）开打时兵数（不算工人）：${who0(p)} ${army[p]}，${foes.map((q) => `${who0(q)} ${army[q]}`).join("、")}`)
        }
      }
    }
    if (!won.includes(p) && won.length > 0) {
      const best = Math.max(...won.map((w) => incomeOf[w]))
      if (best > 0 && incomeOf[p] < best * 0.6)
        hints.push(`经济差得多：采集约 ${Math.round(incomeOf[p])}，赢家约 ${Math.round(best)}（看看工人数、采集分配，是不是太早把钱全花在兵上）`)
      // 输了：最后一次两边都还在场时的单位数对比
      const lastBoth = [...after].reverse().find((smp) => smp.players[p].alive && won.some((w) => smp.players[w].alive))
      if (lastBoth) {
        const cnt = (q: number) => [...lastBoth.players[q].units.values()].reduce((a, u) => a + u.n, 0)
        hints.push(`第 ${lastBoth.t} tick 时单位数：${who0(p)} ${cnt(p)}，赢家 ${won.map((w) => `P${w} ${cnt(w)}`).join("、")}`)
      }
    }
    for (const h of hints) out.push(`- ${me === undefined ? `P${p}：` : ""}${h}`)
    if (hints.length) any = true
  }
  if (!any) out.push("没看出明显的问题")
  return out.join("\n") + "\n"
}

/**
 * 某一 tick 的局面（D-167，试写反馈：只能跑命令的大模型看不了网页回放，要靠自己写脚本重建局面）：
 * 字符地图（每种实体一个字母，P0 大写、其他玩家小写）、各方资源和分数、每个实体的位置、生命和命令。
 * 是全知视角（双方都看得到），对局中 bot 看不到这些
 */
export function snapshotText(replay: Replay, t: number): string {
  const model = new ReplayModel(replay)
  const tick = Math.max(0, Math.min(model.lastTick, Math.round(t)))
  const s = model.stateAt(tick)
  const { width: W, height: H, terrain } = replay.map
  const types = replay.types
  // 每种类型一个字母：先用类型名的首字母，撞了就往后找没用过的
  const letter = new Map<string, string>()
  const used = new Set<string>()
  for (const k of Object.keys(types)) {
    const cands = [...k.toUpperCase().replace(/[^A-Z]/g, ""), ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"]
    const c = cands.find((x) => !used.has(x)) ?? "?"
    used.add(c)
    letter.set(k, c)
  }
  const grid = terrain.map((row) => [...row])
  for (const e of s.ents.values()) {
    const ty = types[e.type]
    const c = ty?.kind === "resource" ? "$" : e.owner === 0 ? letter.get(e.type)! : e.owner > 0 ? letter.get(e.type)!.toLowerCase() : "?"
    for (let y = e.y; y < e.y + (ty?.h ?? 1); y++) for (let x = e.x; x < e.x + (ty?.w ?? 1); x++) if (grid[y]?.[x] !== undefined) grid[y][x] = c
  }
  const out: string[] = []
  out.push(`# 第 ${tick} tick 的局面（${replay.ruleset.name}，种子 ${replay.seed}；全知视角，双方的东西都列出来了）`)
  out.push("")
  out.push(s.players.map((p, i) => `P${i}（${replay.players[i]?.name}）${p.alive ? "" : "已出局，"}${Object.entries(p.resources).map(([k, v]) => `${k} ${Math.round(v)}`).join(" ")}，分 ${Math.round(p.score)}`).join("；"))
  if (s.status) out.push(`状态：${s.status}`)
  out.push("")
  const walk = replay.map.walkable
  const terrainText = Object.keys(replay.map.colors)
    .map((ch) => `「${ch}」${walk ? (walk[ch] ? "能走" : "不能走") : "地形"}`)
    .join("、")
  out.push(`## 地图（${W}×${H}；${terrainText}；「$」资源点；实体按下面的字母，P0 大写、其他玩家小写，「?」中立）`)
  out.push("字母：" + [...letter].filter(([k]) => types[k]?.kind !== "resource").map(([k, c]) => `${c} ${k}`).join("、"))
  const tens = Array.from({ length: W }, (_, x) => (x % 10 === 0 ? String(Math.floor(x / 10) % 10) : " ")).join("")
  const ones = Array.from({ length: W }, (_, x) => String(x % 10)).join("")
  out.push("```")
  out.push(`    ${tens}`)
  out.push(`    ${ones}`)
  grid.forEach((row, y) => out.push(`${String(y).padStart(3)} ${row.join("")}`))
  out.push("```")
  out.push("")
  out.push("## 实体（编号 类型 (x, y) 生命 命令，有增益的列出增益名；资源点的生命是剩余量）")
  const owners = [...new Set([...s.ents.values()].map((e) => e.owner))].sort((a, b) => a - b)
  for (const o of owners) {
    const list = [...s.ents.values()].filter((e) => e.owner === o).sort((a, b) => a.type.localeCompare(b.type) || a.id - b.id)
    out.push(`${o < 0 ? "中立" : `P${o}`}（${list.length} 个）：`)
    for (const e of list.slice(0, 120)) {
      const ty = types[e.type]
      const hp = ty?.kind === "resource" ? `剩 ${e.hp}` : `${e.hp}/${e.st?.maxHp ?? ty?.maxHp ?? "?"}`
      out.push(`  #${e.id} ${e.type} (${e.x}, ${e.y}) ${hp}${e.bp !== undefined ? ` 建到 ${e.bp}%` : ""} ${e.ord}${e.bf?.length ? ` 增益：${e.bf.join("、")}` : ""}`)
    }
    if (list.length > 120) out.push(`  ……另有 ${list.length - 120} 个`)
  }
  return out.join("\n") + "\n"
}
