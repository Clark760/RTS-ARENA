// 弑君歼灭（D-187）：歼灭的地图、兵种和击杀价值，开局每家送 1 个领主；主基地被拆或领主阵亡就输
// 地图和开局在 ../common/annihilation.ts，领主、击退和胜负在 ../common/regicide.ts（D-197：歼灭的领主不点金，放击退）
import type { Ruleset } from "../../src/core/types.ts"
import { STANDARD_TERRAIN, standardTypes } from "../common/standard.ts"
import { ANNIHILATION_H, ANNIHILATION_W, annihilationEnemyBases, annihilationSetup, annihilationTimeUp, scoreAnnihilationKills } from "../common/annihilation.ts"
import { regicideCast, regicideResult, regicideStats, spawnLords, withLord } from "../common/regicide.ts"
import { campInfo, creepBounty, creepTick, creepTimeUp, creepType, setupCamps } from "../common/creeps.ts"
import { setupTreasure, treasureInfo, treasureStats, treasureTick, treasureType } from "../common/treasure.ts"
import type { Objectives } from "./objectives.ts"

const types = withLord(standardTypes(), ["soldier", "archer"], "repel")
types.creep = creepType()
// D-202（用户：希望大模型更灵活地去打仗而不是龟缩）：每 900 tick 在地图正中刷一个宝箱，打掉得 600 金
types.treasure = treasureType()
// D-196（用户：钱没处花，又不想加建造把歼灭弄复杂）：兵营排进队列的 5 个同时造，出兵快慢看钱
types.barracks.parallel = 5
// D-198（用户：想让两边打得更焦灼、时间更长）：战士 120 → 180 血（实测势均力敌的团战从 136 tick 打到 228 tick）；
// 主基地像拓荒的箭塔一样能打射程 5 内的敌人（一波推平变难）；领主 500 → 800 血（不那么容易被秒）
types.soldier.maxHp = 180
types.base.attack = { damage: 12, range: 5, cooldown: 10 }
// D-199（用户）：主基地 1500 → 3000 血（D-198 后拆家结束的局从 35 涨到 48：领主难杀就去拆家，180 血的战士扛得住主基地的炮火）
types.base.maxHp = 3000
// D-200（用户）：领主 800 → 1500 血（主基地改 3000 以后杀领主成了最主要的结束方式）
types.lord.maxHp = 1500

const ruleset: Ruleset = {
  id: "regicide-annihilation",
  name: "弑君歼灭",
  summary: "两人对战，开局送一个领主（光环加攻防、能把周围的敌人击退），地图上有刷新的野怪赏金和中央宝箱，主基地被拆或领主阵亡就输",
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
    // D-193（用户）：赏金 150，死了的野怪每 900 tick 定时补满（拓荒是 100、营地清空后才刷新）
    setupCamps(ctx, ANNIHILATION_W, ANNIHILATION_H, { x: 20, y: 19 }, { x: 14, y: 25 }, { bounty: 150, respawn: "periodic" })
    setupTreasure(ctx, ANNIHILATION_W, ANNIHILATION_H)
  },

  onTick(ctx) {
    scoreAnnihilationKills(ctx, types)
    creepTick(ctx)
    treasureTick(ctx)
  },

  objectives(ctx, player): Objectives {
    return {
      enemyBases: annihilationEnemyBases(player),
      killValue: ctx.players.map((p) => p.score),
      creepCamps: campInfo(),
      creepBounty: creepBounty(ctx.playerCount),
      treasure: treasureInfo(ctx),
    }
  },

  onCast: regicideCast,
  result(ctx) {
    const r = regicideResult(ctx)
    return r && { ...r, stats: { ...r.stats, ...treasureStats(ctx.playerCount) } }
  },
  timeUp: (ctx) => ({ ...creepTimeUp(ctx, annihilationTimeUp(ctx)), stats: { ...regicideStats(ctx.playerCount), ...treasureStats(ctx.playerCount) } }),
}

export default ruleset
