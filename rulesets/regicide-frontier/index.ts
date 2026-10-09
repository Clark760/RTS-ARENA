// 弑君拓荒（D-187）：拓荒的地图、建造和击杀价值，开局每家送 1 个领主；主基地被拆或领主阵亡就输
// 地图、开局和单位在 ../common/frontier.ts，领主、点金和胜负在 ../common/regicide.ts
import type { Ruleset } from "../../src/core/types.ts"
import { STANDARD_TERRAIN } from "../common/standard.ts"
import { enemyBasesOf, FRONTIER_H, FRONTIER_W, frontierSetup, frontierTimeUp, frontierTypes, scoreKills } from "../common/frontier.ts"
import { regicideCast, regicideResult, spawnLords, withLord } from "../common/regicide.ts"
import type { Objectives } from "./objectives.ts"

const types = withLord(frontierTypes(), ["soldier", "archer"])

const ruleset: Ruleset = {
  id: "regicide-frontier",
  name: "弑君拓荒",
  summary: "开局没有兵营要自己建，送一个领主（光环给兵加攻防、能造金矿），主基地被拆或领主阵亡就输",
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
    spawnLords(ctx, FRONTIER_W, FRONTIER_H, types)
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

  onCast: regicideCast,
  result: regicideResult,
  timeUp: frontierTimeUp,
}

export default ruleset
