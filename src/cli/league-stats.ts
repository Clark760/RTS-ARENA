// 联赛统计：每局从回放算出每个座位的采集、造兵、损失、击杀，按 bot、按座位、按结束原因累计；
// 再加上排名里的把握度。命令行打印、对战页显示、写进联赛的汇总文件。
import { applyFrame, ReplayModel } from "../core/replay-model.ts"
import type { Replay } from "../core/types.ts"
import { adjacentConfidence, type LeagueResult } from "./league.ts"

/** 一局里一个座位的数据 */
export interface SeatGameStats {
  /** 采集估算：结束时剩的 − 开局的 + 造东西花掉的（所有资源加起来） */
  income: number
  /** 造出来的单位（不算开局就有的） */
  produced: number
  /** 损失的单位、建筑 */
  lostUnits: number
  lostBuildings: number
  /** 最后一击是这个座位的：打死的单位、拆掉的建筑（不算自己和盟友的，算中立的） */
  killedUnits: number
  killedBuildings: number
}

export function gameSeatStats(replay: Replay): SeatGameStats[] {
  const n = replay.players.length
  const types = replay.types
  const team = (p: number) => replay.players[p]?.team ?? p
  const model = new ReplayModel(replay)
  const s = model.initialState()
  const initial = new Set(s.ents.keys())
  const out: SeatGameStats[] = replay.players.map(() => ({ income: 0, produced: 0, lostUnits: 0, lostBuildings: 0, killedUnits: 0, killedBuildings: 0 }))
  const spent = new Array<number>(n).fill(0)
  const startRes = s.players.map((p) => Object.values(p.resources).reduce((a, b) => a + b, 0))
  const lastHit = new Map<number, number>()
  for (const f of replay.frames) {
    const sh = f.shots ?? []
    for (let i = 0; i < sh.length; i += 2) {
      const a = s.ents.get(sh[i])
      if (a && a.owner >= 0) lastHit.set(sh[i + 1], a.owner)
    }
    for (const id of f.die ?? []) {
      const e = s.ents.get(id)
      if (!e) continue
      const kind = types[e.type]?.kind
      if (kind === "resource") continue
      if (e.owner >= 0 && e.owner < n) {
        if (kind === "unit") out[e.owner].lostUnits++
        else out[e.owner].lostBuildings++
      }
      const by = lastHit.get(id)
      if (by !== undefined && by !== e.owner && (e.owner < 0 || team(by) !== team(e.owner))) {
        if (kind === "unit") out[by].killedUnits++
        else out[by].killedBuildings++
      }
    }
    applyFrame(s, f)
    for (const e of f.spawn ?? []) {
      if (initial.has(e.id) || e.owner < 0 || e.owner >= n) continue
      spent[e.owner] += Object.values(types[e.type]?.cost ?? {}).reduce((a: number, c) => a + (c ?? 0), 0)
      if (types[e.type]?.kind === "unit") out[e.owner].produced++
    }
  }
  s.players.forEach((p, i) => (out[i].income = Object.values(p.resources).reduce((a, b) => a + b, 0) - startRes[i] + spent[i]))
  return out
}

/** 每个座位这局的名次分（按队伍名次，各自为战时每人一队）和是不是独得第一 */
export function seatPoints(replay: Replay): { points: number; won: boolean }[] {
  const team = (p: number) => replay.players[p]?.team ?? p
  const teams = [...new Set(replay.players.map((_, p) => team(p)))]
  const K = teams.length
  const pos = new Map<number, number>()
  let next = 1
  for (const group of replay.result.ranking ?? []) {
    const ts = [...new Set(group.map(team))].filter((t) => !pos.has(t))
    if (!ts.length) continue
    for (const t of ts) pos.set(t, next + (ts.length - 1) / 2)
    next += ts.length
  }
  const won = replay.result.winners ?? []
  const soleWinTeam = new Set(won.map(team)).size === 1 && won.length > 0 ? team(won[0]) : null
  return replay.players.map((_, p) => {
    const ps = pos.get(team(p)) ?? next
    return { points: K > 1 ? (K - ps) / (K - 1) : 1, won: soleWinTeam !== null && team(p) === soleWinTeam }
  })
}

interface BotAgg {
  games: number
  wins: number
  ticks: number
  winGames: number
  winTicks: number
  income: number
  produced: number
  lostUnits: number
  lostBuildings: number
  killedUnits: number
  killedBuildings: number
  errors: number
  fuelOuts: number
  rejected: number
  dead: number
  calls: number
  fuel: number
  fuelMax: number
}

export interface LeagueStatsJson {
  /** 每个 bot（下标是参赛者编号）：累计值，除以 games 就是每局平均 */
  bots: (BotAgg & { name: string })[]
  /** 每个座位：局数、名次分之和、独得第一的局数 */
  seats: { games: number; points: number; wins: number }[]
  /** 结束原因（数字归一成 N）和次数，多的在前 */
  reasons: { reason: string; n: number }[]
}

export class LeagueStats {
  private bots: BotAgg[]
  private seats: { games: number; points: number; wins: number }[] = []
  private reasons = new Map<string, number>()
  private names: string[]

