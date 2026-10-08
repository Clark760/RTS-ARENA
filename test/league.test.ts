// 本地联赛：排名计算、命令行 league、对战接口开联赛
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createArenaApi } from "../src/cli/arena-api.ts"
import { leagueStandings, leagueTables, los, standingsText, teamSplits, type LeagueGame } from "../src/cli/league.ts"
import { isRout } from "../src/cli/battles.ts"
import { excitement, gameFacts, pickHighlights } from "../src/cli/highlights.ts"
import type { Replay } from "../src/core/types.ts"

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
    assert.match(out, /对阵（行对列的 胜-平-负；行列按参赛顺序排/)
    assert.match(out, /## 精彩对局/)
    const files = readdirSync(join(dir, "lg"))
    assert.equal(files.filter((f) => /-g\d+\.json$/.test(f)).length, 6)
    const series = JSON.parse(readFileSync(join(dir, "lg", files.find((f) => f.endsWith(".series.json"))!), "utf8"))
    assert.equal(series.kind, "league")
    assert.equal(series.results.length, 6)
    assert.equal(series.summary.standings.length, 3)
    assert.equal(series.summary.standings.at(-1).name, "idle")
    assert.ok(Array.isArray(series.summary.highlights))
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
    assert.match(mine, /7 个 bot（me、baseline、boom、hold、rush、sneak、steady）/)
    // 在 bot 目录里：列出自己的 bot 没拿到第一的局；逐局那行带回放文件名
    assert.match(mine, /## 你的 bot（me）没拿到第一的局：\d+ 局/)
    assert.match(mine, /^第 1\/\d+ 局 .*koth-[\w-]+-g1\.json$/m)
    // 自己的 bot 对每个对手一行（D-175）
    assert.match(mine, /## me 对每个对手（胜-平-负，按参赛顺序）\n  baseline \d+-\d+-\d+，boom \d+-\d+-\d+，hold /)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("对阵表行列按参赛顺序排，不按名次（D-175）", () => {
  // c 全胜排第一，对阵表还是 a、b、c 的顺序
  const r = leagueStandings(["a", "b", "c"], [duel(0, 2, 2), duel(1, 2, 2), duel(0, 1, 0)])
  assert.equal(r.table[0].name, "c")
  const text = standingsText(["a", "b", "c"], r)
  const grid = text.split("\n").slice(text.split("\n").findIndex((l) => l.startsWith("对阵")) + 1)
  assert.match(grid[0], /^ {4,}a {8}b {8}c/)
  assert.deepEqual(
    grid.slice(1, 4).map((l) => l.split(/\s+/)[0]),
    ["a", "b", "c"],
  )
})

test("命令行：--no-replays 不存回放和日志；compare 两个版本按组配对比，只存结果不一样的组的回放（D-175）", () => {
  const dir = mkdtempSync(join(tmpdir(), "rts-arena-league-"))
  const sh = (args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8" })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    return r.stdout
  }
  try {
    const out = sh(["league", "koth", "baseline", "hold", "--per-pair", "2", "--seed", "5", "--out", "lg", "--no-check", "--no-replays"])
    assert.match(out, /没存回放和日志（--no-replays）/)
    const files = readdirSync(join(dir, "lg"))
    assert.deepEqual(files.filter((f) => !f.endsWith(".series.json")), [])
    const series = JSON.parse(readFileSync(join(dir, "lg", files[0]), "utf8"))
    assert.equal(series.replays, false)
    assert.ok(series.results.every((g: { replay: unknown; logs: unknown[] }) => g.replay === null && g.logs.length === 0))
    // 做视频时说清楚为什么不行
    const v = spawnSync(process.execPath, [CLI, "video-brief", join("lg", files[0])], { cwd: dir, encoding: "utf8" })
    assert.notEqual(v.status, 0)
    assert.match(v.stdout + v.stderr, /没存回放/)
    // compare：baseline → hold，对 boom、idle 各 2 组
    const cmp = sh(["compare", "koth", "baseline", "hold", "boom", "idle", "--per-pair", "2", "--seed", "5", "--out", "cmp", "--no-check"])
    assert.match(cmp, /对比：baseline → hold，对手 2 个（boom、idle），每个对手 2 组/)
    assert.match(cmp, /## 对比：baseline → hold/)
    assert.match(cmp, /^合计 +\d+-\d+-\d+ +\d+-\d+-\d+ +\d+ \/ \d+$/m)
    assert.match(cmp, /^→ /m)
    const better = Number(/^合计 .* (\d+) \/ (\d+)$/m.exec(cmp)![1])
    const worse = Number(/^合计 .* (\d+) \/ (\d+)$/m.exec(cmp)![2])
    const saved = existsSync(join(dir, "cmp")) ? readdirSync(join(dir, "cmp")).filter((f) => f.endsWith(".json")) : []
    // 每个结果不一样的组存两局（两个版本各一局）
    assert.equal(saved.length, 2 * (better + worse))
    assert.ok(saved.every((f) => f.includes("-cmp-s")))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("命令行：联赛里同一个 bot 可以报名两次（带编号）；统计有座位区间、损失的工人；help <命令>；run --quiet 每局一行", () => {
  const dir = mkdtempSync(join(tmpdir(), "rts-arena-league-"))
  const sh = (args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8" })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    return r.stdout
  }
  try {
    const out = sh(["league", "koth", "baseline", "baseline", "idle", "--per-pair", "1", "--seed", "3", "--out", "lg", "--no-check"])
    assert.match(out, /3 个 bot（baseline#1、baseline#2、idle）/)
    assert.match(out, /其中工人/)
    assert.match(out, /P0 3 局，得分率 \d+% ±\d+%/)
    const help = sh(["help", "run"])
    assert.match(help, /--quiet/)
    assert.doesNotMatch(help, /new-rules/)
    const q = sh(["run", "koth", "baseline", "idle", "--games", "2", "--seed", "1", "--quiet", "--no-check", "--out", "q"])
    const games = q.split("\n").filter((l) => l.startsWith("第 "))
    assert.equal(games.length, 2, q)
    assert.match(games[0], /^第 1\/2 局 .*（第 \d+ tick，/)
    assert.doesNotMatch(q, /的日志：/)
    assert.match(q, /共 2 局：/)
    // 两个不同的 bot：给得分率和 95% 区间；--ticks 打到那一刻就结束
    assert.match(q, /得分率（胜 1 平 0\.5）：baseline \d+%，idle \d+%，95% 区间 ±\d+%/)
    const short = sh(["run", "koth", "baseline", "idle", "--seed", "1", "--ticks", "50", "--quiet", "--no-check", "--out", "t"])
    assert.match(short, /打到第 50 tick 就结束/)
    assert.match(short, /（第 50 tick，/)
    // league --focus：只打第一个 bot 对其余每个，对序号和种子和不加时一样（换一个候选、同一个 --seed，对同一个对手的种子相同）
    const all = sh(["league", "koth", "baseline", "rush", "idle", "--per-pair", "2", "--seed", "5", "--out", "f1", "--no-check"])
    const focus = sh(["league", "koth", "baseline", "rush", "idle", "--per-pair", "2", "--seed", "5", "--out", "f2", "--no-check", "--focus"])
    const other = sh(["league", "koth", "hold", "rush", "idle", "--per-pair", "2", "--seed", "5", "--out", "f3", "--no-check", "--focus"])
    assert.match(focus, /只打 baseline 对其余每个（--focus），2 对，每对 2 局/)
    const seedsOf = (out: string, a: string, b: string) =>
      out.split("\n").filter((l) => l.includes(`=${a} `) && l.includes(`=${b} `) || (l.includes(`=${b} `) && l.includes(`=${a}`))).map((l) => l.match(/种子 (\d+)/)?.[1])
    assert.equal(focus.split("\n").filter((l) => /^第 \d+\/4 局/.test(l)).length, 4)
    assert.deepEqual(seedsOf(focus, "baseline", "idle"), seedsOf(all, "baseline", "idle"))
    assert.deepEqual(seedsOf(other, "hold", "idle"), seedsOf(focus, "baseline", "idle"))
    // bot 目录里写满了对手：提示在前面写上规则包
    sh(["init", "koth", "me"])
    const r = spawnSync(process.execPath, [CLI, "run", "hold", "rush", "--no-check"], { cwd: join(dir, "me"), encoding: "utf8" })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /rts-arena run koth hold rush/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("一边倒：只有一方在死人、有一方没死兵、或者死得少的一方不到对方的 1/4，都不算大战", () => {
  const d = (owner: number, fighter: boolean, k: number) => Array.from({ length: k }, () => ({ owner, fighter }))
  assert.equal(isRout(d(1, false, 6)), true, "兵冲进矿区杀了 6 个工人，自己没死")
  assert.equal(isRout([...d(1, false, 8), ...d(0, true, 2)]), true, "杀了 8 个工人、死了 2 个兵：守方没死兵")
  assert.equal(isRout([...d(0, true, 9), ...d(1, true, 2)]), true, "兵对兵 9 : 2")
  assert.equal(isRout([...d(0, true, 5), ...d(1, true, 2), ...d(1, false, 4)]), false, "兵对兵 5 : 2，再加 4 个工人")
  // 分队时盟友合在一起算
  assert.equal(isRout([...d(0, true, 2), ...d(2, true, 3), ...d(1, true, 1)], (p) => p % 2), true, "盟友合起来死 5 个、对面死 1 个")
  assert.equal(isRout([...d(0, true, 2), ...d(2, true, 1), ...d(1, true, 1)], (p) => p % 2), false)
})

test("精彩对局：落后又反超算逆转，主基地差点被拆算险胜；挑的时候同一组对手最多 2 局，太平淡的不要", () => {
  const unit = (id: number, owner: number, x: number) => ({ id, type: "u", owner, x, y: 5, hp: 10, ord: "idle" })
  const frames: Record<string, unknown>[] = Array.from({ length: 100 }, (_, i) => ({ t: i + 1 }))
  frames[39].hp = [1, 20] // P0 的主基地挨打，剩 20%
  frames[49].spawn = Array.from({ length: 10 }, (_, i) => unit(100 + i, 0, i)) // P0 补了 10 个兵，反超
  frames[59].die = [20, 21, 22, 23, 24] // P1 的兵全死了
  const replay = JSON.parse(
    JSON.stringify({
      format: "rts-arena-replay",
      players: [
        { name: "a", bot: "a.ts", team: 0 },
        { name: "b", bot: "b.ts", team: 1 },
      ],
      types: {
        u: { kind: "unit", w: 1, h: 1, maxHp: 10, cost: { gold: 10 } },
        base: { kind: "building", w: 2, h: 2, maxHp: 100 },
      },
      initial: {
        entities: [{ id: 1, type: "base", owner: 0, x: 0, y: 0, hp: 100, ord: "idle" }, { id: 2, type: "base", owner: 1, x: 20, y: 0, hp: 100, ord: "idle" }, unit(10, 0, 1), ...[20, 21, 22, 23, 24].map((id) => unit(id, 1, id))],
        players: [
          { resources: {}, score: 0, alive: true },
          { resources: {}, score: 0, alive: true },
        ],
        markers: [],
        status: "",
      },
      frames,
      result: { winner: 0, winners: [0], reason: "摧毁了对方主基地", tick: 100, ranking: [[0], [1]] },
      bots: [0, 1].map((p) => ({ player: p, status: "ok", errors: 0, fuelOuts: 0 })),
    }),
  ) as Replay
  const f = gameFacts(replay)
  assert.equal(f.winner, 0)
  assert.ok(f.materialLow && Math.abs(f.materialLow.ratio - 0.2) < 1e-9, JSON.stringify(f.materialLow))
  assert.equal(f.leadChanges, 1)
  assert.equal(f.winnerBaseMin, 0.2)
  const names = ["甲", "乙"]
  const ex = excitement(f, { level: 1, text: "爆冷：……" }, (s) => names[s])
  assert.match(ex.reasons.join("；"), /逆转：t\d+ 时 甲 的兵力和建筑只有 乙 的 20%/)
  assert.match(ex.reasons.join("；"), /险胜：甲 的主基地一度只剩 20% 血/)
  assert.ok(ex.score > 60 && ex.score <= 100, String(ex.score))
  // 两边都伤得重才算看点：一方被打光、另一方几乎没损失的不算
  assert.ok(!excitement({ ...f, sideLoss: [0.05, 0.9] }, null, (s) => names[s]).reasons.some((r) => r.includes("伤得重")))
  assert.ok(excitement({ ...f, sideLoss: [0.5, 0.6] }, null, (s) => names[s]).reasons.includes("两边都伤得重：乙 损失 60%，甲 损失 50%"))
  // bot 出错扣分
  assert.ok(excitement({ ...f, trouble: true }, null, (s) => names[s]).score < ex.score - 25)
  // 每项都没到写出来的门槛（几样都沾一点）：往后排，看点写占分最多那项的实际数字，不空着
  const mild = { ...f, materialLow: { ...f.materialLow!, ratio: 0.9 }, leadChanges: 1, killedRatio: 0.3, sideLoss: [0.3, 0.1], battles: 1, biggestBattle: 4, winnerBaseMin: 0.9, finalScores: { winner: 400, foe: 280 } }
  const exMild = excitement(mild, null, (s) => names[s])
  assert.deepEqual(exMild.reasons, ["比分 400 : 280"])
  // 挑：同一组对手最多 2 局，不到 20 分的不要
  const h = (index: number, key: string, score: number) => ({ index, seed: 1, replay: `g${index}.json`, who: key, winner: null, tick: 1, score, reasons: [], key })
  assert.deepEqual(
    pickHighlights([h(1, "a|b", 90), h(2, "a|b", 80), h(3, "a|b", 70), h(4, "a|c", 60), h(5, "b|c", 10)], 5).map((x) => x.index),
    [1, 2, 4],
  )
  // 同一组对手、同一方赢的先只挑 1 局（不挑出两局一样的故事），另一方赢的那局排上来
  const hw = (index: number, key: string, score: number, winner: string) => ({ ...h(index, key, score), winner })
  assert.deepEqual(
    pickHighlights([hw(1, "a|b", 90, "a"), hw(2, "a|b", 85, "a"), hw(3, "a|b", 80, "b"), hw(4, "a|c", 60, "a")], 5).map((x) => x.index),
    [1, 3, 4],
  )
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
    assert.equal((await post({ mode: "league", ruleset: "koth", bots: Array(17).fill("baseline"), perPair: 2 })).status, 400)
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
    // 两队：默认打两轮（每桌 4 局），一轮只有 2 局误差太大
    assert.deepEqual([start.teams, start.partners, start.games], ["2v2", "same", 4])
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
    const r = spawnSync(process.execPath, [CLI, "league", "melee", "baseline", "idle", join(ROOT, "rulesets", "annihilation", "bots", "rush.ts"), "--size", "3", "--seed", "4", "--out", "lg", "--no-check"], { cwd: dir, encoding: "utf8" })
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
