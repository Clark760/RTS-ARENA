// 本地联赛的赛程和排名，两人局、多人局都适用。
// - 名次分：每局第一名 1 分、最后一名 0 分，中间按名次平分，并列的取平均（两人局就是胜 1、平 0.5、负 0）。
// - 等级分：把每局的名次拆成两两比较（排在前面算赢、同名次算平），每对的权重是 1/(人数-1)，
//   这样每个人每局总共算一局；再用 Bradley-Terry 模型从全部对局一起算（和打的先后顺序无关）。
//   每个 bot 先送一胜一负给一个 1500 分的虚拟对手，全胜、全败的也能算出有限的分数。
// - 赛程：每局 k 个人；所有 k 人组合不多时全打，多了就抽一部分桌，让每个 bot 上场次数差不多、两两碰面也尽量平均。
import { Mulberry32, mixSeed } from "../core/rng.ts"

export interface LeagueGame {
  /** 这局的参赛者编号（按座位） */
  players: number[]
  /** 名次：第一组是第一名（可以并列），元素是参赛者编号 */
  ranking: number[][]
}

export interface Standing {
  /** 参赛者编号（和传进来的名字顺序一致） */
  index: number
  name: string
  rank: number
  games: number
  /** 独得第一 */
  wins: number
  /** 并列第一（两人局就是平局） */
  draws: number
  /** 没拿到第一 */
  losses: number
  /** 平均名次（并列的取平均，比如两人并列第 2 就各算 2.5） */
  avgPlace: number
  /** 名次分之和 */
  points: number
  /** 得分率 = points / games */
  rate: number
  elo: number
}

/** matrix[i][j]：i 和 j 在同一局时，i 排在 j 前面（w）、并列（d）、后面（l）的次数；两人局就是胜平负 */
export type Matrix = { w: number; d: number; l: number }[][]

export function leagueStandings(names: string[], games: LeagueGame[]): { table: Standing[]; matrix: Matrix } {
  const n = names.length
  const matrix: Matrix = names.map(() => names.map(() => ({ w: 0, d: 0, l: 0 })))
  // 等级分用的加权对局：wgt[i][j] 是 i 和 j 之间的总权重，won[i] 是 i 赢得的权重（平局各一半）
  const wgt = names.map(() => new Array<number>(n).fill(0))
  const won = new Array<number>(n).fill(0)
  const st = names.map(() => ({ games: 0, wins: 0, draws: 0, losses: 0, placeSum: 0, points: 0 }))
  for (const g of games) {
    const k = g.players.length
    if (k < 2) continue
    // 每个人的名次（并列的取平均位置）
    const pos = new Map<number, number>()
    let next = 1
    for (const group of g.ranking) {
      const avg = next + (group.length - 1) / 2
      for (const p of group) pos.set(p, avg)
      next += group.length
    }
    for (const p of g.players) if (!pos.has(p)) pos.set(p, next) // 名次里漏掉的算最后
    const first = g.ranking[0] ?? []
    for (const p of g.players) {
      const s = st[p]
      s.games++
      s.placeSum += pos.get(p)!
      s.points += (k - pos.get(p)!) / (k - 1)
      if (first.includes(p) && first.length === 1) s.wins++
      else if (first.includes(p)) s.draws++
      else s.losses++
    }
    const w = 1 / (k - 1)
    for (let x = 0; x < k; x++)
      for (let y = x + 1; y < k; y++) {
        const a = g.players[x]
        const b = g.players[y]
        if (a === b) continue
        const pa = pos.get(a)!
        const pb = pos.get(b)!
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
      rate: s.games ? s.points / s.games : 0,
      elo: Math.round(1500 + 400 * Math.log10(strength[i])),
    }
  })
  // 按得分率排（抽桌时各人局数可能不一样），一样就看等级分
  const key = (s: Standing) => Math.round(s.rate * 1e6)
  table.sort((x, y) => key(y) - key(x) || y.elo - x.elo || x.index - y.index)
  table.forEach((s, k) => (s.rank = k > 0 && key(s) === key(table[k - 1]) && s.elo === table[k - 1].elo ? table[k - 1].rank : k + 1))
  return { table, matrix }
}

/** C(n, k)，大了就返回 Infinity */
function choose(n: number, k: number): number {
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

/** 命令行和日志用的文字排行榜和对阵表；multi 为真时多显示平均名次，对阵表的说明也换成多人局的 */
export function standingsText(names: string[], r: { table: Standing[]; matrix: Matrix }, multi = false): string {
  const width = Math.max(4, ...names.map((x) => [...x].length))
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - [...s].length))
  const lines = [`名次  ${pad("bot", width)}  局数  胜  平  负${multi ? "  平均名次" : ""}  得分率  等级分`]
  for (const s of r.table)
    lines.push(
      `${String(s.rank).padStart(3)}   ${pad(s.name, width)}  ${String(s.games).padStart(4)}  ${String(s.wins).padStart(2)}  ${String(s.draws).padStart(2)}  ${String(s.losses).padStart(2)}${multi ? `  ${s.avgPlace.toFixed(2).padStart(8)}` : ""}  ${`${Math.round(s.rate * 100)}%`.padStart(6)}  ${String(s.elo).padStart(6)}`,
    )
  if (multi) lines.push("（胜 = 独得第一，平 = 并列第一，负 = 没拿到第一；得分率按名次分：第一名 1 分、最后一名 0 分，中间平分）")
  lines.push("", multi ? "对阵（同一局里，行排在列前面-并列-排在后面的次数）" : "对阵（行对列的 胜-平-负）")
  const order = r.table.map((s) => s.index)
  const cell = 9
  lines.push(pad("", width) + "  " + order.map((j) => pad(names[j].slice(0, cell - 1), cell)).join(""))
  for (const i of order)
    lines.push(
      pad(names[i], width) +
        "  " +
        order
          .map((j) => {
            const c = r.matrix[i][j]
            return pad(i === j ? "—" : c.w + c.d + c.l === 0 ? "" : `${c.w}-${c.d}-${c.l}`, cell)
          })
          .join(""),
    )
  return lines.join("\n")
}
