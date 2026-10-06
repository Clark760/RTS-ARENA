// 文字战报：给看不了网页回放的人和大模型 agent。从回放还原整局，按时间抽样双方的经济、兵力、建筑，
// 列出关键事件、战斗、损失，估算采集量，最后给几条只基于事实的"可能的问题"。
import { applyFrame, ReplayModel, type State } from "../core/replay-model.ts"
import type { EntSnap, Replay } from "../core/types.ts"

export interface ReportOptions {
  /** 从这个玩家的角度写（"你"、"对手"），只给他的提示；不给就写全部玩家 */
  player?: number
  /** 每隔多少 tick 抽样一次；不给按整局长度挑（大约 10 行） */
  every?: number
}

interface PlayerSample {
  res: Record<string, number>
  score: number
  alive: boolean
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

function countList(m: Map<string, number>): string {
  return [...m].map(([k, n]) => `${k}×${n}`).join("、") || "无"
}

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
  const model = new ReplayModel(replay)
  const last = model.lastTick
  const every = opts.every && opts.every > 0 ? opts.every : pickEvery(last)

  // ---------- 一遍扫完整局 ----------
  const s: State = model.initialState()
  const initialIds = new Set(s.ents.keys())
  const samples: { t: number; players: PlayerSample[] }[] = []
  const takeSample = (t: number) => {
    const players: PlayerSample[] = s.players.map((ps) => ({ res: { ...ps.resources }, score: ps.score, alive: ps.alive, units: new Map(), buildings: new Map() }))
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
  const spent = Array.from({ length: n }, () => new Map<string, number>())
  const events: { t: number; p: number; text: string }[] = []
  const firstMade = Array.from({ length: n }, () => new Set<string>())
  const firstHitTaken = new Array<number>(n).fill(-1)
  const firstHitDealt = new Array<number>(n).fill(-1)
  const firstBuildingHit = new Array<number>(n).fill(-1)
  const hitEnemyBuilding = new Array<boolean>(n).fill(false)
  let firstContact = -1
  const at = (e: EntSnap) => `(${e.x}, ${e.y})`

  for (const f of replay.frames) {
    // 交火、挨打：用这一帧之前的局面查归属（这一帧死的也还在）
    const sh = f.shots ?? []
    for (let i = 0; i < sh.length; i += 2) {
      const a = s.ents.get(sh[i])
      const tg = s.ents.get(sh[i + 1])
      if (!a || !tg || !enemies(a.owner, tg.owner)) continue
      if (firstContact < 0) {
        firstContact = f.t
        events.push({ t: f.t, p: -1, text: `第一次交火：P${a.owner} 的 ${a.type} 打 P${tg.owner} 的 ${tg.type}，在 ${at(tg)}` })
      }
      if (firstHitTaken[tg.owner] < 0) firstHitTaken[tg.owner] = f.t
      if (firstHitDealt[a.owner] < 0) firstHitDealt[a.owner] = f.t
      if (kind(tg.type) === "building") {
        hitEnemyBuilding[a.owner] = true
        if (firstBuildingHit[tg.owner] < 0) {
          firstBuildingHit[tg.owner] = f.t
          events.push({ t: f.t, p: tg.owner, text: `${who(tg.owner)}的建筑第一次挨打：${tg.type} ${at(tg)}，打它的是 P${a.owner} 的 ${a.type}` })
        }
      }
    }
    for (const id of f.die ?? []) {
      const e = s.ents.get(id)
      if (!e || e.owner < 0 || kind(e.type) === "resource") continue
      deaths.push({ t: f.t, owner: e.owner, type: e.type, x: e.x, y: e.y })
      if (kind(e.type) === "building") events.push({ t: f.t, p: e.owner, text: `${who(e.owner)}失去 ${e.type}${e.bp !== undefined ? "（还没建好）" : ""} ${at(e)}` })
    }
    applyFrame(s, f)
    for (const e of f.spawn ?? []) {
      if (initialIds.has(e.id) || e.owner < 0 || e.owner >= n) continue
      const cost = types[e.type]?.cost ?? {}
      for (const [r, c] of Object.entries(cost)) spent[e.owner].set(r, (spent[e.owner].get(r) ?? 0) + (c ?? 0))
      if (kind(e.type) === "building") events.push({ t: f.t, p: e.owner, text: `${who(e.owner)}放下 ${e.type} 的地基 ${at(e)}` })
      else if (kind(e.type) === "unit" && !firstMade[e.owner].has(e.type)) {
        firstMade[e.owner].add(e.type)
        events.push({ t: f.t, p: e.owner, text: `${who(e.owner)}第一次造出 ${e.type}` })
      }
    }
    const bp = f.bp ?? []
    for (let i = 0; i < bp.length; i += 2) {
      if (bp[i + 1] < 100) continue
      const e = s.ents.get(bp[i])
      if (e && e.owner >= 0) events.push({ t: f.t, p: e.owner, text: `${who(e.owner)}的 ${e.type} 建好了` })
    }
    if (f.t % every === 0 || f.t === last) takeSample(f.t)
  }
  if (samples[samples.length - 1].t !== last) takeSample(last)

  // ---------- 输出 ----------
  const r = replay.result
  const out: string[] = []
  const won = r.winners ?? []
  const outcome = won.length === 0 ? "平局" : `${won.map((p) => `P${p}（${replay.players[p].name}）`).join("、")}获胜`
  out.push(`# 战报：${replay.ruleset.name}（${replay.ruleset.id}），种子 ${replay.seed}`)
  out.push(`第 ${r.tick} tick 结束：${outcome}——${r.reason}`)
  out.push(`参赛：${replay.players.map((p, i) => `P${i} ${p.name}${n > 2 && new Set(replay.players.map((x) => x.team)).size < n ? `（队${team(i) + 1}）` : ""}`).join("，")}${me !== undefined ? `；你是 P${me}` : ""}`)
  out.push("")

  out.push(`## 局势（每 ${every} tick；单位后面括号里是闲着的个数，建筑括号里是没建好的个数）`)
  for (const smp of samples) {
    for (let p = 0; p < n; p++) {
      const ps = smp.players[p]
      const units = [...ps.units].map(([k, u]) => `${k}×${u.n}${u.idle ? `（闲 ${u.idle}）` : ""}`).join(" ") || "无"
      const blds = [...ps.buildings].map(([k, b]) => `${k}×${b.n}${b.building ? `（${b.building}）` : ""}`).join(" ") || "无"
      const head = p === 0 ? `t${smp.t}`.padEnd(7) : "".padEnd(7)
      out.push(`${head} ${who0(p)}${ps.alive ? "" : "（已出局）"}：${fmtRes(ps.res)}，分 ${Math.round(ps.score)} | 单位 ${units} | 建筑 ${blds}`)
    }
  }
  out.push("")

  out.push("## 关键事件")
  const shown = events.filter((e) => me === undefined || e.p === -1 || e.p === me || enemies(e.p, me) || team(e.p) === team(me))
  const cap = 40
  for (const e of shown.slice(0, cap)) out.push(`t${e.t}  ${e.text}`)
  if (shown.length > cap) out.push(`（另有 ${shown.length - cap} 条，略）`)
  if (firstContact < 0) out.push("整局双方没有交过火")
  out.push("")

  // 战斗：时间上挨着（60 tick 内）、地点挨着（15 格内）的死亡算一场，3 个以上才列
  const battles: Death[][] = []
  for (const d of deaths) {
    const b = battles[battles.length - 1]
    const near = (g: Death[]) => {
      const cx = g.reduce((a, x) => a + x.x, 0) / g.length
      const cy = g.reduce((a, x) => a + x.y, 0) / g.length
      return Math.abs(d.x - cx) + Math.abs(d.y - cy) <= 15
    }
    if (b && d.t - b[b.length - 1].t <= 60 && near(b)) b.push(d)
    else battles.push([d])
  }
  const big = battles.filter((b) => b.length >= 3)
  out.push(`## 战斗（死 3 个以上的）`)
  if (big.length === 0) out.push("没有")
  for (const b of big.slice(0, 15)) {
    const cx = Math.round(b.reduce((a, x) => a + x.x, 0) / b.length)
    const cy = Math.round(b.reduce((a, x) => a + x.y, 0) / b.length)
    const loss = [...new Set(b.map((d) => d.owner))]
      .sort()
      .map((p) => {
        const m = new Map<string, number>()
        for (const d of b) if (d.owner === p) m.set(d.type, (m.get(d.type) ?? 0) + 1)
        return `${who(p)}损失 ${countList(m)}`
      })
    out.push(`t${b[0].t}～${b[b.length - 1].t} 在 (${cx}, ${cy}) 附近：${loss.join("；")}`)
  }
  if (big.length > 15) out.push(`（另有 ${big.length - 15} 场，略）`)
  out.push("")

  out.push("## 经济和损失")
  const after = samples.slice(1)
  const incomeOf: number[] = []
  for (let p = 0; p < n; p++) {
    const fin = samples[samples.length - 1].players[p].res
    incomeOf[p] = Object.keys(fin).reduce((a, k) => a + fin[k] - (initialRes[p][k] ?? 0) + (spent[p].get(k) ?? 0), 0)
  }
  for (let p = 0; p < n; p++) {
    if (me !== undefined && p !== me && !enemies(p, me) && team(p) !== team(me)) continue
    const lost = new Map<string, number>()
    for (const d of deaths) if (d.owner === p) lost.set(d.type, (lost.get(d.type) ?? 0) + 1)
    const fin = samples[samples.length - 1].players[p].res
    const income = Object.keys(fin)
      .map((k) => `${k} ${Math.round(fin[k] - (initialRes[p][k] ?? 0) + (spent[p].get(k) ?? 0))}`)
      .join(" ")
    const spentText = [...spent[p]].map(([k, v]) => `${k} ${v}`).join(" ") || "0"
    const bank = Object.keys(fin)
      .map((k) => `${k} ${Math.round(after.reduce((a, smp) => a + (smp.players[p].res[k] ?? 0), 0) / Math.max(1, after.length))}`)
      .join(" ")
    out.push(`${who0(p)}：采集约 ${income}（估算：结束时剩的 − 开局的 + 造东西花掉的），花掉 ${spentText}，抽样时平均手上留着 ${bank}；损失 ${countList(lost)}`)
  }
  out.push("")

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
    const idle = after.map((smp) => [...smp.players[p].units.values()].reduce((a, u) => a + u.idle, 0))
    const avgIdle = idle.reduce((a, b) => a + b, 0) / Math.max(1, idle.length)
    if (avgIdle >= 2) hints.push(`抽样时平均有 ${avgIdle.toFixed(1)} 个单位闲着（命令是 idle）：看看是不是有工人没去采集、兵造出来没人管`)
    const cheapest = Math.min(...Object.values(types).map((t) => Object.values(t.cost ?? {}).reduce((a: number, c) => a + (c ?? 0), 0)).filter((c) => c > 0))
    const avgBank = after.reduce((a, smp) => a + Object.values(smp.players[p].res).reduce((x, y) => x + y, 0), 0) / Math.max(1, after.length)
    if (Number.isFinite(cheapest) && avgBank >= cheapest * 4) hints.push(`钱囤着没花：抽样时平均手上留着 ${Math.round(avgBank)}（最便宜的东西才 ${cheapest}）`)
    if (firstContact >= 0 && !hitEnemyBuilding[p] && !won.includes(p)) hints.push("整局没打到过对方的建筑")
    if (firstHitDealt[p] < 0 && firstHitTaken[p] >= 0) hints.push("整局没打到过敌人，只挨了打")
    if (!won.includes(p) && won.length > 0) {
      const best = Math.max(...won.map((w) => incomeOf[w]))
      if (best > 0 && incomeOf[p] < best * 0.6)
        hints.push(`经济差得多：采集约 ${Math.round(incomeOf[p])}，赢家约 ${Math.round(best)}（看看工人数、采集分配，是不是太早把钱全花在兵上）`)
      // 输了：最后一次两边都还在场时的单位数对比
      const lastBoth = [...after].reverse().find((smp) => smp.players[p].alive && won.some((w) => smp.players[w].alive))
      if (lastBoth) {
        const cnt = (q: number) => [...lastBoth.players[q].units.values()].reduce((a, u) => a + u.n, 0)
        hints.push(`第 ${lastBoth.t} tick 时单位数：${who(p)} ${cnt(p)}，赢家 ${won.map((w) => `P${w} ${cnt(w)}`).join("、")}`)
      }
    }
    for (const h of hints) out.push(`- ${me === undefined ? `P${p}：` : ""}${h}`)
    if (hints.length) any = true
  }
  if (!any) out.push("没看出明显的问题")
  return out.join("\n") + "\n"
}
