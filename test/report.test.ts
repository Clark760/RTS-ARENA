// 文字战报：抽样、关键事件、战斗、可能的问题；bot 日志开头附战报
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
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
      maxTicks: 4,
      players: [
        { name: "a", bot: "a.ts", team: 0 },
        { name: "b", bot: "b.ts", team: 1 },
      ],
      map: { width: 4, height: 4, terrain: ["....", "....", "....", "...."], colors: { ".": "#000000" } },
      types: { u: { kind: "unit", w: 1, h: 1, maxHp: 10, moveTicks: 1, sight: 2, cost: { gold: 10 }, look: { shape: "circle" } } },
      initial: {
        entities: [0, 1, 2].map((i) => ({ id: i + 1, type: "u", owner: 0, x: i, y: 0, hp: 10, ord: "idle" })),
        players: [
          { resources: { gold: 500 }, score: 0, alive: true },
          { resources: { gold: 0 }, score: 0, alive: true },
        ],
        markers: [],
        status: "",
      },
      frames: [1, 2, 3, 4].map((t) => ({ t, ...(t === 2 ? { errs: [{ p: 0, msg: '命令被拒：你没有 #9 这个实体（可能已经死了）  {"kind":"stop","unit":9}' }] } : {}) })),
      result: { winner: null, winners: [], reason: "到时间", tick: 4, ranking: [[0, 1]] },
      bots: [0, 1].map((p) => ({ player: p, bot: "x", status: "ok", calls: 1, fuelTotal: 0, fuelMax: 0, errors: 0, fuelOuts: 0, rejected: p === 0 ? 1 : 0, ms: 0 })),
      perf: { peakEntities: 3, simMs: 0, botMs: 0 },
      fog: false,
    }),
  )
  const text = buildReport(replay, { player: 0, every: 1 })
  assert.match(text, /被拒命令 1 条/)
  assert.match(text, /平均有 3\.0 个单位闲着/)
  assert.match(text, /钱囤着没花/)
  assert.match(text, /整局双方没有交过火/)
})
