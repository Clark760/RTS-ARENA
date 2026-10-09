// 弑君（D-187）：歼灭、拓荒的基础上，开局每家送 1 个领主（lord）。主基地被拆或者领主阵亡都判负。
// 领主用的是平台的技能、光环、被动（D-186）：
// - 光环「领主光环」：视野（8 格）内自己的战士、弓手打出的伤害 +25%、受到的伤害 −25%
// - 被动「休养生息」：100 tick 没出手、没挨打以后，每 10 tick 回 10 生命
// - 技能「点金」（goldmine）：在领主身边的空地上造一座 300 金的中立金矿，冷却 600 tick
// 领主的移速、视野、攻击和克制规则包的侦察兵一样（走一格 1 tick、视野 8、攻击 1），生命 500（主基地 1500 的三分之一）
import type { CastInfo, MatchResult, RuleContext, SetupContext, TypeSpec } from "../../src/core/types.ts"
import { spawnMirrored } from "./standard.ts"

/** 点金造出来的金矿储量 */
export const LORD_MINE_AMOUNT = 300

/** 领主：troops 是光环加成的兵种 */
export function lordType(troops: string[]): TypeSpec {
  return {
    kind: "unit",
    maxHp: 500,
    moveTicks: 1,
    sight: 8,
    attack: { damage: 1, range: 1, cooldown: 10 },
    skills: [{ id: "goldmine", name: "点金", cooldown: 600, desc: `在领主身边的空地上造一座 ${LORD_MINE_AMOUNT} 金的中立金矿（谁都能采）` }],
    auras: [{ name: "领主光环", radius: -1, affects: "own", types: troops, damagePct: 25, defensePct: 25 }],
    passives: [{ kind: "regen", name: "休养生息", delay: 100, every: 10, amount: 10 }],
    look: { shape: "hex", label: "王", name: "领主" },
  }
}

/** 在单位表里加上领主（放在工人后面，单位表、图例按这个顺序列） */
export function withLord(types: Record<string, TypeSpec>, troops: string[]): Record<string, TypeSpec> {
  const out: Record<string, TypeSpec> = {}
  for (const [k, v] of Object.entries(types)) {
    out[k] = v
    if (k === "worker") out.lord = lordType(troops)
  }
  return out
}

/** 开局每家 1 个领主：左上那家放在家里的角落 (1, 1)，右下那家放在中心对称的位置（歼灭、拓荒的开局这一格都空着） */
export function spawnLords(ctx: SetupContext, width: number, height: number, types: Record<string, TypeSpec>): void {
  spawnMirrored(ctx, width, height, types, [{ type: "lord", owner: 0, x: 1, y: 1 }])
}

/** 点金：在领主身边找空地放一座中立金矿；没有空地就拒绝（不进冷却） */
export function regicideCast(ctx: RuleContext, c: CastInfo): string | null {
  if (c.skill !== "goldmine") return `没有技能 ${c.skill}`
  const lord = ctx.get(c.unit)
  if (!lord) return "领主不在了"
  const id = ctx.spawnNear("goldmine", -1, lord.x, lord.y, { amount: LORD_MINE_AMOUNT })
  if (id === null) return "领主身边没有空地放金矿，换个地方再放"
  ctx.note(`P${c.player} 的领主点出一座金矿`, c.player)
  return null
}

function baseHp(ctx: RuleContext, p: number): number {
  let hp = 0
  for (const e of ctx.entities({ owner: p, type: "base" })) hp += e.hp
  return hp
}

/** 主基地被拆或领主阵亡就出局；只剩一家时它赢，两家同一 tick 出局算平局 */
export function regicideResult(ctx: RuleContext): MatchResult | null {
  const why: string[] = []
  for (const p of ctx.players) {
    if (!p.alive) continue
    const noBase = baseHp(ctx, p.id) === 0
    const noLord = ctx.entities({ owner: p.id, type: "lord" }).length === 0
    if (!noBase && !noLord) continue
    ctx.eliminate(p.id)
    why[p.id] = noLord && noBase ? "击杀了对方的领主、摧毁了主基地" : noLord ? "击杀了对方的领主" : "摧毁了对方的主基地"
  }
  const alive = ctx.players.filter((p) => p.alive)
  if (alive.length === 1) return { winner: alive[0].id, reason: why.find((x) => x) ?? "对方出局" }
  if (alive.length === 0) return { winner: null, reason: "双方同一 tick 出局（领主阵亡或主基地被毁），平局" }
  return null
}
