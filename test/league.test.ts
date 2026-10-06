// 本地联赛：排名计算、命令行 league、对战接口开联赛
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createArenaApi } from "../src/cli/arena-api.ts"
import { leagueStandings, leagueTables, los, teamSplits, type LeagueGame } from "../src/cli/league.ts"

const ROOT = join(import.meta.dirname, "..")
const CLI = join(ROOT, "src", "cli", "arena.ts")

/** 两人局：winner 为 null 是平局 */
const duel = (a: number, b: number, winner: number | null): LeagueGame => ({ players: [a, b], ranking: winner === null ? [[a, b]] : [[winner], [winner === a ? b : a]] })

test("联赛排名：胜 1 分平 0.5 分；等级分和打的先后顺序无关；全胜也是有限的分数；同分同等级分并列", () => {
  const names = ["a", "b", "c"]
  const games = [duel(0, 1, 0), duel(0, 1, 0), duel(0, 2, 0), duel(1, 2, null), duel(1, 2, 1)]
  const r = leagueStandings(names, games)
  assert.deepEqual(
    r.table.map((s) => [s.name, s.rank, s.wins, s.draws, s.losses, s.points]),
    [
      ["a", 1, 3, 0, 0, 3],
      ["b", 2, 1, 1, 2, 1.5],
      ["c", 3, 0, 1, 2, 0.5],
    ],
  )
  assert.ok(Number.isFinite(r.table[0].elo) && r.table[0].elo > r.table[1].elo && r.table[1].elo > r.table[2].elo)
  assert.deepEqual(r.matrix[1][2], { w: 1, d: 1, l: 0 })
  assert.deepEqual(r.matrix[2][1], { w: 0, d: 1, l: 1 })
  // 顺序打乱，等级分一样
  const shuffled = leagueStandings(names, [...games].reverse())
  assert.deepEqual(
    shuffled.table.map((s) => s.elo),
    r.table.map((s) => s.elo),
  )
  // 完全对称：并列第一
  const tie = leagueStandings(["x", "y"], [duel(0, 1, 0), duel(0, 1, 1)])
  assert.deepEqual(
    tie.table.map((s) => [s.rank, s.elo]),
    [
      [1, 1500],
      [1, 1500],
    ],
  )
})

