// 本地联赛的赛程和排名：两人局、多人局、分队局都适用。
// - 名次分：每局第一名 1 分、最后一名 0 分，中间按名次平分，并列的取平均（两人局就是胜 1、平 0.5、负 0）。
//   分队局按队伍的名次算，队里每个人拿队伍的分。
// - 等级分：把每局的名次拆成两两比较（排在前面算赢、同名次算平；分队局只比不同队的人），
//   权重让每个人每局总共算一局；再用 Bradley-Terry 模型从全部对局一起算（和打的先后顺序无关）。
//   每个 bot 先送一胜一负给一个 1500 分的虚拟对手，全胜、全败的也能算出有限的分数。
// - 赛程：每局 k 个人；所有 k 人组合不多时全打，多了就抽一部分桌，让每个 bot 上场次数差不多、两两碰面也尽量平均。
import { Mulberry32, mixSeed } from "../core/rng.ts"

export interface LeagueGame {
  /** 这局的参赛者编号（按座位；同一个参赛者在一局里只出现一次） */
  players: number[]
  /** 名次：第一组是第一名（可以并列），元素是参赛者编号 */
  ranking: number[][]
  /** 分队局：每队的参赛者编号；不给就是各自为战 */
  teams?: number[][]
}

export interface Standing {
  /** 参赛者编号（和传进来的名字顺序一致） */
  index: number
  name: string
  rank: number
  games: number
  /** 独得第一（分队局是所在的队独得第一） */
  wins: number
  /** 并列第一（两人局就是平局） */
  draws: number
  /** 没拿到第一 */
  losses: number
  /** 平均名次（并列的取平均，比如两人并列第 2 就各算 2.5；分队局是队伍的名次） */
  avgPlace: number
  /** 名次分之和 */
  points: number
  /** 得分率 = points / games */
  rate: number
  /** 得分率的 95% 区间半宽（保守估计，局数少时很宽） */
  rateCi: number
  elo: number
}

/** matrix[i][j]：i 和 j 在同一局（分队局是不同队）时，i 排在 j 前面（w）、并列（d）、后面（l）的次数；两人局就是胜平负 */
export type Matrix = { w: number; d: number; l: number }[][]

/** partners[i][j]：i 和 j 同队的局数、这些局里队伍独得第一的次数、队伍名次分之和 */
export type PartnerMatrix = { games: number; wins: number; points: number }[][]

export interface LeagueResult {
  table: Standing[]
  matrix: Matrix
  /** 只在有分队局时有 */
  partners?: PartnerMatrix
  /** 相邻名次之间的把握度 */
  confidence?: Confidence[]
}

export interface Confidence {
  upper: string
  lower: string
  w: number
  d: number
  l: number
  los: number | null
}

