// 克制拓荒（D-166）：拓荒的地图、建造和胜负，兵营出枪兵、骑兵、弓兵三种兵，枪兵克骑兵、骑兵克弓兵、弓兵克枪兵；开局每家送 1 个侦察兵（D-167）
// 地图、开局、单位和胜负判定在 ../common/frontier.ts，三种兵在 ../common/counter.ts
import type { Ruleset } from "../../src/core/types.ts"
import { STANDARD_TERRAIN } from "../common/standard.ts"
import { enemyBasesOf, FRONTIER_H, FRONTIER_W, frontierResult, frontierSetup, frontierTimeUp, frontierTypes, scoreKills } from "../common/frontier.ts"
import { spawnScouts, withCounters } from "../common/counter.ts"
import type { Objectives } from "./objectives.ts"

const types = withCounters(frontierTypes())

const ruleset: Ruleset = {
  id: "counter-frontier",
  name: "克制拓荒",
  summary: "工人自己建兵营、箭塔、仓库，枪兵克骑兵、骑兵克弓兵、弓兵克枪兵，摧毁对方主基地获胜",
  players: { min: 2, max: 2 },
  maxTicks: 9000,
  tickRate: 10,
  decisionInterval: 5,
  fuel: 130,
  unitCap: 60,
  fog: true,
  resources: ["gold"],
  terrain: STANDARD_TERRAIN,
  types,

  setup(ctx) {
    frontierSetup(ctx, types)
    spawnScouts(ctx, FRONTIER_W, FRONTIER_H, types)
  },

  onTick(ctx) {
    scoreKills(ctx, types)
    ctx.setStatus(`击杀价值 ${ctx.players.map((p) => p.score).join(" : ")}`)
  },

  objectives(ctx, player): Objectives {
    return {
      enemyBases: enemyBasesOf(player),
      killValue: ctx.players.map((p) => p.score),
    }
  },

  result: frontierResult,
  timeUp: frontierTimeUp,
}

export default ruleset
