// 弑君歼灭（D-187）：歼灭的地图、兵种和击杀价值，开局每家送 1 个领主；主基地被拆或领主阵亡就输
// 地图和开局在 ../common/annihilation.ts，领主、点金和胜负在 ../common/regicide.ts
import type { Ruleset } from "../../src/core/types.ts"
import { STANDARD_TERRAIN, standardTypes } from "../common/standard.ts"
import { ANNIHILATION_H, ANNIHILATION_W, annihilationEnemyBases, annihilationSetup, annihilationTimeUp, scoreAnnihilationKills } from "../common/annihilation.ts"
import { regicideCast, regicideResult, spawnLords, withLord } from "../common/regicide.ts"
import { campInfo, creepStats, creepTick, creepType, setupCamps } from "../common/creeps.ts"
import type { Objectives } from "./objectives.ts"

const types = withLord(standardTypes(), ["soldier", "archer"])
types.creep = creepType()

const ruleset: Ruleset = {
  id: "regicide-annihilation",
  name: "弑君歼灭",
  summary: "两人对战，开局送一个领主（光环加攻防、能造金矿），地图上有刷新的野怪赏金，主基地被拆或领主阵亡就输",
  players: { min: 2, max: 2 },
  maxTicks: 6000,
  tickRate: 10,
  decisionInterval: 5,
  fuel: 100,
  unitCap: 60,
  fog: true,
  resources: ["gold"],
  terrain: STANDARD_TERRAIN,
  types,

  setup(ctx) {
    annihilationSetup(ctx, types)
    spawnLords(ctx, ANNIHILATION_W, ANNIHILATION_H, types)
    // 野怪营地（D-189）：内圈、外圈各一对，都在离两家主基地一样远的斜线上
    setupCamps(ctx, ANNIHILATION_W, ANNIHILATION_H, { x: 20, y: 19 }, { x: 14, y: 25 })
  },

  onTick(ctx) {
    scoreAnnihilationKills(ctx, types)
    creepTick(ctx)
  },

  objectives(ctx, player): Objectives {
    return {
      enemyBases: annihilationEnemyBases(player),
      killValue: ctx.players.map((p) => p.score),
      creepCamps: campInfo(),
    }
  },

  onCast: regicideCast,
  result: regicideResult,
  timeUp: (ctx) => ({ ...annihilationTimeUp(ctx), stats: creepStats(ctx.playerCount) }),
}

export default ruleset
