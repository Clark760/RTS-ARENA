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
