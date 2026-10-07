// 几个规则包共用的单位、地形和地图工具（含按种子生成对称随机地图）。规则包可以复制一份再改数值。
import type { Rng, SetupContext, TerrainSpec, TypeSpec } from "../../src/core/types.ts"

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

// ---------- 四角地图（多方混战用） ----------

/** 正方形地图里把矩形绕中心顺时针转 90° */
export function rotate90(size: number, r: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
  return { x: size - r.y - r.h, y: r.x, w: r.h, h: r.w }
}

/** 转 k 次 90° */
export function rotateK(size: number, r: { x: number; y: number; w: number; h: number }, k: number) {
  let out = r
  for (let i = 0; i < k % 4; i++) out = rotate90(size, out)
  return out
}

/** 先铺满 fill，再画 features，每个 feature 同时画到另外三个旋转位置（四重旋转对称） */
export function rotationalTerrain(size: number, fill: string, features: Feature[]): string[] {
  const g: string[][] = Array.from({ length: size }, () => Array<string>(size).fill(fill))
  for (const f of features)
    for (let k = 0; k < 4; k++) {
      const r = rotateK(size, f, k)
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) g[y][x] = f.ch
    }
  return g.map((row) => row.join(""))
}

/** 各人数下玩家坐哪个角（转几次 90°）：两人坐对角，三人空一个角，四人坐满 */
export function cornersFor(players: number): number[] {
  return players === 2 ? [0, 2] : [0, 1, 2, 3].slice(0, players)
}

// ---------- 随机地图（按种子生成；两人图中心对称、四人图四重旋转对称，每家看到的完全一样） ----------

/** 矩形（左上角和宽高） */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}
export interface Cell {
  x: number
  y: number
}
/** point：两人图的中心对称（对面的东西在 mirror 的位置）；rot4：正方形图绕中心转 90° 的四重对称 */
export type Symmetry = "point" | "rot4"

/** 一个矩形（对称前那一份）在各个对称位置的样子，第 0 个是它自己 */
export function symmetricImages(sym: Symmetry, width: number, height: number, b: Box): Box[] {
  if (sym === "point") return [b, { ...mirror(width, height, b.x, b.y, b.w, b.h), w: b.w, h: b.h }]
  return [0, 1, 2, 3].map((k) => rotateK(width, b, k))
}

export interface RandomMapSpec {
  width: number
  height: number
  symmetry: Symmetry
  /** 底图：每行一个字符串，固定的地形（商路、高地、固定的墙……）已经画好 */
  base: string[]
  /** 地形表（判断哪些字符能走） */
  terrain: Record<string, TerrainSpec>
  /** 只在这种字符上放障碍和矿，默认 "." */
  fill?: string
  /** 开局就占着格子的东西（主基地、兵营、家门口的矿、固定的中立实体……，对称前一份）：校验时当成走不通，周围也不放障碍 */
  solid?: Box[]
  /** 不放障碍和矿的区域（对称前一份，自动加上对称位置）：家、控制点、商路两边…… */
  keepClear?: Box[]
  /** solid、keepClear 外面再空出几格，默认 1 */
  margin?: number
  /** 随机障碍：对称前那一份放几块；每块随机挑一种形状和一种地形字符（[字符, 权重]）；region 是左上角能落的范围 */
  obstacles: { count: [number, number]; shapes: { w: [number, number]; h: [number, number] }[]; chars: [string, number][]; region?: Box }
  /** 随机矿群（对称前那一份）：每组在 region 里挑一个锚点，矿放在锚点加 offsets 的位置，阵型不变 */
  mines?: { region: Box; offsets: Cell[] }[]
  /** 必须走得到的格子（对称前一份，自动加上对称位置）；第一个是起点，一般是自家门口 */
  connect: Cell[]
  /** 起点到其他点（含对称位置）和到每个矿旁边的最短路，不超过曼哈顿距离的几倍再加 6 格，默认 1.5 */
  detour?: number
  /** 能走的格子至少占几成，默认 0.75 */
  minOpen?: number
  /** 最多试几次，默认 200；都不合格返回 null，规则包用自己的经典布局 */
  tries?: number
}

