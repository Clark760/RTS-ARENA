// 本地联赛：排名计算、命令行 league、对战接口开联赛
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createArenaApi } from "../src/cli/arena-api.ts"
import { leagueStandings, leagueTables, type LeagueGame } from "../src/cli/league.ts"

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
