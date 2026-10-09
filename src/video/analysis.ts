// 联赛视频的数据分析（D-177）：选手页的能力雷达图、精彩对局的实时胜率预测。
// 都从这次联赛的全部回放算：读一遍每局回放，记下每个选手的各项数据，再按局面拟合一个胜率模型。
// 算一次要读完所有回放，结果缓存在联赛汇总旁边的 *.analysis.json（联赛局数变了、算法版本变了就重算）
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { applyFrame, ReplayModel, type State } from "../core/replay-model.ts"
import type { Replay } from "../core/types.ts"
import { codeFacts, resolveBotFile, type SeriesFile } from "./brief.ts"

/** 算法改了就加 1，旧缓存作废 */
const VERSION = 1
/** 胜率模型每隔多少 tick 取一次局面 */
const SAMPLE = 50

/** 雷达图的一条轴：score 是 0～1（这项在所有选手里和最好的比），text 是轴下面的小字 */
export interface RadarAxis {
  label: string
  text: string
  score: number
}

export interface LeagueAnalysis {
  version: number
  games: number
  /** 胜率模型的权重，特征见 winFeatures */
  weights: number[]
  /** 每个选手（联赛里的名字）的雷达图 */
  radar: Record<string, RadarAxis[]>
}

const costOf = (replay: Replay, type: string) => Object.values(replay.types[type]?.cost ?? {}).reduce((a: number, c) => a + (c ?? 0), 0)

/**
 * 主基地是哪种建筑：开局每个玩家都有、生命最多的那种建筑（各规则包的主基地名字不一样，按这个认）。
 * 没有每家都有的建筑时返回 null
 */
export function baseTypeOf(replay: Replay): string | null {
  const n = replay.players.length
  const owners = new Map<string, Set<number>>()
  for (const e of replay.initial.entities) {
    if (e.owner < 0 || replay.types[e.type]?.kind !== "building") continue
    owners.set(e.type, (owners.get(e.type) ?? new Set()).add(e.owner))
  }
  const all = [...owners].filter(([, s]) => s.size === n).map(([k]) => k)
  if (!all.length) return null
  return all.sort((a, b) => (replay.types[b].maxHp ?? 0) - (replay.types[a].maxHp ?? 0))[0]
}

/** 两方的队伍编号（按编号排）；不是两方对打返回 null */
export function twoSides(replay: Replay): [number, number] | null {
  const sides = [...new Set(replay.players.map((p, i) => p.team ?? i))].sort((a, b) => a - b)
  return sides.length === 2 ? [sides[0], sides[1]] : null
}

/**
 * 局面特征（A 方减 B 方，归一到 -1～1）：兵力价值（造价 × 剩余生命比例，不算工人和白送的单位）、工人数、建筑剩余生命、分数，
 * 后 4 个是同样的差乘上进度（第几 tick / 时间上限）：越到后期，同样的差距越说明问题
 */
export function winFeatures(replay: Replay, state: State, a: number, b: number): number[] {
  const side = (p: number) => replay.players[p]?.team ?? p
  const tot = [
    { army: 0, workers: 0, bld: 0, score: 0 },
    { army: 0, workers: 0, bld: 0, score: 0 },
  ]
  for (const e of state.ents.values()) {
    if (e.owner < 0) continue
    const s = side(e.owner) === a ? 0 : side(e.owner) === b ? 1 : -1
    if (s < 0) continue
    const ty = replay.types[e.type]
    if (!ty) continue
    if (ty.kind === "building") tot[s].bld += Math.max(0, e.hp)
    else if (ty.kind === "unit") {
      if (ty.worker) tot[s].workers++
      else {
        const max = e.st?.maxHp ?? ty.maxHp ?? 1
        tot[s].army += (costOf(replay, e.type) * Math.max(0, e.hp)) / Math.max(1, max)
      }
    }
  }
  state.players.forEach((pl, p) => {
    const s = side(p) === a ? 0 : side(p) === b ? 1 : -1
    if (s >= 0) tot[s].score += pl.score
  })
  const d = (x: number, y: number, k: number) => (x - y) / (x + y + k)
  const base = [d(tot[0].army, tot[1].army, 150), d(tot[0].workers, tot[1].workers, 3), d(tot[0].bld, tot[1].bld, 600), d(tot[0].score, tot[1].score, 300)]
  const prog = Math.min(1, state.tick / Math.max(1, replay.maxTicks))
  return [...base, ...base.map((x) => x * prog)]
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z))
const dot = (w: number[], x: number[]) => w.reduce((s, wi, i) => s + wi * x[i], 0)