export interface RandomMap {
  terrain: string[]
  /** 所有矿的位置（含对称位置）和属于第几组 */
  mines: { x: number; y: number; group: number }[]
}

const DX4 = [0, 1, 0, -1]
const DY4 = [-1, 0, 1, 0]

/** 四方向（和引擎寻路一样）的最短步数，走不到是 -1 */
function stepsFrom(width: number, height: number, pass: (i: number) => boolean, start: number): Int32Array {
  const d = new Int32Array(width * height).fill(-1)
  d[start] = 0
  const q = [start]
  for (let head = 0; head < q.length; head++) {
    const i = q[head]
    const x = i % width
    const y = (i - x) / width
    for (let k = 0; k < 4; k++) {
      const nx = x + DX4[k]
      const ny = y + DY4[k]
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
      const j = ny * width + nx
      if (d[j] >= 0 || !pass(j)) continue
      d[j] = d[i] + 1
      q.push(j)
    }
  }
  return d
}

/**
 * 按种子生成一张对称的随机地图：在底图的空地上随机放障碍和矿群，再检查——
 * 关键点和每个矿都走得到、绕路不超过 detour 倍、能走的格子够多。不合格就换一组重来（结果只取决于 rng，同一个种子永远一样）。
 * 对称保证每家看到的地图完全一样；矿和障碍都按对称位置成套放
 */
