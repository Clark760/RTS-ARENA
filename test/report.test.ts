// 文字战报：抽样、关键事件、战斗、可能的问题；bot 日志开头附战报
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { importRuleset } from "../src/cli/catalog.ts"
import { buildReport, snapshotText } from "../src/cli/report.ts"
import { runMatch } from "../src/core/match.ts"
import type { Replay } from "../src/core/types.ts"
import { compileBot, createBot } from "../src/sandbox/quickjs.ts"

const ROOT = join(import.meta.dirname, "..")

async function frontierGame(): Promise<Replay> {
  const rules = await importRuleset("frontier")
  const bot = async (name: string, seed: number) => {
    const c = compileBot(readFileSync(join(ROOT, "rulesets", "frontier", "bots", `${name}.ts`), "utf8"))
    if ("error" in c) throw new Error(c.error)
    return { name, file: name, runner: await createBot(c.code, seed, { fuel: rules.fuel }) }
  }
  return JSON.parse(JSON.stringify(runMatch({ ruleset: rules, seed: 4, bots: [await bot("baseline", 0), await bot("rush", 1)] })))
}

test("战报：输家视角有局势抽样、建造事件、战斗、经济对比的提示", async () => {
  const replay = await frontierGame()
  assert.deepEqual(replay.result.winners, [0])
  const text = buildReport(replay, { player: 1, every: 500 })
  assert.match(text, /你是 P1/)
  assert.match(text, /^t500 +对手 P0：gold \d+/m)
  assert.match(text, /对手 P0 放下 barracks 的地基/)
  assert.match(text, /你的 barracks 建好了/)
  assert.match(text, /第一次交火/)
  assert.match(text, /## 战斗[^\n]*\nt\d+～\d+ 在 \(\d+, \d+\) 附近：/)
  // 每场战斗写上开打时各方的兵数（战报和联赛视频的侧栏用同一套切分）
  assert.match(text, /附近：[^\n]*（开打时兵数：[^\n]*\d）/)
  assert.match(text, /经济差得多/)
  assert.match(text, /你失去 base/)
  assert.match(text, /工人被卷进战斗：t\d+ 在 \(\d+, \d+\) 附近死了 \d+ 个工人（这一仗一共损失 \d+ 个单位，含这些工人；整局的损失见「经济和损失」；工人死的时候的命令：[a-zA-Z]+ \d+/)
  // 全局视角：给每个玩家的提示都带编号
  assert.match(buildReport(replay), /## 可能的问题\n- P\d：/)
})

test("战报（克制规则包，D-167）：伤害按谁打谁列、采矿一节、出兵顺序、兵营利用率、侦察兵阵亡进关键事件；--at 出某一 tick 的局面", async () => {
  const rules = await importRuleset("counter-annihilation")
  const bot = async (name: string, seed: number) => {
    const c = compileBot(readFileSync(join(ROOT, "rulesets", "counter-annihilation", "bots", `${name}.ts`), "utf8"))
    if ("error" in c) throw new Error(c.error)
    return { name, file: name, runner: await createBot(c.code, seed, { fuel: rules.fuel }) }
  }
  const replay: Replay = JSON.parse(JSON.stringify(runMatch({ ruleset: rules, seed: 9, bots: [await bot("counter", 0), await bot("llm", 1)] })))
  assert.ok(replay.map.walkable && replay.types.spearman.buildTicks === 60 && replay.types.barracks.produces?.includes("cavalry"))
  const text = buildReport(replay, { player: 0 })
  assert.match(text, /  伤害：(你|对手 P\d )打出 \d+（打在被自己克的兵上 \d+%）：/)
  assert.match(text, /## 采矿/)
  assert.match(text, /\(\d+, \d+\) 交货 \d+ 次、来回约 \d+ tick、最多派 \d+ 人 \/ 站得下 \d+/)
  assert.match(text, /出兵顺序（前 \d+ 个/)
  assert.match(text, /兵营利用率：前 \d+ tick 里能出兵的建筑大约 \d+% 的时间在出兵/)
  // 第一次交火不算侦察兵戳一下
  assert.doesNotMatch(text, /第一次交火：P\d 的 scout/)
  const snap = snapshotText(replay, 600)
  assert.match(snap, /^# 第 600 tick 的局面/)
  assert.match(snap, /字母：B base、A barracks、W worker/)
  assert.match(snap, /#\d+ spearman \(\d+, \d+\) \d+\/130 /)
  assert.equal(snap.split("\n").filter((l) => /^ {0,2}\d{1,3} \S/.test(l)).length, replay.map.height)
})

test("战报：事件太多时先把采完的资源点合成一行，--full 全列；同一个位置反复被拆；闲下来之前在做什么", () => {
  const ores = Array.from({ length: 60 }, (_, i) => ({ id: 100 + i, type: "ore", owner: -1, x: i % 20, y: 5 + Math.floor(i / 20), hp: 50, ord: "idle" }))
  const hut = (id: number) => ({ id, type: "hut", owner: 0, x: 10, y: 10, hp: 10, ord: "idle", bp: 0 })
  const frames = Array.from({ length: 400 }, (_, i) => ({ t: i + 1 }) as Record<string, unknown>)
  for (let k = 1; k <= 60; k++) frames[k - 1].die = [100 + k - 1]
  frames[0].ord = [[1, "idle"]]
  frames[99].spawn = [hut(500)]
  frames[109].die = [500]
  frames[119].spawn = [hut(501)]
  frames[129].die = [501]
  const replay: Replay = JSON.parse(
    JSON.stringify({
      format: "rts-arena-replay",
      version: 1,
      ruleset: { id: "t", name: "测试" },
      seed: 1,
      tickRate: 10,
      maxTicks: 400,
      players: [
        { name: "a", bot: "a.ts", team: 0 },
        { name: "b", bot: "b.ts", team: 1 },
      ],
      map: { width: 20, height: 20, terrain: Array(20).fill(".".repeat(20)), colors: { ".": "#000000" } },
      types: {
        u: { kind: "unit", w: 1, h: 1, maxHp: 10, moveTicks: 1, sight: 2, cost: { gold: 10 }, worker: true, look: { shape: "circle" } },
        ore: { kind: "resource", w: 1, h: 1, maxHp: 0, moveTicks: 0, sight: 0, look: { shape: "diamond" } },
        hut: { kind: "building", w: 1, h: 1, maxHp: 100, moveTicks: 0, sight: 2, cost: { gold: 10 }, look: { shape: "square" } },
      },
      initial: {
        entities: [{ id: 1, type: "u", owner: 0, x: 0, y: 0, hp: 10, ord: "gather #100" }, ...ores],
        players: [
          { resources: { gold: 0 }, score: 0, alive: true },
          { resources: { gold: 0 }, score: 0, alive: true },
        ],
        markers: [],
        status: "",
      },
      frames,
      result: { winner: null, winners: [], reason: "到时间", tick: 400, ranking: [[0, 1]] },
      bots: [0, 1].map((p) => ({ player: p, bot: "x", status: "ok", calls: 1, fuelTotal: 0, fuelMax: 0, errors: 0, fuelOuts: 0, rejected: 0, ms: 0 })),
      perf: { peakEntities: 61, simMs: 0, botMs: 0 },
      fog: false,
    }),
  )
  const text = buildReport(replay, { player: 0 })
  assert.doesNotMatch(text, /\(3, 5\) 的 ore 采完了/)
  assert.match(text, /资源点采完了 60 处（t1～t60）/)
  assert.match(text, /你放下 hut 的地基 \(10, 10\)/)
  assert.match(text, /加 --full 列出全部事件/)
  assert.match(text, /同一个位置的建筑反复被拆：hut \(10, 10\) 2 次/)
  assert.match(text, /u #1 从 t1 闲到 t400（399 tick），闲下来时在 \(0, 0\)；闲下来之前在 gather #100（#100 这时已经没了）/)
  const full = buildReport(replay, { player: 0, full: true })
  assert.equal(full.match(/的 ore 采完了/g)?.length, 60)
  assert.doesNotMatch(full, /加 --full/)
})

test("战报：被拒命令和闲着的单位会提示", () => {
  const replay: Replay = JSON.parse(
    JSON.stringify({
      format: "rts-arena-replay",
      version: 1,
      ruleset: { id: "t", name: "测试" },
      seed: 1,
      tickRate: 10,
      maxTicks: 400,
      players: [
        { name: "a", bot: "a.ts", team: 0 },
        { name: "b", bot: "b.ts", team: 1 },
      ],
      map: { width: 4, height: 4, terrain: ["....", "....", "....", "...."], colors: { ".": "#000000" } },
      types: { u: { kind: "unit", w: 1, h: 1, maxHp: 10, moveTicks: 1, sight: 2, cost: { gold: 10 }, worker: true, look: { shape: "circle" } } },
      initial: {
        entities: [0, 1, 2].map((i) => ({ id: i + 1, type: "u", owner: 0, x: i, y: 0, hp: 10, ord: "idle" })),
        players: [
          { resources: { gold: 500 }, score: 0, alive: true },
          { resources: { gold: 0 }, score: 0, alive: true },
        ],
        markers: [],
        status: "",
      },
      frames: Array.from({ length: 400 }, (_, i) => i + 1).map((t) => ({ t, ...(t === 2 ? { errs: [{ p: 0, msg: '命令被拒：你没有 #9 这个实体（可能已经死了）  {"kind":"stop","unit":9}' }] } : {}) })),
      result: { winner: null, winners: [], reason: "到时间", tick: 400, ranking: [[0, 1]] },
      bots: [0, 1].map((p) => ({ player: p, bot: "x", status: "ok", calls: 1, fuelTotal: 0, fuelMax: 0, errors: 0, fuelOuts: 0, rejected: p === 0 ? 1 : 0, ms: 0 })),
      perf: { peakEntities: 3, simMs: 0, botMs: 0 },
      fog: false,
    }),
  )
  const text = buildReport(replay, { player: 0, every: 100 })
  assert.match(text, /被拒命令 1 条/)
  assert.match(text, /平均有 3\.0 个工人闲着/)
  assert.match(text, /u #\d+ 从 t0 闲到 t400（400 tick）/)
  assert.match(text, /钱囤着没花/)
  assert.match(text, /整局双方没有交过火/)
})

test("命令行：report 不写 --player 就按自己的 bot 这局坐的座位；自己打自己每局换种子，汇总按座位报胜场", () => {
  const dir = mkdtempSync(join(tmpdir(), "rts-arena-report-"))
  const cli = join(ROOT, "src", "cli", "arena.ts")
  const sh = (args: string[], cwd: string) => {
    const r = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    return r.stdout
  }
  try {
    sh(["init", "koth", "me"], dir)
    const cwd = join(dir, "me")
    // 两局：第二局换边，自己的 bot 坐 P1
    sh(["run", "idle", "--games", "2", "--seed", "3", "--no-check"], cwd)
    const replays = readdirSync(join(cwd, "replays")).filter((f) => /-g2\.json$/.test(f))
    assert.equal(replays.length, 1, "多局的回放文件名都带 -gN")
    const out = sh(["report", join("replays", replays[0])], cwd)
    assert.match(out, /这局坐在 P1，按 P1 写/)
    assert.match(out, /你是 P1/)
    assert.match(sh(["report", join("replays", replays[0]), "--player", "0"], cwd), /注意：P0 不是你的 bot/)
    // 自己打自己：每局换种子
    const mirror = sh(["run", "bot.ts", "--games", "2", "--seed", "7", "--no-check"], cwd)
    assert.match(mirror, /种子 7 /)
    assert.match(mirror, /种子 8 /)
    assert.match(mirror, /按座位：P0 赢 \d+，P1 赢 \d+/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
