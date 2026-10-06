// A* 寻路（四方向，每步代价 1）。目标用启发函数表示：h = 0 即到达。
// 找不到路或超出扩展上限时，返回到"离目标最近的点"的路径。

export interface PathQuery {
  sx: number
  sy: number
  /** 到目标的距离下界，0 表示这一格就是目标 */
  h(x: number, y: number): number
  /** 这一格能不能走（不含起点） */
  passable(i: number): boolean
  maxExpand: number
  /** 同样好的格子之间的先后用它打乱（不填则按下标，偏向左上） */
  salt?: number
}

const DX = [0, 1, 0, -1]
const DY = [-1, 0, 1, 0]

export class PathFinder {
  private g: Int32Array
  private parent: Int32Array
  private seen: Uint32Array
  private closed: Uint32Array
  private stamp = 0
  // 二叉堆：存格子下标，按 (f, h, 下标) 排序，保证结果确定
  private heap: number[] = []
  private f: Int32Array
  private hv: Int32Array
  private salt = 0
  /** 统计：累计扩展的格子数 */
  expanded = 0

  private w: number
  private h: number

  constructor(w: number, h: number) {
    this.w = w
    this.h = h
    const n = w * h
    this.g = new Int32Array(n)
    this.parent = new Int32Array(n)
    this.seen = new Uint32Array(n)
    this.closed = new Uint32Array(n)
    this.f = new Int32Array(n)
    this.hv = new Int32Array(n)
  }

  /** 返回倒序路径（末尾是下一步，不含起点）；已在目标上返回空数组。reached 表示能否真正到达 */
  find(q: PathQuery): { path: number[]; reached: boolean } {
    const { w } = this
    this.stamp++
    if (this.stamp === 0xffffffff) {
      this.seen.fill(0)
      this.closed.fill(0)
      this.stamp = 1
    }
    const st = this.stamp
    this.salt = q.salt ?? 0
    const start = q.sy * w + q.sx
    const h0 = q.h(q.sx, q.sy)
    if (h0 === 0) return { path: [], reached: true }
    this.heap.length = 0
    this.g[start] = 0
    this.hv[start] = h0
    this.f[start] = h0
    this.parent[start] = -1
    this.seen[start] = st
    this.push(start)
    let best = start
    let expanded = 0
    while (this.heap.length > 0) {
      const cur = this.pop()
      if (this.closed[cur] === st) continue
      this.closed[cur] = st
      const ch = this.hv[cur]
      if (ch === 0) {
        this.expanded += expanded
        return { path: this.build(cur), reached: true }
      }
      if (ch < this.hv[best] || (ch === this.hv[best] && this.g[cur] < this.g[best])) best = cur
      if (++expanded > q.maxExpand) break
      const cx = cur % w
      const cy = (cur - cx) / w
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX[d]
        const ny = cy + DY[d]
        if (nx < 0 || ny < 0 || nx >= w || ny >= this.h) continue
        const ni = ny * w + nx
        if (this.closed[ni] === st || !q.passable(ni)) continue
        const ng = this.g[cur] + 1
        if (this.seen[ni] === st && ng >= this.g[ni]) continue
        const nh = this.seen[ni] === st ? this.hv[ni] : q.h(nx, ny)
        this.seen[ni] = st
        this.g[ni] = ng
        this.hv[ni] = nh
        this.f[ni] = ng + nh
        this.parent[ni] = cur
        this.push(ni)
      }
    }
    this.expanded += expanded
    return { path: this.build(best), reached: false }
  }

  private build(end: number): number[] {
    const out: number[] = []
    for (let i = end; this.parent[i] !== -1; i = this.parent[i]) out.push(i)
    return out
  }

  private less(a: number, b: number): boolean {
    const fa = this.f[a]
    const fb = this.f[b]
    if (fa !== fb) return fa < fb
    const ha = this.hv[a]
    const hb = this.hv[b]
    if (ha !== hb) return ha < hb
    return (a ^ this.salt) < (b ^ this.salt)
  }

  private push(i: number): void {
    const hp = this.heap
    hp.push(i)
    let k = hp.length - 1
    while (k > 0) {
      const p = (k - 1) >> 1
      if (!this.less(hp[k], hp[p])) break
      ;[hp[k], hp[p]] = [hp[p], hp[k]]
      k = p
    }
  }

  private pop(): number {
    const hp = this.heap
    const top = hp[0]
    const last = hp.pop()!
    if (hp.length > 0) {
      hp[0] = last
      let k = 0
      for (;;) {
        const l = 2 * k + 1
        const r = l + 1
        let m = k
        if (l < hp.length && this.less(hp[l], hp[m])) m = l
        if (r < hp.length && this.less(hp[r], hp[m])) m = r
        if (m === k) break
        ;[hp[k], hp[m]] = [hp[m], hp[k]]
        k = m
      }
    }
    return top
  }
}
