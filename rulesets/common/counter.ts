// 兵种克制（D-166）：克制歼灭、克制拓荒共用的三种兵。枪兵克骑兵、骑兵克弓兵、弓兵克枪兵，
// 克制靠 attack.vs（打被克的兵伤害乘倍数）。数值实验（歼灭基准 bot 改出纯兵种互打，每组 20 局）：
// 三组克制都是 20:0；三兵种混编对任何纯兵种 20:0；两兵种混编之间也成环：枪骑 > 骑弓 > 枪弓 > 枪骑。
// 另外开局每家送 1 个侦察兵（D-167）
import type { SetupContext, TypeSpec } from "../../src/core/types.ts"
import { spawnMirrored } from "./standard.ts"

/** 三种兵（每次返回新对象，可以放心改） */
export function counterUnits(): Record<string, TypeSpec> {
  return {
    // 枪兵：便宜、皮实，打骑兵伤害 ×3；打别的兵只是普通近战
    spearman: {
      kind: "unit",
      maxHp: 130,
      cost: { gold: 70 },
      buildTicks: 60,
      moveTicks: 3,
      sight: 5,
      attack: { damage: 9, range: 1, cooldown: 8, vs: { cavalry: 3 } },
      look: { shape: "diamond", label: "枪", name: "枪兵" },
    },
    // 骑兵：贵、血厚、走得快（走一格 2 tick，别的兵 3 tick），打弓兵伤害 ×2.5
    cavalry: {
      kind: "unit",
      maxHp: 170,
      cost: { gold: 100 },
      buildTicks: 70,
      moveTicks: 2,
      sight: 6,
      attack: { damage: 12, range: 1, cooldown: 8, vs: { archer: 2.5 } },
      look: { shape: "circle", label: "骑", name: "骑兵" },
    },
    // 弓兵：血薄、射程 4，打枪兵伤害 ×2.5
    archer: {
      kind: "unit",
      maxHp: 60,
      cost: { gold: 75 },
      buildTicks: 60,
      moveTicks: 3,
      sight: 7,
      attack: { damage: 9, range: 4, cooldown: 8, vs: { spearman: 2.5 } },
      look: { shape: "triangle", label: "弓", name: "弓兵" },
    },
  }
}

/**
 * 侦察兵（D-167，用户定）：开局每家送 1 个，造不出来，丢了就没有了。走一格 1 tick（全场最快）、视野 8（比箭塔射程远），
 * 生命和攻击都比工人低（工人 40 血、3 伤）。克制看情报，派工人去侦察要少一份采矿，侦察兵就是专门干这个的
 */
export function scoutType(): TypeSpec {
  return {
    kind: "unit",
    maxHp: 25,
    moveTicks: 1,
    sight: 8,
    attack: { damage: 1, range: 1, cooldown: 10 },
    look: { shape: "circle", label: "侦", name: "侦察兵" },
  }
}

/** 把标准单位表里的战士、弓手换成三种克制兵加侦察兵，兵营改成出三种克制兵 */
export function withCounters(types: Record<string, TypeSpec>): Record<string, TypeSpec> {
  // 三种兵放在原来战士的位置（单位表、图例按这个顺序列）
  const out: Record<string, TypeSpec> = {}
  for (const [k, v] of Object.entries(types)) {
    if (k === "soldier") Object.assign(out, counterUnits(), { scout: scoutType() })
    else if (k !== "archer") out[k] = v
  }
  out.barracks = { ...out.barracks, produces: ["spearman", "cavalry", "archer"] }
  return out
}

/** 开局每家 1 个侦察兵：左上那家放在家里的角落 (1, 1)，右下那家放在中心对称的位置（歼灭、拓荒的开局这一格都空着；放在主基地前面会挡住建兵营的位置） */
export function spawnScouts(ctx: SetupContext, width: number, height: number, types: Record<string, TypeSpec>): void {
  spawnMirrored(ctx, width, height, types, [{ type: "scout", owner: 0, x: 1, y: 1 }])
}