export function leagueStandings(names: string[], games: LeagueGame[]): LeagueResult {
  const n = names.length
  const matrix: Matrix = names.map(() => names.map(() => ({ w: 0, d: 0, l: 0 })))
  const partners: PartnerMatrix = names.map(() => names.map(() => ({ games: 0, wins: 0, points: 0 })))
  let teamed = false
  // 等级分用的加权对局：wgt[i][j] 是 i 和 j 之间的总权重，won[i] 是 i 赢得的权重（平局各一半）
  const wgt = names.map(() => new Array<number>(n).fill(0))
  const won = new Array<number>(n).fill(0)
  const st = names.map(() => ({ games: 0, wins: 0, draws: 0, losses: 0, placeSum: 0, points: 0 }))
  for (const g of games) {
    // 各自为战时每人一队
    const teams = g.teams ?? g.players.map((p) => [p])
    if (g.teams) teamed = true
    const K = teams.length
    if (K < 2) continue
    const teamOf = new Map<number, number>()
    teams.forEach((members, t) => members.forEach((p) => teamOf.set(p, t)))
    // 队伍的名次：名次组里出现的队伍按先后排，同一组里的并列；并列的取平均位置
    const teamPos = new Map<number, number>()
    let next = 1
    for (const group of g.ranking) {
      const ts = [...new Set(group.map((p) => teamOf.get(p)).filter((t): t is number => t !== undefined && !teamPos.has(t)))]
      if (!ts.length) continue
      const avg = next + (ts.length - 1) / 2
      for (const t of ts) teamPos.set(t, avg)
      next += ts.length
    }
    for (let t = 0; t < K; t++) if (!teamPos.has(t)) teamPos.set(t, next) // 名次里漏掉的算最后
    const firstTeams = [...teamPos].filter(([, v]) => v === Math.min(...teamPos.values())).map(([t]) => t)
    const soleFirst = firstTeams.length === 1 && teamPos.get(firstTeams[0]) === 1
    for (const p of g.players) {
      const t = teamOf.get(p)
      if (t === undefined) continue
      const pos = teamPos.get(t)!
      const pts = (K - pos) / (K - 1)
      const s = st[p]
      s.games++
      s.placeSum += pos
      s.points += pts
      if (firstTeams.includes(t) && soleFirst) s.wins++
      else if (firstTeams.includes(t)) s.draws++
      else s.losses++
    }
    // 搭档：同队的两两
    for (const [t, members] of teams.entries())
      for (const a of members)
        for (const b of members) {
          if (a === b) continue
          const c = partners[a][b]
          c.games++
          c.points += (K - teamPos.get(t)!) / (K - 1)
          if (firstTeams.includes(t) && soleFirst) c.wins++
        }
    // 两两比较：只比不同队的；权重让每人每局一共算一局（队伍一样大时每对 1/对手人数）
    const total = g.players.length
    for (let x = 0; x < g.players.length; x++)
      for (let y = x + 1; y < g.players.length; y++) {
        const a = g.players[x]
        const b = g.players[y]
        const ta = teamOf.get(a)
        const tb = teamOf.get(b)
        if (a === b || ta === undefined || tb === undefined || ta === tb) continue
        const oppA = total - teams[ta].length
        const oppB = total - teams[tb].length
        const w = 2 / (oppA + oppB)
        const pa = teamPos.get(ta)!
        const pb = teamPos.get(tb)!
        wgt[a][b] += w
        wgt[b][a] += w
        if (pa === pb) {
          matrix[a][b].d++
          matrix[b][a].d++
          won[a] += w / 2
          won[b] += w / 2
        } else {
          const [hi, lo] = pa < pb ? [a, b] : [b, a]
          matrix[hi][lo].w++
          matrix[lo][hi].l++
          won[hi] += w
        }
      }
  }
  // Bradley-Terry 的 MM 迭代；虚拟对手强度固定为 1，每人和它一胜一负
  const strength = new Array<number>(n).fill(1)
  for (let it = 0; it < 1000; it++) {
    let delta = 0
    for (let i = 0; i < n; i++) {
      let denom = 2 / (strength[i] + 1)
      for (let j = 0; j < n; j++) if (j !== i && wgt[i][j] > 0) denom += wgt[i][j] / (strength[i] + strength[j])
      const nextS = (won[i] + 1) / denom
      delta = Math.max(delta, Math.abs(nextS - strength[i]))
      strength[i] = nextS
    }
    if (delta < 1e-10) break
  }
  const table: Standing[] = names.map((name, i) => {
    const s = st[i]
    const rate = s.games ? s.points / s.games : 0
    const half = rateCi(s.points, s.games)
    return {
      index: i,
      name,
      rank: 0,
      games: s.games,
      wins: s.wins,
      draws: s.draws,
      losses: s.losses,
      avgPlace: s.games ? Number((s.placeSum / s.games).toFixed(2)) : 0,
      points: Number(s.points.toFixed(3)),
      rate,
      rateCi: s.games ? Number(half.toFixed(3)) : 0,
      elo: Math.round(1500 + 400 * Math.log10(strength[i])),
    }
  })
  // 按得分率排（抽桌时各人局数可能不一样），一样就看等级分
  const key = (s: Standing) => Math.round(s.rate * 1e6)
  table.sort((x, y) => key(y) - key(x) || y.elo - x.elo || x.index - y.index)
  table.forEach((s, k) => (s.rank = k > 0 && key(s) === key(table[k - 1]) && s.elo === table[k - 1].elo ? table[k - 1].rank : k + 1))
  const result: LeagueResult = teamed ? { table, matrix, partners } : { table, matrix }
  result.confidence = adjacentConfidence(result)
  return result
}

