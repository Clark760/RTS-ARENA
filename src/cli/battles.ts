// 战斗的切分（战报、精彩对局、联赛视频共用一套，三处说的"第几场大战、各损失几个"才对得上）：
// 时间上挨着（60 tick 内）、地点挨着（15 格内）的死亡算一场；一场最长 300 tick，再长就算下一场
export function groupBattles<D extends { t: number; x: number; y: number }>(deaths: D[]): D[][] {
  const out: D[][] = []
  for (const d of deaths) {
    const b = out[out.length - 1]
    if (b && d.t - b[b.length - 1].t <= 60 && d.t - b[0].t <= 300) {
      const cx = b.reduce((a, x) => a + x.x, 0) / b.length
      const cy = b.reduce((a, x) => a + x.y, 0) / b.length
      if (Math.abs(d.x - cx) + Math.abs(d.y - cy) <= 15) {
        b.push(d)
        continue
      }
    }
    out.push([d])
  }
  return out
}

/** 死 3 个以上才算一场战斗 */
export const MIN_BATTLE = 3

/** 算"兵"的：不是工人的单位（规则包里没有兵、只有工人时，工人也算） */
export function fighterTest(types: Record<string, { kind?: string; worker?: boolean } | undefined>): (type: string) => boolean {
  const hasArmy = Object.values(types).some((t) => t?.kind === "unit" && !t.worker)
  return (type) => types[type]?.kind === "unit" && (!hasArmy || !types[type]?.worker)
}

/**
 * 一边倒（D-164）：只有一方在死人；或者有一方没死兵（只死了工人、建筑：兵冲进矿区杀工人、撞上箭塔）；
 * 或者死得少的一方不到死得多的一方的 1/4。这种不算大战：精彩对局不加分，战报和视频侧栏里标成「一边倒」。
 * 各方按队伍合并，中立算一方
 */
export function isRout(b: { owner: number; fighter: boolean }[], team: (p: number) => number = (p) => p): boolean {
  const loss = new Map<number, { n: number; fighters: number }>()
  for (const d of b) {
    const k = d.owner < 0 ? -1 : team(d.owner)
    const x = loss.get(k) ?? { n: 0, fighters: 0 }
    x.n++
    if (d.fighter) x.fighters++
    loss.set(k, x)
  }
  const sides = [...loss.values()].sort((a, c) => c.n - a.n)
  if (sides.length < 2) return true
  if (sides.filter((s) => s.fighters > 0).length < 2) return true
  return sides[1].n * 4 < sides[0].n
}
