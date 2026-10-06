// 按某一方的视野看回放：播放器从回放算出的可见实体，要和 bot 当时 view.entities 里的完全一样
import assert from "node:assert/strict"
import { test } from "node:test"
import type { Commands, View } from "../src/api/bot-api.ts"
import { runMatch } from "../src/core/match.ts"
import type { Replay, Ruleset } from "../src/core/types.ts"
import annihilation from "../rulesets/annihilation/index.ts"
import melee from "../rulesets/melee/index.ts"
import { ReplayModel } from "../viewer/src/model.ts"
import { Vision } from "../viewer/src/vision.ts"
import { fnBot } from "./helpers.ts"

/** 所有单位往对面冲，工人采矿：让双方的视野有进有出 */
function charger(target: (v: View) => { x: number; y: number }) {
  return (v: View, cmd: Commands) => {
    const t = target(v)
    for (const e of v.entities) {
      if (e.owner !== v.me) continue
      if (e.type === "worker" && e.order?.kind === "idle") {
        const m = v.entities.find((g) => g.type === "goldmine")
        if (m) cmd.gather(e, m)
      } else if ((e.type === "soldier" || e.type === "archer") && e.order?.kind === "idle") cmd.attackMove(e, t.x, t.y)
      else if (e.type === "barracks" && (e.queue?.length ?? 0) === 0) cmd.produce(e, "soldier")
    }
  }
}

/** 跑一局，记下每个座位每次调用时看到的实体 id（按 tick） */
function record(rules: Ruleset, n: number, teams: number[] | undefined, target: (v: View) => { x: number; y: number }) {
  const seen: Map<number, Set<number>>[] = Array.from({ length: n }, () => new Map())
  const bots = Array.from({ length: n }, (_, p) => ({
    name: `p${p}`,
    file: "",
    runner: fnBot((v, cmd) => {
      seen[p].set(v.tick, new Set(v.entities.map((e) => e.id)))
      charger(target)(v, cmd)
    }),
  }))
  const replay = runMatch({ ruleset: { ...rules, maxTicks: 1500 }, seed: 5, teams, bots })
  return { replay: JSON.parse(JSON.stringify(replay)) as Replay, seen }
}

function compare(replay: Replay, seen: Map<number, Set<number>>[]) {
  assert.ok(Vision.supported(replay))
  const model = new ReplayModel(replay)
  const vision = new Vision(replay)
  let enemiesSeen = 0
  let checked = 0
  for (let p = 0; p < seen.length; p++) {
    const team = vision.teamOf(p)
    for (const [tick, ids] of seen[p]) {
      const state = model.stateAt(tick)
      vision.compute(state, team)
      const mine = new Set([...state.ents.values()].filter((e) => vision.visible(e, team)).map((e) => e.id))
      assert.deepEqual([...mine].sort(), [...ids].sort(), `P${p} 第 ${tick} tick`)
      enemiesSeen += [...state.ents.values()].filter((e) => mine.has(e.id) && e.owner >= 0 && vision.teamOf(e.owner) !== team).length
      checked++
    }
  }
  assert.ok(checked > 100)
  assert.ok(enemiesSeen > 0, "对局里应该有看见敌人的时候")
}

test("回放视角：两人局，播放器算出的可见实体和 bot 看到的一样", () => {
  const { replay, seen } = record(annihilation, 2, undefined, (v) => (v.objectives as { enemyBases: { x: number; y: number }[] }).enemyBases[0])
  compare(replay, seen)
})

test("回放视角：2v2 分队，盟友共享视野", () => {
  const { replay, seen } = record(melee, 4, [0, 0, 1, 1], () => ({ x: 32, y: 32 }))
  compare(replay, seen)
})
