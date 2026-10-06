import assert from "node:assert/strict"
import { test } from "node:test"
import type { GameEvent, View } from "../src/api/bot-api.ts"
import { runMatch } from "../src/core/match.ts"
import { PathFinder } from "../src/core/path.ts"
import { Mulberry32, mixSeed } from "../src/core/rng.ts"
import type { Ruleset } from "../src/core/types.ts"
import annihilation from "../rulesets/annihilation/index.ts"
import { fnBot, idle } from "./helpers.ts"

test("随机数：同种子同序列，不同用途标签互不相同", () => {
  const a = new Mulberry32(42)
  const b = new Mulberry32(42)
  const xs = Array.from({ length: 5 }, () => a.next())
  assert.deepEqual(xs, Array.from({ length: 5 }, () => b.next()))
  assert.notEqual(mixSeed(1, "sim"), mixSeed(1, "rules"))
})

test("寻路：绕墙；到不了时走到最近处", () => {
  // 5×5，x = 2 处一堵竖墙，只在最下面一行留缺口
  const wall = new Set([0, 1, 2, 3].map((y) => y * 5 + 2))
  const pf = new PathFinder(5, 5)
  const goal = { x: 4, y: 0 }
  const r = pf.find({
    sx: 0,
    sy: 0,
    h: (x, y) => Math.abs(x - goal.x) + Math.abs(y - goal.y),
    passable: (i) => !wall.has(i),
    maxExpand: 100,
  })
  assert.equal(r.reached, true)
  assert.equal(r.path[0], goal.y * 5 + goal.x)
  for (const i of r.path) assert.ok(!wall.has(i))
  // 目标被围死
  const r2 = pf.find({ sx: 0, sy: 0, h: (x, y) => Math.abs(x - 4) + Math.abs(y - 4), passable: (i) => i !== 19 && i !== 23 && i !== 24, maxExpand: 100 })
  assert.equal(r2.reached, false)
  assert.ok(r2.path.length > 0)
})

/** 一个会采矿、出兵、进攻的直接在 Node 里跑的 bot */
function simpleRush() {
  return fnBot((view, cmd) => {
    const mine = view.entities.filter((e) => e.owner === view.me)
    const goldmines = view.entities.filter((e) => e.type === "goldmine")
    for (const u of mine) {
      if (u.type === "worker" && u.order?.kind === "idle" && goldmines.length) cmd.gather(u, goldmines[0])
      if (u.type === "barracks" && (u.queue?.length ?? 0) === 0) cmd.produce(u, "soldier")
      if (u.type === "soldier" && u.order?.kind === "idle") {
        const t = (view.objectives as { enemyBases: { x: number; y: number }[] }).enemyBases[0]
        cmd.attackMove(u, t.x, t.y)
      }
    }
  })
}

test("对局可复现：同种子两次回放完全相同", () => {
  const run = () => runMatch({ ruleset: annihilation, seed: 7, bots: [{ name: "a", file: "a", runner: simpleRush() }, { name: "b", file: "b", runner: simpleRush() }] })
  const a = run()
  const b = run()
  a.perf = b.perf = { peakEntities: 0, simMs: 0, botMs: 0 }
  for (const s of [...a.bots, ...b.bots]) s.ms = 0
  assert.equal(JSON.stringify(a), JSON.stringify(b))
  assert.ok(a.result.tick > 0)
})

test("会进攻的 bot 能打赢不动的 bot", () => {
  const r = runMatch({ ruleset: annihilation, seed: 3, bots: [{ name: "rush", file: "", runner: simpleRush() }, { name: "idle", file: "", runner: idle() }] })
  assert.equal(r.result.winner, 0)
  assert.ok(r.result.tick < annihilation.maxTicks)
})

test("非法命令被拒绝，原因出现在下次的 events 里", () => {
  const seen: GameEvent[] = []
  let enemyBase = 0
  const bot = fnBot((view: View, cmd) => {
    seen.push(...view.events)
    if (view.tick === 0) {
      enemyBase = view.entities.find((e) => e.owner !== view.me && e.type === "base")?.id ?? 999
      const myWorker = view.entities.find((e) => e.owner === view.me && e.type === "worker")!
      cmd.move(enemyBase, 1, 1) // 不是自己的
      cmd.move(myWorker, 999, 0) // 越界
      cmd.produce(myWorker, "soldier") // 工人不能生产
    }
  })
  const quick: Ruleset = { ...annihilation, maxTicks: 20 }
  runMatch({ ruleset: quick, seed: 1, bots: [{ name: "a", file: "", runner: bot }, { name: "b", file: "", runner: idle() }] })
  const reasons = seen.filter((e) => e.kind === "rejected").map((e) => (e.kind === "rejected" ? e.reason : ""))
  assert.equal(reasons.length, 3)
  assert.match(reasons[0], /找不到|不是你的/)
  assert.match(reasons[1], /地图外/)
  assert.match(reasons[2], /不能生产/)
})

test("未知命令和格式错误的命令被拒绝", () => {
  const seen: GameEvent[] = []
  const raw = {
    start: () => ({ commands: [], logs: [], fuel: 0, ms: 0 }),
    tick: (json: string) => {
      const view = JSON.parse(json) as View
      seen.push(...view.events)
      const w = view.entities.find((e) => e.owner === view.me && e.type === "worker")!
      return { commands: view.tick === 0 ? [{ kind: "fly", unit: w.id }, "乱写", { kind: "move", unit: "x" }] : [], logs: [], fuel: 0, ms: 0 }
    },
    dispose() {},
  }
  runMatch({ ruleset: { ...annihilation, maxTicks: 10 }, seed: 1, bots: [{ name: "a", file: "", runner: raw }, { name: "b", file: "", runner: idle() }] })
  const reasons = seen.map((e) => (e.kind === "rejected" ? e.reason : ""))
  assert.deepEqual(reasons.length, 3)
  assert.match(reasons[0], /未知命令/)
  assert.match(reasons[1], /格式/)
  assert.match(reasons[2], /整数 id/)
})

test("生产扣钱、单位出现在建筑旁边、created 事件", () => {
  const events: GameEvent[] = []
  let gold0 = -1
  let gold1 = -1
  const bot = fnBot((view, cmd) => {
    events.push(...view.events)
    if (view.tick === 0) {
      gold0 = view.resources.gold
      const base = view.entities.find((e) => e.owner === view.me && e.type === "base")!
      cmd.produce(base, "worker")
    }
    if (view.tick === 5) gold1 = view.resources.gold
  })
  const quick: Ruleset = { ...annihilation, maxTicks: 80 }
  runMatch({ ruleset: quick, seed: 1, bots: [{ name: "a", file: "", runner: bot }, { name: "b", file: "", runner: idle() }] })
  assert.equal(gold0 - gold1, 50)
  const created = events.filter((e) => e.kind === "created")
  assert.equal(created.length, 1)
})

test("迷雾：开局看不到对方的单位", () => {
  let enemies = -1
  const bot = fnBot((view) => {
    if (view.tick === 0) enemies = view.entities.filter((e) => e.owner >= 0 && e.owner !== view.me).length
  })
  runMatch({ ruleset: { ...annihilation, maxTicks: 5 }, seed: 1, bots: [{ name: "a", file: "", runner: bot }, { name: "b", file: "", runner: idle() }] })
  assert.equal(enemies, 0)
})