test("命令行 league：两两循环、换边，写汇总和每局回放；bot 目录里不写对手就和所有现成 bot 打", () => {
  const dir = mkdtempSync(join(tmpdir(), "rts-arena-league-"))
  const sh = (args: string[], cwd: string) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    return r.stdout
  }
  try {
    const out = sh(["league", "koth", "baseline", "hold", "idle", "--per-pair", "2", "--seed", "5", "--out", "lg", "--no-check"], dir)
    assert.match(out, /共 6 局/)
    assert.match(out, /名次 +bot/)
    assert.match(out, /对阵（行对列的 胜-平-负）/)
    const files = readdirSync(join(dir, "lg"))
    assert.equal(files.filter((f) => /-g\d+\.json$/.test(f)).length, 6)
    const series = JSON.parse(readFileSync(join(dir, "lg", files.find((f) => f.endsWith(".series.json"))!), "utf8"))
    assert.equal(series.kind, "league")
    assert.equal(series.results.length, 6)
    assert.equal(series.summary.standings.length, 3)
    assert.equal(series.summary.standings.at(-1).name, "idle")
    // 每对两局换边
    const pair01 = series.results.filter((g: { table: number[] }) => g.table[0] === 0 && g.table[1] === 1)
    assert.deepEqual(
      pair01.map((g: { seats: number[] }) => g.seats),
      [
        [0, 1],
        [1, 0],
      ],
    )
    // bot 目录：自己的 bot + 所有现成 bot（不含 idle）
    sh(["init", "koth", "me"], dir)
    const mine = sh(["league", "--per-pair", "1", "--no-check"], join(dir, "me"))
    assert.match(mine, /3 个 bot（me、baseline、hold）/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("对战接口开联赛：事件里有最新排名和最后的汇总；参数不对被拒", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rts-arena-league-api-"))
  const api = createArenaApi({ replaysDir: dir, cliPath: CLI, cwd: ROOT })
  const server = createServer(async (req, res) => {
    if (!(await api(req, res))) {
      res.statusCode = 404
      res.end()
    }
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (body: unknown) => fetch(base + "/api/arena/run", { method: "POST", headers: { "Content-Type": "application/json", "X-Arena": "1" }, body: JSON.stringify(body) })
  try {
    assert.equal((await post({ mode: "league", ruleset: "koth", bots: ["baseline"], perPair: 2 })).status, 400)
    assert.equal((await post({ mode: "league", ruleset: "koth", bots: ["baseline", "baseline"], perPair: 2 })).status, 400)
    assert.equal((await post({ mode: "league", ruleset: "koth", bots: ["baseline", "hold", "idle"], perPair: 0 })).status, 400)
    assert.equal((await post({ mode: "league", ruleset: "koth", bots: ["baseline", "hold", "idle"], perPair: 1, seed: 2 })).status, 200)
    let run: { running: boolean; exitCode: number; stderr: string; events: { type: string; table?: unknown[] }[] }
    for (;;) {
      run = (await (await fetch(base + "/api/arena/run")).json()) as typeof run
      if (!run.running) break
      await new Promise((r) => setTimeout(r, 200))
    }
    assert.equal(run.exitCode, 0, run.stderr)
    const types = run.events.map((e) => e.type)
    assert.deepEqual(types.filter((t) => t === "standings").length, 1, "排名只留最新的一份")
    assert.equal(types.filter((t) => t === "game").length, 3)
    assert.equal(types.at(-1), "summary")
    const series = (await (await fetch(base + "/api/arena/series")).json()) as { kind?: string }[]
    assert.equal(series[0].kind, "league")
    // 分队联赛：轮换搭档要够人数；同一个 bot 组队可以只给 2 个
    assert.equal((await post({ mode: "league", ruleset: "melee", bots: ["baseline", "idle"], teams: "2v2", partners: "mixed" })).status, 400)
    assert.equal((await post({ mode: "league", ruleset: "melee", bots: ["baseline", "idle"], teams: "2-2" })).status, 400)
    assert.equal((await post({ mode: "league", ruleset: "melee", bots: ["baseline", "idle"], teams: "2v2", partners: "same", seed: 1 })).status, 200)
    for (;;) {
      run = (await (await fetch(base + "/api/arena/run")).json()) as typeof run
      if (!run.running) break
      await new Promise((r) => setTimeout(r, 200))
    }
    assert.equal(run.exitCode, 0, run.stderr)
    const start = run.events.find((e) => e.type === "start") as unknown as { teams: string; partners: string; games: number }
    assert.deepEqual([start.teams, start.partners, start.games], ["2v2", "same", 2])
    const last = run.events.find((e) => e.type === "standings") as unknown as { stats: { bots: unknown[] } }
    assert.equal(last.stats.bots.length, 2)
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("多人局的排名：名次分（第一 1 分、最后 0 分、中间平分，并列取平均）、平均名次、两两对阵", () => {
  const names = ["a", "b", "c", "d"]
  const games: LeagueGame[] = [
    { players: [0, 1, 2, 3], ranking: [[0], [1], [2], [3]] },
    { players: [1, 2, 3, 0], ranking: [[1], [0], [2, 3]] },
    { players: [2, 3, 0, 1], ranking: [[0, 1], [2], [3]] },
  ]
  const r = leagueStandings(names, games)
  const a = r.table.find((s) => s.name === "a")!
  // a：第 1、第 2、并列第 1（算 1.5）
  assert.equal(a.avgPlace, 1.5)
  assert.equal(a.wins, 1)
  assert.equal(a.draws, 1)
  assert.equal(a.losses, 1)
  // 名次分：1 + 2/3 + (4-1.5)/3
  assert.ok(Math.abs(a.points - (1 + 2 / 3 + 2.5 / 3)) < 1e-3)
  const d = r.table.find((s) => s.name === "d")!
  assert.equal(d.rank, 4)
  // c、d 并列的那局在对阵表里算并列
  assert.deepEqual(r.matrix[2][3], { w: 2, d: 1, l: 0 })
  // a、b：一局 a 在前、一局 b 在前、一局并列
  assert.deepEqual(r.matrix[0][1], { w: 1, d: 1, l: 1 })
  assert.equal(r.table[0].name, "a")
})

test("联赛分桌：两人局全部两两组合；多人局组合少就全打，多了就抽桌、每人上场次数差不多", () => {
  assert.equal(leagueTables(6, 2, 1).tables.length, 15)
  const full = leagueTables(5, 4, 1)
  assert.equal(full.complete, true)
  assert.equal(full.tables.length, 5)
  const sampled = leagueTables(8, 4, 1)
  assert.equal(sampled.complete, false)
  assert.equal(sampled.tables.length, 12)
  const appear = new Array(8).fill(0)
  for (const t of sampled.tables) {
    assert.equal(new Set(t).size, 4)
    for (const i of t) appear[i]++
  }
  assert.ok(Math.max(...appear) - Math.min(...appear) <= 1, appear.join())
  assert.equal(leagueTables(8, 4, 1, 3).tables.length, 3)
})

test("命令行 league：多人局（混战每局 3 人），座位轮换一圈，输出平均名次", () => {
  const dir = mkdtempSync(join(tmpdir(), "rts-arena-league-ffa-"))
  try {
    const r = spawnSync(process.execPath, [CLI, "league", "melee", "baseline", "idle", join(ROOT, "bots", "annihilation", "rush.ts"), "--size", "3", "--seed", "4", "--out", "lg", "--no-check"], { cwd: dir, encoding: "utf8" })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /每局 3 人，所有组合 1 桌，每桌 3 局（轮换座位），共 3 局/)
    assert.match(r.stdout, /名次 baseline > /)
    assert.match(r.stdout, /平均名次/)
    const series = JSON.parse(readFileSync(join(dir, "lg", readdirSync(join(dir, "lg")).find((f) => f.endsWith(".series.json"))!), "utf8"))
    assert.deepEqual(
      series.results.map((g: { seats: number[] }) => g.seats),
      [
        [0, 1, 2],
        [1, 2, 0],
        [2, 0, 1],
      ],
    )
    assert.equal(series.summary.standings[0].name, "baseline")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- 分队联赛、统计 ----------

test("分队局的排名：队里每人拿队伍的分，只和不同队的人比；搭档表记同队的战绩", () => {
  const names = ["a", "b", "c", "d"]
  const games: LeagueGame[] = [
    { players: [0, 1, 2, 3], teams: [[0, 1], [2, 3]], ranking: [[0, 1], [2, 3]] },
    { players: [0, 2, 1, 3], teams: [[0, 2], [1, 3]], ranking: [[0, 2], [1, 3]] },
    { players: [0, 3, 1, 2], teams: [[0, 3], [1, 2]], ranking: [[1, 2], [0, 3]] },
  ]
  const r = leagueStandings(names, games)
  const by = (n: string) => r.table.find((s) => s.name === n)!
  assert.deepEqual([by("a").wins, by("a").losses], [2, 1])
  assert.equal(by("d").wins, 0)
  // a 和 b 同队过一次（第 1 局），不同队两次：第 2 局 a 的队在前，第 3 局 b 的队在前
  assert.deepEqual(r.matrix[0][1], { w: 1, d: 0, l: 1 })
  assert.deepEqual(r.partners![0][1], { games: 1, wins: 1, points: 1 })
  assert.deepEqual(r.partners![0][3], { games: 1, wins: 0, points: 0 })
  assert.equal(r.table[r.table.length - 1].name, "d")
  assert.equal(r.confidence!.length, 3)
})

test("分组枚举：一样大的队不分先后；把握度", () => {
  assert.equal(teamSplits([0, 1, 2, 3], [2, 2]).length, 3)
  assert.equal(teamSplits([0, 1, 2, 3, 4, 5], [3, 3]).length, 10)
  assert.equal(teamSplits([0, 1, 2, 3, 4, 5], [2, 2, 2]).length, 15)
  assert.equal(teamSplits([0, 1, 2, 3], [3, 1]).length, 4)
  assert.equal(los(0, 0), null)
  assert.equal(los(5, 5), 0.5)
  assert.ok(los(10, 0)! > 0.99)
  assert.ok(los(2, 1)! > 0.5 && los(2, 1)! < 0.9)
})

test("命令行分队联赛：轮换搭档每种分法都打、两队换位置，出搭档表；同一个 bot 组队按队伍排名；还有统计", () => {
  const dir = mkdtempSync(join(tmpdir(), "rts-arena-league-teams-"))
  try {
    // 三个什么都不做的 bot（不同文件）加 baseline：baseline 在哪队哪队赢
    for (const n of ["i1", "i2", "i3"]) writeFileSync(join(dir, `${n}.ts`), "export function onTick() {}\n")
    const run = (args: string[]) => {
      const r = spawnSync(process.execPath, [CLI, "league", "melee", ...args, "--seed", "2", "--out", "lg", "--no-check"], { cwd: dir, encoding: "utf8" })
      assert.equal(r.status, 0, r.stdout + r.stderr)
      return r.stdout
    }
    const mixed = run(["baseline", "i1.ts", "i2.ts", "i3.ts", "--teams", "2v2"])
    assert.match(mixed, /分队 2v2、轮换搭档，所有组合 1 桌，每桌 6 局/)
    assert.match(mixed, /搭档（行和列同队时/)
    assert.match(mixed, /## 统计/)
    assert.match(mixed, /把握度/)
    assert.match(mixed, /座位（各座位的得分率/)
    assert.match(mixed, /^ +1 +baseline +6 +6 /m)
    const same = run(["baseline", "i1.ts", "--teams", "2v2"])
    assert.match(same, /分队 2v2、每队是同一个 bot/)
    assert.match(same, /队1\[P0=baseline P1=baseline\] 对 队2\[P2=i1 P3=i1\]/)
    const files = readdirSync(join(dir, "lg")).filter((f) => f.endsWith(".series.json"))
    const series = files.map((f) => JSON.parse(readFileSync(join(dir, "lg", f), "utf8")))
    const m = series.find((x) => x.partners === "mixed")
    assert.ok(m.summary.partnersMatrix)
    assert.equal(m.summary.stats.bots.length, 4)
    const base = m.summary.stats.bots.find((b: { name: string }) => b.name === "baseline")
    assert.equal(base.games, 6)
    assert.equal(base.wins, 6)
    assert.ok(base.produced > 0 && base.killedUnits > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