/** A 方赢的概率 */
export function winProb(weights: number[], x: number[]): number {
  return sigmoid(dot(weights, x))
}

/**
 * 逻辑回归（不带常数项：两边对称，局面一样时就是 50%）。每个样本同时放进它的镜像（特征取反、结果对调），
 * 平局按 0.5 算
 */
export function fitWinModel(samples: { x: number[]; y: number }[], iters = 800): number[] {
  const n = samples.length
  const k = samples[0]?.x.length ?? 8
  const w = new Array<number>(k).fill(0)
  if (!n) return w
  const all = samples.flatMap((s) => [s, { x: s.x.map((v) => -v), y: 1 - s.y }])
  const lr = 1.5
  const l2 = 1e-3
  for (let it = 0; it < iters; it++) {
    const grad = new Array<number>(k).fill(0)
    for (const s of all) {
      const e = sigmoid(dot(w, s.x)) - s.y
      for (let i = 0; i < k; i++) grad[i] += e * s.x[i]
    }
    for (let i = 0; i < k; i++) w[i] -= lr * (grad[i] / all.length + l2 * w[i])
  }
  return w.map((x) => Number(x.toFixed(4)))
}

/** 一局回放每隔 step tick 的 A 方（twoSides 的第一个）胜率；不是两方对打返回 null */
export function winCurve(replay: Replay, weights: number[], step = 20): number[] | null {
  const sides = twoSides(replay)
  if (!sides) return null
  const s = new ReplayModel(replay).initialState()
  const T = replay.result.tick
  const out: number[] = [winProb(weights, winFeatures(replay, s, sides[0], sides[1]))]
  for (const f of replay.frames) {
    applyFrame(s, f)
    if (f.t % step === 0 || f.t === T) out.push(Number(winProb(weights, winFeatures(replay, s, sides[0], sides[1])).toFixed(3)))
    if (f.t >= T) break
  }
  return out
}

/** 读一局回放：胜率模型的样本，加上每个座位的伤害（总共、打在被自己克的兵上的） */
function scanReplay(replay: Replay): { samples: { x: number[]; y: number }[]; dmg: number[]; bonus: number[] } {
  const n = replay.players.length
  const dmg = new Array<number>(n).fill(0)
  const bonus = new Array<number>(n).fill(0)
  const samples: { x: number[]; y: number }[] = []
  const sides = twoSides(replay)
  const side = (p: number) => replay.players[p]?.team ?? p
  const won = new Set((replay.result.winners ?? []).map(side))
  const y = sides ? (won.size === 1 ? (won.has(sides[0]) ? 1 : 0) : 0.5) : 0.5
  const s = new ReplayModel(replay).initialState()
  for (const f of replay.frames) {
    // 伤害：这一帧之前的局面里查攻击方和目标（这一帧死的也还在）
    const sh = f.shots ?? []
    for (let i = 0; i < sh.length; i += 2) {
      const at = s.ents.get(sh[i])
      const tg = s.ents.get(sh[i + 1])
      if (!at || !tg || at.owner < 0 || tg.owner < 0 || side(at.owner) === side(tg.owner)) continue
      const atk = replay.types[at.type]?.attack
      if (!atk || replay.types[at.type]?.kind !== "unit") continue
      const m = atk.vs?.[tg.type] ?? 1
      const d = (at.st?.attack?.damage ?? atk.damage) * m
      dmg[at.owner] += d
      if (m > 1) bonus[at.owner] += d
    }
    applyFrame(s, f)
    if (sides && f.t % SAMPLE === 0) samples.push({ x: winFeatures(replay, s, sides[0], sides[1]), y })
  }
  return { samples, dmg, bonus }
}

