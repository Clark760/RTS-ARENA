// 本地联赛的排名：两人对局的循环赛，胜 1 分、平 0.5 分；等级分按 Bradley-Terry 模型从全部对局算
// （和打的先后顺序无关）。每个 bot 先送一胜一负给一个 1500 分的虚拟对手，全胜、全败的也能算出有限的分数。

export interface LeagueGame {
  /** 两个参赛者的编号 */
  a: number
  b: number
  /** 赢的参赛者编号；平局为 null */
  winner: number | null
}

export interface Standing {
  /** 参赛者编号（和传进来的名字顺序一致） */
  index: number
  name: string
  rank: number
  games: number
  wins: number
  draws: number
  losses: number
  /** 胜 1 分、平 0.5 分 */
  points: number
  /** 得分率 = points / games */
  rate: number
  elo: number
}

/** matrix[i][j]：i 对 j 的胜、平、负 */
export type Matrix = { w: number; d: number; l: number }[][]

export function leagueStandings(names: string[], games: LeagueGame[]): { table: Standing[]; matrix: Matrix } {
  const n = names.length
  const matrix: Matrix = names.map(() => names.map(() => ({ w: 0, d: 0, l: 0 })))
  for (const g of games) {
    if (g.winner === null) {
      matrix[g.a][g.b].d++
      matrix[g.b][g.a].d++
    } else {
      const loser = g.winner === g.a ? g.b : g.a
      matrix[g.winner][loser].w++
      matrix[loser][g.winner].l++
    }
  }
  // Bradley-Terry：strength[i] 的 MM 迭代；虚拟对手强度固定为 1，每人和它一胜一负
  const wins = names.map((_, i) => matrix[i].reduce((a, c) => a + c.w + c.d / 2, 0) + 1)
  const strength = new Array<number>(n).fill(1)
  for (let it = 0; it < 500; it++) {
    let delta = 0
    for (let i = 0; i < n; i++) {
      let denom = 2 / (strength[i] + 1)
      for (let j = 0; j < n; j++) {
        const games = matrix[i][j].w + matrix[i][j].d + matrix[i][j].l
        if (j !== i && games > 0) denom += games / (strength[i] + strength[j])
      }
      const next = wins[i] / denom
      delta = Math.max(delta, Math.abs(next - strength[i]))
      strength[i] = next
    }
    if (delta < 1e-9) break
  }
  const table: Standing[] = names.map((name, i) => {
    const row = matrix[i]
    const w = row.reduce((a, c) => a + c.w, 0)
    const d = row.reduce((a, c) => a + c.d, 0)
    const l = row.reduce((a, c) => a + c.l, 0)
    const games = w + d + l
    const points = w + d / 2
    return { index: i, name, rank: 0, games, wins: w, draws: d, losses: l, points, rate: games ? points / games : 0, elo: Math.round(1500 + 400 * Math.log10(strength[i])) }
  })
  table.sort((x, y) => y.points - x.points || y.elo - x.elo || x.index - y.index)
  // 同分同等级分并列
  table.forEach((s, k) => (s.rank = k > 0 && s.points === table[k - 1].points && s.elo === table[k - 1].elo ? table[k - 1].rank : k + 1))
  return { table, matrix }
}

/** 命令行和日志用的文字排行榜和对阵表 */
export function standingsText(names: string[], r: { table: Standing[]; matrix: Matrix }): string {
  const width = Math.max(4, ...names.map((x) => [...x].length))
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - [...s].length))
  const lines = [`名次  ${pad("bot", width)}  局数  胜  平  负  得分率  等级分`]
  for (const s of r.table)
    lines.push(
      `${String(s.rank).padStart(3)}   ${pad(s.name, width)}  ${String(s.games).padStart(4)}  ${String(s.wins).padStart(2)}  ${String(s.draws).padStart(2)}  ${String(s.losses).padStart(2)}  ${`${Math.round(s.rate * 100)}%`.padStart(6)}  ${String(s.elo).padStart(6)}`,
    )
  lines.push("", "对阵（行对列的 胜-平-负）")
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
