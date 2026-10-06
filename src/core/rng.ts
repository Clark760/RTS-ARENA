// 确定性随机数：mulberry32；种子用 FNV-1a 从多个部分混出来
import type { Rng } from "./types.ts"

export class Mulberry32 implements Rng {
  private s: number

  constructor(seed: number) {
    this.s = seed | 0
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return (t ^ (t >>> 14)) >>> 0
  }

  int(n: number): number {
    return this.next() % n
  }

  shuffle<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1)
      const tmp = arr[i]
      arr[i] = arr[j]
      arr[j] = tmp
    }
  }
}

/** FNV-1a：把种子和用途标签混成一个 32 位种子，让各路随机数互不影响 */
export function mixSeed(...parts: (number | string)[]): number {
  let h = 0x811c9dc5
  const text = parts.join("|")
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
