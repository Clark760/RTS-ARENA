// 平台建议上限。规模由规则包作者决定，超出不会被拒绝，只在 arena run 时提醒。
// 依据 npm run bench 的实测（doc/设计.md「建议上限」有完整数据）：
// - 600 个实体时内核每 tick 约 2.3～4.5 毫秒（单位越挤绕路越多），1.2 万 tick 约 30～55 秒；
// - 燃料用满时每 1 燃料约 0.24～0.44 毫秒（看机器），bot 燃料部分最坏耗时 ≈ 调用次数 × 燃料 × 0.44 毫秒；
//   不计燃料的内置操作另由沙箱的整局墙钟上限（120 秒）兜底。
import type { Replay, Ruleset } from "./types.ts"

export const RECOMMENDED = {
  /** 地图边长（格） */
  mapSide: 128,
  /** 玩家数 */
  players: 4,
  /** 全场同时存在的实体数（含建筑、资源点） */
  entities: 600,
  /** 一局最多 tick */
  maxTicks: 12000,
  /** 每次调用 bot 的燃料（用满约 90 毫秒） */
  fuel: 200,
  /** 决策间隔最小值（每 tick 都调 bot，bot 耗时翻 5 倍以上） */
  decisionInterval: 2,
  /** 每个 bot 整局燃料总上限 = (maxTicks / decisionInterval) × fuel；24 万约合最坏 105 秒 */
  fuelPerMatch: 240000,
}

/** 返回超出建议上限的提醒；传 replay 时还检查地图和实体峰值 */
export function checkLimits(rules: Ruleset, replay?: Replay): string[] {
  const out: string[] = []
  const R = RECOMMENDED
  if (rules.players.max > R.players) out.push(`玩家数上限 ${rules.players.max} 超过建议的 ${R.players}`)
  if (rules.maxTicks > R.maxTicks) out.push(`maxTicks ${rules.maxTicks} 超过建议的 ${R.maxTicks}`)
  if (rules.fuel > R.fuel) out.push(`fuel ${rules.fuel} 超过建议的 ${R.fuel}`)
  if (rules.decisionInterval < R.decisionInterval) out.push(`decisionInterval ${rules.decisionInterval} 小于建议的 ${R.decisionInterval}`)
  const perMatch = Math.ceil(rules.maxTicks / rules.decisionInterval) * rules.fuel
  if (perMatch > R.fuelPerMatch) out.push(`每个 bot 整局燃料最多 ${perMatch}，超过建议的 ${R.fuelPerMatch}（bot 写得差时一局可能要跑好几分钟）`)
  if (replay) {
    const { width, height } = replay.map
    if (width > R.mapSide || height > R.mapSide) out.push(`地图 ${width}×${height} 超过建议的 ${R.mapSide}×${R.mapSide}`)
    if (replay.perf.peakEntities > R.entities) out.push(`实体数峰值 ${replay.perf.peakEntities} 超过建议的 ${R.entities}`)
  }
  return out
}
