// 兵种克制（D-166）：克制歼灭、克制拓荒共用的三种兵。枪兵克骑兵、骑兵克弓兵、弓兵克枪兵，
// 克制靠 attack.vs（打被克的兵伤害乘倍数）。数值实验（歼灭基准 bot 改出纯兵种互打，每组 20 局）：
// 三组克制都是 20:0；三兵种混编对任何纯兵种 20:0；两兵种混编之间也成环：枪骑 > 骑弓 > 枪弓 > 枪骑
import type { TypeSpec } from "../../src/core/types.ts"

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

/** 把标准单位表里的战士、弓手换成三种克制兵，兵营改成出这三种 */
export function withCounters(types: Record<string, TypeSpec>): Record<string, TypeSpec> {
  // 三种兵放在原来战士的位置（单位表、图例按这个顺序列）
  const out: Record<string, TypeSpec> = {}
  for (const [k, v] of Object.entries(types)) {
    if (k === "soldier") Object.assign(out, counterUnits())
    else if (k !== "archer") out[k] = v
  }
  out.barracks = { ...out.barracks, produces: ["spearman", "cavalry", "archer"] }
  return out
}
