// 流场寻路：对不会动的目标（格子、建筑、资源点）从目标往外做一次 BFS，得到每格到目标的步数，
// 所有去同一目标的单位共用；单位每步走向步数更小的相邻格。建筑、资源点增减时整体作废重算。
import type { Rect } from "./types.ts"
import { rectDist, type World } from "./world.ts"

/** 到不了 */
export const UNREACHABLE = -1
/** 流场缓存总共最多占多少字节（地图越小能存的张数越多），张数限制在 64～1024 */
const CACHE_BYTES = 32 * 1024 * 1024

const DX = [0, 1, 0, -1]
const DY = [-1, 0, 1, 0]

interface Entry {
  version: number
  field: Int32Array
}

export class FlowCache {
  private w: World
  private cache = new Map<string, Entry>()
  private queue: Int32Array
  private maxFields: number
  /** 统计：重算了多少张 */
  built = 0

  constructor(w: World) {
    this.w = w
    this.queue = new Int32Array(w.width * w.height)
    this.maxFields = Math.max(64, Math.min(1024, Math.floor(CACHE_BYTES / (w.width * w.height * 4))))
  }

  private get(key: string, build: (field: Int32Array) => void): Int32Array {
    const hit = this.cache.get(key)
    if (hit && hit.version === this.w.staticVersion) {
      // 刷新到末尾，淘汰时先淘汰最久没用的
      this.cache.delete(key)
      this.cache.set(key, hit)
      return hit.field
    }
    const field = hit?.field ?? new Int32Array(this.w.width * this.w.height)
    field.fill(UNREACHABLE)
    build(field)
    this.built++
    this.cache.delete(key)
    this.cache.set(key, { version: this.w.staticVersion, field })
    if (this.cache.size > this.maxFields) this.cache.delete(this.cache.keys().next().value!)
    return field
  }

  /**
   * 去某一格。目标格本身不可走（在建筑、岩石里）时，先把它所在的那片障碍灌满，
   * 再从障碍边上往外扩：单位会走到离目标最近的可站位置。
   */
  toTile(x: number, y: number): Int32Array {
    return this.get(`t${x},${y}`, (field) => {
      const w = this.w
      const W = w.width
      const goal = y * W + x
      field[goal] = 0
      this.bfs(field, [goal], w.staticFree(goal))
    })
  }

  /** 走到离矩形 rect 距离不超过 range 的地方（用于不会动的建筑、资源点） */
  toRect(id: number, r: Rect, range: number): Int32Array {
    return this.get(`r${id}:${range}`, (field) => {
      const w = this.w
      const W = w.width
      const seeds: number[] = []
      const y0 = Math.max(0, r.y - range)
      const y1 = Math.min(w.height - 1, r.y + r.h - 1 + range)
      const x0 = Math.max(0, r.x - range)
      const x1 = Math.min(W - 1, r.x + r.w - 1 + range)
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const i = y * W + x
          if (w.staticFree(i) && rectDist({ x, y, w: 1, h: 1 }, r) <= range) {
            field[i] = 0
            seeds.push(i)
          }
        }
      this.bfs(field, seeds, true)
    })
  }

  /** 多源 BFS。seedsWalkable 为 false 时种子在障碍里：障碍格只能从障碍格扩展过来 */
  private bfs(field: Int32Array, seeds: number[], seedsWalkable: boolean): void {
    const w = this.w
    const W = w.width
    const H = w.height
    const q = this.queue
    let head = 0
    let tail = 0
    for (const s of seeds) q[tail++] = s
    while (head < tail) {
      const cur = q[head++]
      const curFree = w.staticFree(cur)
      const cx = cur % W
      const cy = (cur - cx) / W
      const nd = field[cur] + 1
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX[d]
        const ny = cy + DY[d]
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        const ni = ny * W + nx
        if (field[ni] !== UNREACHABLE) continue
        const nFree = w.staticFree(ni)
        // 可走格不能扩进障碍；障碍格只在"种子所在的那片障碍"里互相扩
        if (!nFree && (curFree || seedsWalkable)) continue
        field[ni] = nd
        q[tail++] = ni
      }
    }
  }
}

/**
 * 按流场选下一步：相邻格里步数更小、地形可走的。一样好的随机挑一个（固定方向顺序会让两边走出不对称的路线）。
 * - next：能走的最好一格（都被单位占着时为 -1）
 * - blocked：被单位占着的最好一格（用来和挡路的自己人换位；没有为 -1）
 * - closer：是否存在更近的可走格（没有说明已经尽量靠近了）
 */
export function flowStep(w: World, field: Int32Array, from: number): { next: number; blocked: number; closer: boolean } {
  const W = w.width
  const cx = from % W
  const cy = (from - cx) / W
  const cur = field[from]
  let freeD = Number.MAX_SAFE_INTEGER
  let busyD = Number.MAX_SAFE_INTEGER
  let nFree = 0
  let nBusy = 0
  for (let d = 0; d < 4; d++) {
    const nx = cx + DX[d]
    const ny = cy + DY[d]
    if (nx < 0 || ny < 0 || nx >= W || ny >= w.height) continue
    const ni = ny * W + nx
    const nd = field[ni]
    if (nd === UNREACHABLE || nd >= cur || !w.staticFree(ni)) continue
    if (w.unitOcc[ni] === 0) {
      if (nd < freeD) {
        freeD = nd
        nFree = 0
      }
      if (nd === freeD) free[nFree++] = ni
    } else {
      if (nd < busyD) {
        busyD = nd
        nBusy = 0
      }
      if (nd === busyD) busy[nBusy++] = ni
    }
  }
  const pick = (arr: Int32Array, n: number) => (n === 0 ? -1 : n === 1 ? arr[0] : arr[w.simRng.int(n)])
  return { next: pick(free, nFree), blocked: pick(busy, nBusy), closer: nFree + nBusy > 0 }
}

const free = new Int32Array(4)
const busy = new Int32Array(4)