/**
 * 得分率（points / games，每局 0～1 分）95% 区间的半宽：名次分在 0～1 之间，方差不超过同样得分率的胜负局；
 * 再像 Agresti-Coull 那样加 2 胜 2 负往 50% 收缩，局数少（甚至全胜）时区间不会窄得离谱
 */
export function rateCi(points: number, games: number): number {
  if (!games) return 0
  const shrunk = (points + 2) / (games + 4)
  return 1.96 * Math.sqrt((shrunk * (1 - shrunk)) / (games + 4))
}

/** 误差函数（Abramowitz-Stegun 7.1.26，误差 < 1.5e-7） */
function erf(x: number): number {
  const s = Math.sign(x)
  const a = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * a)
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a)
  return s * y
}

/**
 * 把握度（LOS，likelihood of superiority）：w 胜 l 负（平局不算）时，"前者确实更强"的把握，0～1。
 * 下棋引擎测试常用的近似：Φ((w − l) / √(w + l))
 */
export function los(w: number, l: number): number | null {
  if (w + l === 0) return null
  return 0.5 * (1 + erf((w - l) / Math.sqrt(2 * (w + l))))
}

/** 相邻名次之间的把握度：用两人在同一局（分队局是不同队）时谁排在前面的记录 */
export function adjacentConfidence(r: LeagueResult): Confidence[] {
  const out: Confidence[] = []
  for (let k = 0; k + 1 < r.table.length; k++) {
    const a = r.table[k]
    const b = r.table[k + 1]
    const c = r.matrix[a.index][b.index]
    out.push({ upper: a.name, lower: b.name, w: c.w, d: c.d, l: c.l, los: los(c.w, c.l) })
  }
  return out
}

/** C(n, k)，大了就返回 Infinity */
export function choose(n: number, k: number): number {
  let r = 1
  for (let i = 0; i < k; i++) {
    r = (r * (n - i)) / (i + 1)
    if (r > 1e9) return Infinity
  }
  return Math.round(r)
}

/** 多人局时，所有组合不超过这么多桌就全打 */
export const FULL_TABLES_UP_TO = 20

/**
 * 赛程：n 个参赛者、每局 k 个人，返回每桌的参赛者编号。两人局总是全部两两组合；
 * 多人局的组合不超过 tables（不给就是 FULL_TABLES_UP_TO）时全打，否则抽 tables 桌（不给就是 ⌈n×6/k⌉，每人大约上场 6 桌）：
 * 每次从一批随机组合里挑上场次数最少、两两碰面最少的那个
 */
export function leagueTables(n: number, k: number, seed: number, tables?: number): { tables: number[][]; complete: boolean } {
  const total = choose(n, k)
  if (total <= (tables ?? (k === 2 ? Infinity : FULL_TABLES_UP_TO))) {
    const out: number[][] = []
    const walk = (start: number, cur: number[]) => {
      if (cur.length === k) return void out.push([...cur])
      for (let i = start; i < n; i++) walk(i + 1, [...cur, i])
    }
    walk(0, [])
    return { tables: out, complete: true }
  }
  const rng = new Mulberry32(mixSeed(seed, "league-tables"))
  const appear = new Array<number>(n).fill(0)
  const met = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  const out: number[][] = []
  const limit = tables ?? Math.ceil((n * 6) / k)
  for (let t = 0; t < limit; t++) {
    let best: number[] | null = null
    let bestScore = Infinity
    for (let c = 0; c < 200; c++) {
      const ids = [...Array(n).keys()]
      rng.shuffle(ids)
      const pick = ids.slice(0, k).sort((a, b) => a - b)
      let score = 0
      for (const i of pick) score += appear[i] * 1000
      for (let x = 0; x < k; x++) for (let y = x + 1; y < k; y++) score += met[pick[x]][pick[y]]
      if (score < bestScore) {
        best = pick
        bestScore = score
      }
    }
    for (const i of best!) appear[i]++
    for (let x = 0; x < k; x++)
      for (let y = x + 1; y < k; y++) {
        met[best![x]][best![y]]++
        met[best![y]][best![x]]++
      }
    out.push(best!)
  }
  return { tables: out, complete: false }
}

