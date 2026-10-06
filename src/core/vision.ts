// 视野的计算规则：引擎和播放器共用（播放器按某一方的视野看回放时，用的就是 bot 当时看到的范围）
import type { Rect } from "./types.ts"

/** 把占地矩形 r 视野 s 以内（曼哈顿距离，从占地最近的格子算）的格子标成 1 */
export function markSight(vis: Uint8Array, width: number, height: number, r: Rect, s: number): void {
  const y0 = Math.max(0, r.y - s)
  const y1 = Math.min(height - 1, r.y + r.h - 1 + s)
  for (let y = y0; y <= y1; y++) {
    const dy = Math.max(0, r.y - y, y - (r.y + r.h - 1))
    const rem = s - dy
    const x0 = Math.max(0, r.x - rem)
    const x1 = Math.min(width - 1, r.x + r.w - 1 + rem)
    vis.fill(1, y * width + x0, y * width + x1 + 1)
  }
}

/** 占地里有任何一格在视野里 */
export function rectSeen(vis: Uint8Array, width: number, r: Rect): boolean {
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (vis[y * width + x]) return true
  return false
}
