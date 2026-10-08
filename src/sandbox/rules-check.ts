// 检查沙箱规则包导出的静态数据（参数、地形、实体类型）。规则包是别人写的，格式不对要在开局前说清楚哪里不对，
// 而不是在对局中途让内核崩掉。平台自带的规则包也要能通过（测试里查）。

/** 沙箱规则包的硬上限（超出直接拒绝；建议上限见 src/core/limits.ts，那个只提醒） */
export const RULES_HARD = {
  mapSide: 256,
  players: 8,
  entities: 5000,
  maxTicks: 100_000,
  botFuel: 2000,
  types: 64,
  resources: 8,
  terrain: 16,
  /** 单个建筑最大边长 */
  buildingSide: 8,
}

const SHAPES = ["circle", "square", "triangle", "diamond", "hex"]
const KINDS = ["unit", "building", "resource"]
const NAME = /^[a-z][a-z0-9_]{0,31}$/

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v)
const isInt = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max

/** 返回所有问题；空数组表示没问题 */
export function checkRulesetData(d: unknown, callbacks: string[]): string[] {
  const errs: string[] = []
  const bad = (msg: string) => errs.push(msg)
  if (!isObj(d)) return ["默认导出不是对象（要写成 export default { id, name, ... } 或 export default ruleset）"]

  if (typeof d.id !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(d.id)) bad("id 要是小写字母开头、只含小写字母数字 _ - 的字符串（最长 32）")
  if (typeof d.name !== "string" || d.name.length === 0 || d.name.length > 40) bad("name 要是 1～40 字的字符串")
  if (d.summary !== undefined && (typeof d.summary !== "string" || d.summary.length > 60)) bad("summary 要是最长 60 字的字符串（一句话玩法简介）")
  const players = d.players
  if (!isObj(players) || !isInt(players.min, 1, RULES_HARD.players) || !isInt(players.max, 1, RULES_HARD.players) || players.min > players.max)
    bad(`players 要写成 { min, max }，1 ≤ min ≤ max ≤ ${RULES_HARD.players}`)
  if (d.teams !== undefined && typeof d.teams !== "boolean") bad("teams 要是 true / false")
  if (!isInt(d.maxTicks, 1, RULES_HARD.maxTicks)) bad(`maxTicks 要是 1～${RULES_HARD.maxTicks} 的整数`)
  if (typeof d.tickRate !== "number" || !(d.tickRate >= 1 && d.tickRate <= 120)) bad("tickRate 要是 1～120 的数")
  if (!isInt(d.decisionInterval, 1, 1000)) bad("decisionInterval 要是 1～1000 的整数")
  if (!isInt(d.fuel, 1, RULES_HARD.botFuel)) bad(`fuel 要是 1～${RULES_HARD.botFuel} 的整数`)
  if (!isInt(d.unitCap, 0, RULES_HARD.entities)) bad(`unitCap 要是 0～${RULES_HARD.entities} 的整数（0 是不限）`)
  if (typeof d.fog !== "boolean") bad("fog 要是 true / false")

  const resources = Array.isArray(d.resources) ? d.resources : null
  if (!resources || resources.length === 0 || resources.length > RULES_HARD.resources || resources.some((r) => typeof r !== "string" || !NAME.test(r)))
    bad(`resources 要是 1～${RULES_HARD.resources} 个小写名字的数组，如 ["gold"]`)
  const resSet = new Set((resources ?? []).filter((r): r is string => typeof r === "string"))

  if (!isObj(d.terrain) || Object.keys(d.terrain).length === 0 || Object.keys(d.terrain).length > RULES_HARD.terrain) bad(`terrain 要是 1～${RULES_HARD.terrain} 种地形`)
  else
    for (const [ch, t] of Object.entries(d.terrain)) {
      if ([...ch].length !== 1) bad(`地形 "${ch}" 的键要是单个字符`)
      if (!isObj(t) || typeof t.walkable !== "boolean" || typeof t.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(t.color))
        bad(`地形 "${ch}" 要写成 { walkable: true/false, color: "#rrggbb" }`)
    }

  if (!isObj(d.types) || Object.keys(d.types).length === 0 || Object.keys(d.types).length > RULES_HARD.types) bad(`types 要是 1～${RULES_HARD.types} 种实体类型`)
  else {
    const types = d.types
    const names = new Set(Object.keys(types))
    for (const [name, s] of Object.entries(types)) {
      const at = `types.${name}`
      if (!NAME.test(name)) bad(`${at}：类型名要是小写字母开头的小写名字`)
      if (!isObj(s)) {
        bad(`${at} 要是对象`)
        continue
      }
      const kind = s.kind
      if (typeof kind !== "string" || !KINDS.includes(kind)) {
        bad(`${at}.kind 要是 unit、building、resource 之一`)
        continue
      }
      const side = kind === "unit" ? 1 : RULES_HARD.buildingSide
      for (const k of ["w", "h"]) if (s[k] !== undefined && !isInt(s[k], 1, side)) bad(`${at}.${k} 要是 1～${side} 的整数${kind === "unit" ? "（单位只能是 1×1）" : ""}`)
      for (const k of ["maxHp", "buildTicks", "moveTicks", "amount"]) if (s[k] !== undefined && !isInt(s[k], 0)) bad(`${at}.${k} 要是非负整数`)
      if (s.sight !== undefined && !isInt(s.sight, 0, 32)) bad(`${at}.sight 要是 0～32 的整数`)
      if (s.cost !== undefined) {
        if (!isObj(s.cost)) bad(`${at}.cost 要写成 { 资源名: 数量 }`)
        else for (const [r, n] of Object.entries(s.cost)) if (!resSet.has(r) || !isInt(n, 0)) bad(`${at}.cost.${r}：资源要在 resources 里，数量是非负整数`)
      }
      if (s.attack !== undefined && s.attack !== null) {
        const a = s.attack
        if (!isObj(a) || !isInt(a.damage, 0) || !isInt(a.range, 1, 16) || !isInt(a.cooldown, 1)) bad(`${at}.attack 要写成 { damage ≥ 0, range 1～16, cooldown ≥ 1 }（整数）`)
        else if (a.vs !== undefined) {
          // 克制倍数（D-166）：打这些类型时伤害乘几倍
          if (!isObj(a.vs)) bad(`${at}.attack.vs 要写成 { 类型名: 倍数 }，比如 { cavalry: 3 }`)
          else
            for (const [k, m] of Object.entries(a.vs))
              if (!names.has(k) || typeof m !== "number" || !Number.isFinite(m) || m < 0 || m > 10) bad(`${at}.attack.vs.${k}：类型要是已定义的类型名，倍数是 0～10 的数`)
        }
      }
      if (s.gather !== undefined && s.gather !== null) {
        const g = s.gather
        if (kind !== "unit") bad(`${at}.gather：只有单位能采集`)
        if (!isObj(g) || !isInt(g.amount, 1) || !isInt(g.ticks, 1) || !isInt(g.capacity, 1)) bad(`${at}.gather 要写成 { amount, ticks, capacity }（正整数）`)
      }
      if (s.dropOff !== undefined && typeof s.dropOff !== "boolean") bad(`${at}.dropOff 要是 true / false`)
      for (const k of ["produces", "builds"]) {
        const list = s[k]
        if (list === undefined) continue
        if (!Array.isArray(list) || list.some((x) => typeof x !== "string" || !names.has(x))) bad(`${at}.${k} 要是已定义的类型名数组`)
        else if (k === "builds" && list.some((x) => (types[x as string] as Obj | undefined)?.kind !== "building")) bad(`${at}.builds 里只能是建筑类型`)
      }
      if (kind === "resource" && (typeof s.resource !== "string" || !resSet.has(s.resource))) bad(`${at}.resource：资源点要写产出的资源名（在 resources 里）`)
      if (kind !== "resource" && s.resource !== undefined && s.resource !== null) bad(`${at}.resource：只有资源点能写`)
      const look = s.look
      if (!isObj(look) || typeof look.shape !== "string" || !SHAPES.includes(look.shape)) bad(`${at}.look.shape 要是 ${SHAPES.join("、")} 之一`)
      else {
        if (look.label !== undefined && (typeof look.label !== "string" || [...look.label].length > 2)) bad(`${at}.look.label 最多 2 个字`)
        if (look.color !== undefined && (typeof look.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(look.color))) bad(`${at}.look.color 要写成 "#rrggbb"`)
        if (look.name !== undefined && (typeof look.name !== "string" || [...look.name].length < 1 || [...look.name].length > 6)) bad(`${at}.look.name 要写 1～6 个字`)
      }
    }
  }

  for (const fn of ["setup", "objectives", "result", "timeUp"]) if (!callbacks.includes(fn)) bad(`缺少函数 ${fn}(ctx)`)
  return errs
}

