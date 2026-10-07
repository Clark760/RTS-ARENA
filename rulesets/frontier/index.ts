// 拓荒：开局只有主基地和工人，工人自己建兵营、箭塔、仓库；摧毁对方主基地获胜，到时间上限比击杀价值
// 地图、开局、单位和胜负判定在 ../common/frontier.ts（科技规则包也用）
import type { Ruleset } from "../../src/core/types.ts"
import { STANDARD_TERRAIN } from "../common/standard.ts"
import { enemyBasesOf, frontierResult, frontierSetup, frontierTimeUp, frontierTypes, scoreKills } from "../common/frontier.ts"
import type { Objectives } from "./objectives.ts"

const types = frontierTypes()

const ruleset: Ruleset = {
  id: "frontier",
  name: "拓荒",
  summary: "开局没有兵营，工人自己建兵营、箭塔、仓库，摧毁对方主基地获胜",
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