export function randomSymmetricMap(rng: Rng, spec: RandomMapSpec): RandomMap | null {
  const W = spec.width
  const H = spec.height
  if (spec.symmetry === "rot4" && W !== H) throw new Error("rot4 对称要正方形地图")
  const fill = spec.fill ?? "."
  const margin = spec.margin ?? 1
  const imgs = (b: Box) => symmetricImages(spec.symmetry, W, H, b)
  const cellImgs = (c: Cell) => imgs({ x: c.x, y: c.y, w: 1, h: 1 })
  const at = (x: number, y: number) => y * W + x
  const inMap = (b: Box) => b.x >= 0 && b.y >= 0 && b.x + b.w <= W && b.y + b.h <= H
  const each = (b: Box, f: (x: number, y: number) => void) => {
    for (let y = Math.max(0, b.y); y < Math.min(H, b.y + b.h); y++) for (let x = Math.max(0, b.x); x < Math.min(W, b.x + b.w); x++) f(x, y)
  }
  const grow = (b: Box, m: number): Box => ({ x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m })
  const pick = (r: [number, number]) => r[0] + rng.int(r[1] - r[0] + 1)
  const weightSum = spec.obstacles.chars.reduce((a, [, wt]) => a + wt, 0)
  const pickChar = () => {
    let t = rng.int(weightSum)
    for (const [ch, wt] of spec.obstacles.chars) {
      if (t < wt) return ch
      t -= wt
    }
    return spec.obstacles.chars[0][0]
  }
  const detour = spec.detour ?? 1.5
  for (let attempt = 0; attempt < (spec.tries ?? 200); attempt++) {
    const g = spec.base.map((row) => row.split(""))
    const solid = new Uint8Array(W * H)
    const reserved = new Uint8Array(W * H)
    for (const s of spec.solid ?? [])
      for (const b of imgs(s)) {
        each(b, (x, y) => (solid[at(x, y)] = 1))
        each(grow(b, margin), (x, y) => (reserved[at(x, y)] = 1))
      }
    for (const s of spec.keepClear ?? []) for (const b of imgs(s)) each(grow(b, margin), (x, y) => (reserved[at(x, y)] = 1))
    // 矿群：所有对称位置都要在空地上、不在保留区，不同对称位置的矿之间至少隔两格；放好后周围一圈不再放障碍
    const mines: { x: number; y: number; group: number }[] = []
    let minesOk = true
    for (const [gi, grp] of (spec.mines ?? []).entries()) {
      let placed: Cell[][] | null = null
      for (let t = 0; t < 80 && !placed; t++) {
        const ax = grp.region.x + rng.int(grp.region.w)
        const ay = grp.region.y + rng.int(grp.region.h)
        const copies = grp.offsets.map((o) => cellImgs({ x: ax + o.x, y: ay + o.y }))
        const cells = copies.flat()
        if (!cells.every((c) => inMap(c) && g[c.y][c.x] === fill && !reserved[at(c.x, c.y)])) continue
        const sym = imgs({ x: 0, y: 0, w: 1, h: 1 }).length
        let apart = true
        for (let a = 0; a < sym && apart; a++)
          for (let b = a + 1; b < sym && apart; b++)
            for (const ca of copies) for (const cb of copies) if (Math.max(Math.abs(ca[a].x - cb[b].x), Math.abs(ca[a].y - cb[b].y)) < 3) apart = false
        if (apart) placed = copies
      }
      if (!placed) {
        minesOk = false
        break
      }
      for (const copy of placed)
        for (const c of copy) {
          mines.push({ x: c.x, y: c.y, group: gi })
          solid[at(c.x, c.y)] = 1
          each(grow({ x: c.x, y: c.y, w: 1, h: 1 }, 1), (x, y) => (reserved[at(x, y)] = 1))
        }
    }
    if (!minesOk) continue
    // 障碍：成套画在空地上，不压保留区、不和已有的障碍重叠
    const reg = spec.obstacles.region ?? { x: 0, y: 0, w: W, h: H }
    const n = pick(spec.obstacles.count)
    for (let i = 0; i < n; i++)
      for (let t = 0; t < 40; t++) {
        const shape = spec.obstacles.shapes[rng.int(spec.obstacles.shapes.length)]
        const w = pick(shape.w)
        const h = pick(shape.h)
        const b = { x: reg.x + rng.int(Math.max(1, reg.w - w + 1)), y: reg.y + rng.int(Math.max(1, reg.h - h + 1)), w, h }
        const all = imgs(b)
        let fits = all.every(inMap)
        if (fits) for (const im of all) each(im, (x, y) => (fits &&= g[y][x] === fill && !reserved[at(x, y)]))
        if (!fits) continue
        const ch = pickChar()
        for (const im of all) each(im, (x, y) => (g[y][x] = ch))
        break
      }
    // 校验
    const pass = (i: number) => !solid[i] && spec.terrain[g[Math.floor(i / W)][i % W]]?.walkable === true
    let open = 0
    for (let i = 0; i < W * H; i++) if (pass(i)) open++
    if (open < (spec.minOpen ?? 0.75) * W * H) continue
    const s0 = spec.connect[0]
    if (!pass(at(s0.x, s0.y))) continue
    const d = stepsFrom(W, H, pass, at(s0.x, s0.y))
    const near = (c: Cell) => {
      const v = d[at(c.x, c.y)]
      return v >= 0 && v <= detour * (Math.abs(c.x - s0.x) + Math.abs(c.y - s0.y)) + 6
    }
    if (!spec.connect.flatMap(cellImgs).every((c) => inMap(c) && near(c))) continue
    const mineReachable = (m: Cell) =>
      DX4.some((dx, k) => {
        const x = m.x + dx
        const y = m.y + DY4[k]
        return x >= 0 && y >= 0 && x < W && y < H && near({ x, y })
      })
    if (!mines.every(mineReachable)) continue
    return { terrain: g.map((row) => row.join("")), mines }
  }
  return null
}

/** 标准的随机障碍形状：横墙、竖墙、石块 */
export const STANDARD_SHAPES: { w: [number, number]; h: [number, number] }[] = [
  { w: [3, 7], h: [1, 2] },
  { w: [1, 2], h: [3, 7] },
  { w: [2, 4], h: [2, 3] },
]
/** 标准的随机障碍地形：石头多、水少 */
export const STANDARD_OBSTACLE_CHARS: [string, number][] = [
  ["#", 3],
  ["~", 1],
]
/** standardStart 摆的家（左上角那家）：主基地、兵营、开局工人、家门口的 4 个矿都在这块里 */
export const STANDARD_HOME: Box = { x: 0, y: 0, w: 12, h: 12 }