  constructor(names: string[]) {
    this.names = names
    this.bots = names.map(() => ({
      games: 0,
      wins: 0,
      ticks: 0,
      winGames: 0,
      winTicks: 0,
      income: 0,
      produced: 0,
      lostUnits: 0,
      lostBuildings: 0,
      killedUnits: 0,
      killedBuildings: 0,
      errors: 0,
      fuelOuts: 0,
      rejected: 0,
      dead: 0,
      calls: 0,
      fuel: 0,
      fuelMax: 0,
    }))
  }

  /** seats[p] 是坐在 P{p} 的参赛者编号（同一个 bot 组队时会重复出现，这局按一局算、数据加起来） */
  add(seats: number[], replay: Replay): void {
    const per = gameSeatStats(replay)
    const pts = seatPoints(replay)
    const tick = replay.result.tick
    for (const [p, info] of pts.entries()) {
      const s = (this.seats[p] ??= { games: 0, points: 0, wins: 0 })
      s.games++
      s.points += info.points
      if (info.won) s.wins++
    }
    for (const who of new Set(seats)) {
      const a = this.bots[who]
      const mine = seats.map((x, p) => (x === who ? p : -1)).filter((p) => p >= 0)
      const won = mine.some((p) => pts[p].won)
      a.games++
      a.ticks += tick
      if (won) {
        a.wins++
        a.winGames++
        a.winTicks += tick
      }
      for (const p of mine) {
        const g = per[p]
        a.income += g.income
        a.produced += g.produced
        a.lostUnits += g.lostUnits
        a.lostBuildings += g.lostBuildings
        a.killedUnits += g.killedUnits
        a.killedBuildings += g.killedBuildings
        const b = replay.bots[p]
        if (!b) continue
        a.errors += b.errors
        a.fuelOuts += b.fuelOuts
        a.rejected += b.rejected
        if (b.status === "dead") a.dead++
        a.calls += b.calls
        a.fuel += b.fuelTotal
        a.fuelMax = Math.max(a.fuelMax, b.fuelMax)
      }
    }
    const reason = replay.result.reason.replace(/\d+/g, "N")
    this.reasons.set(reason, (this.reasons.get(reason) ?? 0) + 1)
  }

  toJSON(): LeagueStatsJson {
    return {
      bots: this.bots.map((b, i) => ({ name: this.names[i], ...b })),
      seats: this.seats,
      reasons: [...this.reasons].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n),
    }
  }
}

const avg = (x: number, n: number, digits = 0) => (n ? (x / n).toFixed(digits) : "—")

/** 命令行打印的统计 */
export function statsText(stats: LeagueStatsJson, result: LeagueResult): string {
  const lines: string[] = ["## 统计"]
  lines.push("", "把握度（相邻名次直接对阵时，上面的比下面的强的把握；平局不算，局数少时不可靠）")
  for (const c of adjacentConfidence(result))
    lines.push(`  ${c.upper} > ${c.lower}：${c.w}-${c.d}-${c.l}，${c.los === null ? "两人没分出过先后" : `把握 ${(c.los * 100).toFixed(c.los > 0.99 ? 1 : 0)}%`}`)
  const names = stats.bots.map((b) => b.name)
  const width = Math.max(4, ...names.map((x) => [...x].length))
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - [...s].length))
  lines.push("", "每个 bot 每局平均（时长是 tick；采集是估算；击杀是最后一击）")
  lines.push(`  ${pad("bot", width)}  局数  时长  胜局时长    采集  造单位  损失单位  击杀单位  拆建筑  丢建筑  燃料均值  报错  燃料耗尽  被拒  停止`)
  for (const i of result.table.map((s) => s.index)) {
    const b = stats.bots[i]
    lines.push(
      `  ${pad(b.name, width)}  ${String(b.games).padStart(4)}  ${avg(b.ticks, b.games).padStart(4)}  ${avg(b.winTicks, b.winGames).padStart(8)}  ${avg(b.income, b.games).padStart(6)}  ${avg(b.produced, b.games, 1).padStart(6)}  ${avg(b.lostUnits, b.games, 1).padStart(8)}  ${avg(b.killedUnits, b.games, 1).padStart(8)}  ${avg(b.killedBuildings, b.games, 1).padStart(6)}  ${avg(b.lostBuildings, b.games, 1).padStart(6)}  ${avg(b.fuel, b.calls, 1).padStart(8)}  ${String(b.errors).padStart(4)}  ${String(b.fuelOuts).padStart(8)}  ${String(b.rejected).padStart(4)}  ${String(b.dead).padStart(4)}`,
    )
  }
  lines.push("（报错、燃料耗尽、被拒、停止是整个联赛的总数）")
  lines.push("", "座位（各座位的得分率，看地图和规则包偏不偏向某个位置）")
  lines.push("  " + stats.seats.map((s, p) => `P${p} ${s.games} 局，得分率 ${avg(s.points * 100, s.games)}%，独得第一 ${s.wins}`).join("；"))
  lines.push("", "结束原因")
  for (const r of stats.reasons.slice(0, 8)) lines.push(`  ×${r.n}  ${r.reason}`)
  if (stats.reasons.length > 8) lines.push(`  另有 ${stats.reasons.length - 8} 种`)
  return lines.join("\n")
}