/**
 * 把一桌的人分成给定大小的几队，列出所有不同的分法（一样大的队不分先后）。
 * 比如 4 个人 2v2 有 3 种分法，6 个人 3v3 有 10 种，6 个人 2v2v2 有 15 种
 */
export function teamSplits(members: number[], sizes: number[]): number[][][] {
  const out: number[][][] = []
  const seen = new Set<string>()
  const walk = (rest: number[], k: number, acc: number[][]) => {
    if (k === sizes.length) {
      // 一样大的队排序后去重
      const key = sizes
        .map((s, i) => ({ s, t: [...acc[i]].sort((a, b) => a - b).join(",") }))
        .sort((a, b) => a.s - b.s || (a.t < b.t ? -1 : 1))
        .map((x) => `${x.s}:${x.t}`)
        .join("|")
      if (!seen.has(key)) {
        seen.add(key)
        out.push(acc.map((t) => [...t]))
      }
      return
    }
    const pick = (start: number, cur: number[]) => {
      if (cur.length === sizes[k]) {
        walk(
          rest.filter((x) => !cur.includes(x)),
          k + 1,
          [...acc, cur],
        )
        return
      }
      for (let i = start; i < rest.length; i++) pick(i + 1, [...cur, rest[i]])
    }
    pick(0, [])
  }
  walk(members, 0, [])
  return out
}

export interface TextOptions {
  /** 多人局（多显示平均名次） */
  multi?: boolean
  /** 分队局 */
  teams?: boolean
}

/** 命令行和日志用的文字排行榜、对阵表、搭档表 */
export function standingsText(names: string[], r: LeagueResult, opt: TextOptions = {}): string {
  const multi = opt.multi === true || opt.teams === true
  const width = Math.max(4, ...names.map((x) => [...x].length))
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - [...s].length))
  const lines = [`名次  ${pad("bot", width)}  局数  胜  平  负${multi ? "  平均名次" : ""}  得分率（95% 区间）  等级分`]
  for (const s of r.table) {
    const rate = `${Math.round(s.rate * 100)}% ±${Math.round(s.rateCi * 100)}`
    lines.push(
      `${String(s.rank).padStart(3)}   ${pad(s.name, width)}  ${String(s.games).padStart(4)}  ${String(s.wins).padStart(2)}  ${String(s.draws).padStart(2)}  ${String(s.losses).padStart(2)}${multi ? `  ${s.avgPlace.toFixed(2).padStart(8)}` : ""}  ${rate.padStart(17)}  ${String(s.elo).padStart(6)}`,
    )
  }
  if (opt.teams) lines.push("（分队：胜 = 所在的队独得第一；名次、得分率都按队伍的名次算，队里每个人拿队伍的分）")
  else if (multi) lines.push("（胜 = 独得第一，平 = 并列第一，负 = 没拿到第一；得分率按名次分：第一名 1 分、最后一名 0 分，中间平分）")
  lines.push(
    "",
    opt.teams ? "对阵（不同队时，行所在的队排在列所在的队前面-并列-后面的次数）" : multi ? "对阵（同一局里，行排在列前面-并列-排在后面的次数）" : "对阵（行对列的 胜-平-负）",
  )
  const order = r.table.map((s) => s.index)
  const cell = 9
  const grid = (cellOf: (i: number, j: number) => string) => {
    lines.push(pad("", width) + "  " + order.map((j) => pad(names[j].slice(0, cell - 1), cell)).join(""))
    for (const i of order) lines.push(pad(names[i], width) + "  " + order.map((j) => pad(i === j ? "—" : cellOf(i, j), cell)).join(""))
  }
  grid((i, j) => {
    const c = r.matrix[i][j]
    return c.w + c.d + c.l === 0 ? "" : `${c.w}-${c.d}-${c.l}`
  })
  if (r.partners) {
    lines.push("", "搭档（行和列同队时：局数 / 队伍独得第一的局数）")
    const p = r.partners
    grid((i, j) => (p[i][j].games === 0 ? "" : `${p[i][j].games}/${p[i][j].wins}`))
  }
  return lines.join("\n")
}