/** 选手页的能力雷达图：6 项，每项和所有选手里最好的比 */
function radarOf(series: SeriesFile, seriesFile: string, dmg: number[], bonus: number[], hasCounters: boolean): Record<string, RadarAxis[]> {
  const bots = series.summary?.stats?.bots ?? []
  const names = series.participants.map((p) => p.name)
  const raw = names.map((name, i) => {
    const b = bots.find((x) => x.name === name)
    const games = Math.max(1, b?.games ?? 0)
    const file = resolveBotFile(series.participants[i].file, seriesFile)
    const code = file ? codeFacts(readFileSync(file, "utf8")).codeLines : 0
    return {
      income: (b?.income ?? 0) / games,
      produced: (b?.produced ?? 0) / games,
      trade: (b?.killedUnits ?? 0) / Math.max(1, b?.lostUnits ?? 0),
      raze: (b?.killedBuildings ?? 0) / games,
      counter: dmg[i] ? bonus[i] / dmg[i] : 0,
      // 赢下的局平均第几 tick 结束（越快越好）；没赢过算无穷
      winTick: b?.winGames ? b.winTicks / b.winGames : Infinity,
      code,
    }
  })
  const best = (k: keyof (typeof raw)[number]) => Math.max(...raw.map((r) => r[k] as number))
  const ratio = (v: number, max: number) => (max > 0 ? Math.max(0, Math.min(1, v / max)) : 0)
  const fastest = Math.min(...raw.map((r) => r.winTick))
  const out: Record<string, RadarAxis[]> = {}
  names.forEach((name, i) => {
    const r = raw[i]
    out[name] = [
      { label: "经济", text: `每局采 ${Math.round(r.income)}`, score: ratio(r.income, best("income")) },
      { label: "生产", text: `每局造 ${Math.round(r.produced)} 个`, score: ratio(r.produced, best("produced")) },
      { label: "战斗", text: `杀伤比 ${r.trade.toFixed(1)}`, score: ratio(r.trade, best("trade")) },
      { label: "进攻", text: `每局拆 ${r.raze.toFixed(1)} 座`, score: ratio(r.raze, best("raze")) },
      hasCounters
        ? { label: "克制", text: `克制伤害 ${Math.round(r.counter * 100)}%`, score: ratio(r.counter, best("counter")) }
        : { label: "速胜", text: Number.isFinite(r.winTick) ? `平均 ${Math.round(r.winTick)} tick 赢` : "没赢过", score: Number.isFinite(r.winTick) ? ratio(fastest, r.winTick) : 0 },
      { label: "代码", text: `${r.code} 行`, score: ratio(r.code, best("code")) },
    ]
  })
  return out
}

/** 联赛的分析：有缓存且局数、版本对得上就直接用 */
export function analyzeLeague(series: SeriesFile, seriesFile: string): LeagueAnalysis {
  const cacheFile = resolve(seriesFile).replace(/\.series\.json$|\.json$/, "") + ".analysis.json"
  if (existsSync(cacheFile)) {
    try {
      const c = JSON.parse(readFileSync(cacheFile, "utf8")) as LeagueAnalysis
      if (c.version === VERSION && c.games === series.results.length) return c
    } catch {
      // 缓存坏了就重算
    }
  }
  const n = series.participants.length
  const dmg = new Array<number>(n).fill(0)
  const bonus = new Array<number>(n).fill(0)
  const samples: { x: number[]; y: number }[] = []
  let hasCounters = false
  for (const g of series.results) {
    const file = join(dirname(resolve(seriesFile)), g.replay)
    if (!existsSync(file)) continue
    const replay = JSON.parse(readFileSync(file, "utf8")) as Replay
    hasCounters ||= Object.values(replay.types).some((t) => t.attack?.vs && Object.keys(t.attack.vs).length > 0)
    const r = scanReplay(replay)
    samples.push(...r.samples)
    // 座位换成参赛者
    g.seats.forEach((who, p) => {
      dmg[who] += r.dmg[p] ?? 0
      bonus[who] += r.bonus[p] ?? 0
    })
  }
  const out: LeagueAnalysis = { version: VERSION, games: series.results.length, weights: fitWinModel(samples), radar: radarOf(series, seriesFile, dmg, bonus, hasCounters) }
  try {
    writeFileSync(cacheFile, JSON.stringify(out, null, 1))
  } catch {
    // 写不了缓存不要紧，下次再算
  }
  return out
}