/** 检查 result / timeUp 的返回值；返回问题说明，没问题返回 null */
export function checkResult(r: unknown, playerCount: number, allowNull: boolean): string | null {
  if (r === null) return allowNull ? null : "timeUp 必须返回结果，不能是 null"
  if (!isObj(r)) return "结果要写成 { winner, reason }（还没分出胜负就返回 null）"
  const player = (v: unknown) => isInt(v, 0, playerCount - 1)
  if (r.winner !== null && !player(r.winner)) return `winner 要是 0～${playerCount - 1} 的玩家编号，平局写 null`
  if (typeof r.reason !== "string" || r.reason.length > 200) return "reason 要是最长 200 字的字符串"
  if (r.winners !== undefined && (!Array.isArray(r.winners) || !r.winners.every(player))) return "winners 要是玩家编号数组"
  if (r.ranking !== undefined && (!Array.isArray(r.ranking) || !r.ranking.every((g) => Array.isArray(g) && g.every(player))))
    return "ranking 要是玩家编号数组的数组，如 [[0], [1, 2]]"
  if (r.stats !== undefined) {
    if (!isObj(r.stats)) return "stats 要写成 { 名字: [每个玩家的数] }"
    const keys = Object.keys(r.stats)
    if (keys.length > 12) return "stats 最多 12 项"
    for (const k of keys) {
      const v = (r.stats as Record<string, unknown>)[k]
      if (k.length === 0 || k.length > 20) return `stats 的名字要是 1～20 字（"${k.slice(0, 30)}"）`
      if (!Array.isArray(v) || v.length !== playerCount || !v.every((x) => typeof x === "number" && Number.isFinite(x)))
        return `stats.${k} 要是 ${playerCount} 个数的数组（按玩家编号排）`
    }
  }
  return null
}
