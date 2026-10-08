// 克制歼灭（D-166）：歼灭的地图和胜负，兵营出枪兵、骑兵、弓兵三种兵，枪兵克骑兵、骑兵克弓兵、弓兵克枪兵；开局每家送 1 个侦察兵（D-167）
// 地图、开局和胜负判定在 ../common/annihilation.ts，三种兵在 ../common/counter.ts
import type { Ruleset } from "../../src/core/types.ts"
import { STANDARD_TERRAIN, standardTypes } from "../common/standard.ts"
import { ANNIHILATION_H, ANNIHILATION_W, annihilationEnemyBases, annihilationResult, annihilationSetup, annihilationTimeUp, scoreAnnihilationKills } from "../common/annihilation.ts"
import { spawnScouts, withCounters } from "../common/counter.ts"
import type { Objectives } from "./objectives.ts"

const types = withCounters(standardTypes())

const ruleset: Ruleset = {
  id: "counter-annihilation",
  name: "克制歼灭",
  summary: "两人对战，枪兵克骑兵、骑兵克弓兵、弓兵克枪兵，看对手出什么兵再出克它的，摧毁对方主基地获胜",
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
    spawnScouts(ctx, ANNIHILATION_W, ANNIHILATION_H, types)
  },

  onTick(ctx) {
    scoreAnnihilationKills(ctx, types)
  },

  objectives(ctx, player): Objectives {
    return {
      enemyBases: annihilationEnemyBases(player),
      killValue: ctx.players.map((p) => p.score),
    }
  },

  result: annihilationResult,
  timeUp: annihilationTimeUp,
}

export default ruleset
