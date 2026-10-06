// 几个规则包共用的单位、地形和地图工具。规则包可以复制一份再改数值。
import type { SetupContext, TerrainSpec, TypeSpec } from "../../src/core/types.ts"

export const STANDARD_TERRAIN: Record<string, TerrainSpec> = {
  ".": { walkable: true, color: "#2f3b2b" },
  "#": { walkable: false, color: "#5b5348" },
  "~": { walkable: false, color: "#22405c" },
}

/** 每次返回新对象，规则包可以放心改 */
export function standardTypes(): Record<string, TypeSpec> {
  return {
    base: {
      kind: "building",
      w: 3,
      h: 3,
      maxHp: 1500,
      sight: 7,
      produces: ["worker"],
      dropOff: true,
      look: { shape: "square", label: "基" },
    },
    barracks: {
      kind: "building",
      w: 2,
      h: 2,
      maxHp: 800,
      sight: 5,
      produces: ["soldier", "archer"],
      look: { shape: "square", label: "兵" },
    },
    worker: {
      kind: "unit",
      maxHp: 40,
      cost: { gold: 50 },
      buildTicks: 50,
      moveTicks: 3,
      sight: 5,
      attack: { damage: 3, range: 1, cooldown: 10 },
      gather: { amount: 1, ticks: 5, capacity: 5 },
      look: { shape: "circle", label: "工" },
    },
    soldier: {
      kind: "unit",
      maxHp: 120,
      cost: { gold: 75 },
      buildTicks: 60,
      moveTicks: 3,
      sight: 5,
      attack: { damage: 10, range: 1, cooldown: 8 },
      look: { shape: "diamond", label: "战" },
    },
    // 弓手和战士输出（每 tick 1.25）、造兵时间相同，血少一半、贵 5 金，换来 4 格射程：
    // 纯弓手打不过纯战士（要有前排），战士在前、弓手在后的混编比纯战士强（doc/设计.md「单位数值」有实验数据）
    archer: {
      kind: "unit",
      maxHp: 60,
      cost: { gold: 80 },
      buildTicks: 60,
      moveTicks: 3,
      sight: 7,
      attack: { damage: 10, range: 4, cooldown: 8 },
      look: { shape: "triangle", label: "弓" },
    },
    goldmine: {
      kind: "resource",
      resource: "gold",
      amount: 400,
      look: { shape: "hex", color: "#e0b53a" },
    },
  }
}

/** 两人地图的中心对称点：(x, y) 处 w×h 的东西在对面的位置 */
export function mirror(width: number, height: number, x: number, y: number, w = 1, h = 1): { x: number; y: number } {
  return { x: width - x - w, y: height - y - h }
}

export interface Feature {
  ch: string
  x: number
  y: number
  w: number
  h: number
}

/** 先铺满 fill，再画 features，每个 feature 同时画到中心对称的位置 */
export function symmetricTerrain(width: number, height: number, fill: string, features: Feature[]): string[] {
  const g: string[][] = Array.from({ length: height }, () => Array<string>(width).fill(fill))
  const paint = (f: Feature) => {
    for (let y = f.y; y < f.y + f.h; y++) for (let x = f.x; x < f.x + f.w; x++) if (g[y]?.[x] !== undefined) g[y][x] = f.ch
  }
  for (const f of features) {
    paint(f)
    paint({ ...f, ...mirror(width, height, f.x, f.y, f.w, f.h) })
  }
  return g.map((r) => r.join(""))
}

/** 给玩家 0 放一组实体，玩家 1 放在中心对称处；owner 为 -1 的放两份中立 */
export function spawnMirrored(
  ctx: SetupContext,
  width: number,
  height: number,
  types: Record<string, TypeSpec>,
  items: { type: string; owner: 0 | -1; x: number; y: number; amount?: number }[],
): void {
  for (const it of items) {
    const spec = types[it.type]
    ctx.spawn(it.type, it.owner, it.x, it.y, { amount: it.amount })
    const m = mirror(width, height, it.x, it.y, spec.w ?? 1, spec.h ?? 1)
    ctx.spawn(it.type, it.owner === 0 ? 1 : -1, m.x, m.y, { amount: it.amount })
  }
}

/** 标准开局（玩家 0 在左上，玩家 1 在中心对称处）：主基地、兵营、4 个工人、4 个家门口金矿。返回玩家 0 主基地左上角 */
export function standardStart(
  ctx: SetupContext,
  width: number,
  height: number,
  types: Record<string, TypeSpec>,
): { x: number; y: number } {
  spawnMirrored(ctx, width, height, types, [
    { type: "base", owner: 0, x: 3, y: 3 },
    { type: "barracks", owner: 0, x: 9, y: 6 },
    { type: "worker", owner: 0, x: 6, y: 3 },
    { type: "worker", owner: 0, x: 6, y: 4 },
    { type: "worker", owner: 0, x: 6, y: 5 },
    { type: "worker", owner: 0, x: 3, y: 6 },
    { type: "goldmine", owner: -1, x: 1, y: 9 },
    { type: "goldmine", owner: -1, x: 3, y: 9 },
    { type: "goldmine", owner: -1, x: 5, y: 9 },
    { type: "goldmine", owner: -1, x: 8, y: 1 },
  ])
  return { x: 3, y: 3 }
}

/** 各玩家主基地的起始位置（两人对称图） */
export function baseStarts(width: number, height: number): { owner: number; x: number; y: number }[] {
  return [{ owner: 0, x: 3, y: 3 }, { owner: 1, ...mirror(width, height, 3, 3, 3, 3) }]
}
