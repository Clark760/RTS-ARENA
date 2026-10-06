// 采集竞速：比谁先累计交货 1500 金。建筑都打不掉，但可以出兵去杀对方的工人
import type { Ruleset } from "../../src/core/types.ts"
import { standardStart, STANDARD_TERRAIN, standardTypes, symmetricTerrain, spawnMirrored } from "../common/standard.ts"
import type { Objectives } from "./objectives.ts"

const W = 40
const H = 28
const TARGET = 1500
const types = standardTypes()
// 建筑无敌（maxHp 0 表示不能被攻击）
types.base.maxHp = 0
types.barracks.maxHp = 0

const ruleset: Ruleset = {
  id: "harvest",
  name: "采集竞速",
  players: { min: 2, max: 2 },
  maxTicks: 4000,
  tickRate: 10,
  decisionInterval: 5,
  fuel: 100,
  unitCap: 40,
  fog: true,
  resources: ["gold"],
  terrain: STANDARD_TERRAIN,
  types,

  setup(ctx) {
    ctx.setTerrain(
      symmetricTerrain(W, H, ".", [
        { ch: "#", x: 13, y: 0, w: 2, h: 6 },
        { ch: "#", x: 0, y: 13, w: 6, h: 2 },
        { ch: "~", x: 18, y: 12, w: 4, h: 4 },
      ]),
    )
    standardStart(ctx, W, H, types)
    spawnMirrored(ctx, W, H, types, [
      { type: "goldmine", owner: -1, x: 15, y: 8, amount: 500 },
      { type: "goldmine", owner: -1, x: 17, y: 8, amount: 500 },
      { type: "goldmine", owner: -1, x: 8, y: 16, amount: 500 },
    ])
    for (let p = 0; p < ctx.playerCount; p++) ctx.setResources(p, { gold: 200 })
  },

  onTick(ctx) {
    for (const ev of ctx.events) if (ev.kind === "deposit") ctx.addScore(ev.player, ev.amount)
    ctx.setStatus(`累计交货 ${ctx.players.map((p) => p.score).join(" : ")} / ${TARGET}`)
  },

  objectives(ctx): Objectives {
    return { target: TARGET, gathered: ctx.players.map((p) => p.score) }
  },

  result(ctx) {
    const [a, b] = ctx.players
    if (a.score < TARGET && b.score < TARGET) return null
    if (a.score === b.score) return { winner: null, reason: `同时达到 ${TARGET}，交货量相同` }
    return { winner: a.score > b.score ? 0 : 1, reason: `先累计交货 ${TARGET} 金（${a.score} : ${b.score}）` }
  },

  timeUp(ctx) {
    const [a, b] = ctx.players
    if (a.score === b.score) return { winner: null, reason: `时间到，交货量相同 ${a.score}` }
    return { winner: a.score > b.score ? 0 : 1, reason: `时间到，累计交货 ${a.score} : ${b.score}` }
  },
}

export default ruleset
