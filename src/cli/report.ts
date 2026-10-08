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

export function buildReport(replay: Replay, opts: ReportOptions = {}): string {
  const types = replay.types
  const n = replay.players.length
  const team = (p: number) => replay.players[p]?.team ?? p
  const enemies = (a: number, b: number) => a >= 0 && b >= 0 && team(a) !== team(b)
  const me = opts.player
  const who0 = (p: number) => (me === undefined ? `P${p}` : p === me ? "你" : team(p) === team(me) ? `盟友 P${p}` : `对手 P${p}`)
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

  // 家里挨打：被兵打在自己建筑 10 格内的（派出去侦察的单位在对方家门口挨打、对方侦察兵路过戳一下都不算）
  const firstHomeHit = new Array<number>(n).fill(-1)
  const nearHome = (e: EntSnap) => {
    for (const b of s.ents.values()) if (b.owner === e.owner && kind(b.type) === "building" && snapDist(b, e) <= 10) return true
    return false
  }
  // 有兵种克制的规则包（attack.vs）：记下每一下打了多少、是不是打在被自己克的兵上，战斗一节按兵种列（D-167，试写反馈）
  const hasCounters = Object.values(types).some((t) => t.attack?.vs && Object.keys(t.attack.vs).length > 0)
  const hits: { t: number; x: number; y: number; owner: number; from: string; to: string; dmg: number; bonus: boolean }[] = []
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
      if (!enemies(a.owner, tg.owner)) continue
      if (firstContact < 0) {
        firstContact = f.t
        events.push({ t: f.t, p: -1, text: `第一次交火：P${a.owner} 的 ${a.type} 打 P${tg.owner} 的 ${tg.type}，在 ${at(tg)}`, cat: "key" })
      }
      if (firstHitTaken[tg.owner] < 0) firstHitTaken[tg.owner] = f.t
      if (firstHomeHit[tg.owner] < 0 && isArmy(a.type) && nearHome(tg)) firstHomeHit[tg.owner] = f.t
      const atk = hasCounters ? types[a.type]?.attack : undefined
      if (atk) {
        const m = atk.vs?.[tg.type]
        const dmg = a.st?.attack?.damage ?? atk.damage
        hits.push({ t: f.t, x: tg.x, y: tg.y, owner: a.owner, from: a.type, to: tg.type, dmg: m === undefined ? dmg : Math.round(dmg * m), bonus: (m ?? 1) > 1 })
      }
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
      const byText = by >= 0 ? `，最后一击是 P${by}` : by === -2 ? "，被中立实体打死" : ""
      if (e.owner < 0) events.push({ t: f.t, p: -1, text: `中立的 ${e.type} 死了 ${at(e)}${byText}` })
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
    for (const e of f.spawn ?? []) {
      if (initialIds.has(e.id) || e.owner < 0 || e.owner >= n) continue
      // 玩家放的地基一出来就有建造进度；直接是建好的建筑，是规则包放的
      if (kind(e.type) === "building" && e.bp === undefined) {
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
    for (let p = 0; p < n; p++) {
      const ps = smp.players[p]
      const prev = i > 0 ? samples[i - 1].players[p] : null
      const income = prev ? sum(ps.res) - sum(prev.res) + ps.spentSoFar - prev.spentSoFar : 0
      const units = [...ps.units].map(([k, u]) => `${k}×${u.n}${u.idle ? `（闲 ${u.idle}）` : ""}`).join(" ") || "无"
      const blds = [...ps.buildings].map(([k, b]) => `${k}×${b.n}${b.building ? `（${b.building}）` : ""}`).join(" ") || "无"
      const head = p === 0 ? `t${smp.t}`.padEnd(7) : "".padEnd(7)
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
        return `${who0(p)} 打出 ${total}（打在被自己克的兵上 ${total ? Math.round((100 * bonus) / total) : 0}%）：${top.join("、")}${pairs.size > 4 ? "……" : ""}`
      })
      if (parts.length) out.push(`  伤害：${parts.join("；")}`)
    }
  }
  out.push("")

  out.push("## 经济和损失")
  const after = samples.slice(1)
  const incomeOf: number[] = []
  for (let p = 0; p < n; p++) incomeOf[p] = sum(samples[samples.length - 1].players[p].res) - sum(initialRes[p]) + spentTotal[p]
  for (let p = 0; p < n; p++) {
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
  }
  out.push("")
  if (mining.size) {
    out.push(
      "## 采矿（每个矿：交了几次货；采一次来回平均几 tick，交货点离矿越近越短；最多同时派了几个工人 / 矿旁边站得下几个；排队是工人站在矿附近等空位的总时间，站满了不会自己换矿）",
    )
    for (let p = 0; p < n; p++) {
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
    if (Number.isFinite(cheapest) && avgBank >= cheapest * 4) hints.push(`钱囤着没花：抽样时平均手上留着 ${Math.round(avgBank)}（最便宜的东西才 ${cheapest}）`)
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
