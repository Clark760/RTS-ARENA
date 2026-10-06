// 文字战报：抽样、关键事件、战斗、可能的问题；bot 日志开头附战报
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { importRuleset } from "../src/cli/catalog.ts"
import { buildReport } from "../src/cli/report.ts"
import { runMatch } from "../src/core/match.ts"
import type { Replay } from "../src/core/types.ts"
import { compileBot, createBot } from "../src/sandbox/quickjs.ts"

const ROOT = join(import.meta.dirname, "..")

async function frontierGame(): Promise<Replay> {
  const rules = await importRuleset("frontier")
  const bot = async (name: string, seed: number) => {
    const c = compileBot(readFileSync(join(ROOT, "bots", "frontier", `${name}.ts`), "utf8"))
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
  assert.match(text, /经济差得多/)
  assert.match(text, /你失去 base/)
  // 全局视角：给每个玩家的提示都带编号
  assert.match(buildReport(replay), /## 可能的问题\n- P\d：/)
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
