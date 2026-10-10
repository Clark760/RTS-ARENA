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
      if (s.parallel !== undefined && (!isInt(s.parallel, 1, 5) || !Array.isArray(s.produces) || s.produces.length === 0)) bad(`${at}.parallel 要是 1～5 的整数（同时造几个，生产队列最多 5 个），而且要有 produces`)
      checkAbilities(s, at, names, kind, resSet, bad)
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
  // 技能的效果在 onCast 里实现（D-186），没有的话 bot 放什么技能都会被拒
  const withSkills = isObj(d.types) ? Object.entries(d.types).filter(([, t]) => isObj(t) && Array.isArray(t.skills) && t.skills.length > 0).map(([k]) => k) : []
  if (withSkills.length && !callbacks.includes("onCast")) bad(`${withSkills.join("、")} 有技能（skills），要导出 onCast(ctx, cast) 实现技能效果`)
  return errs
}

/** 技能、光环、被动（D-186） */
function checkAbilities(s: Obj, at: string, names: Set<string>, kind: string, resSet: Set<string>, bad: (msg: string) => void): void {
  const short = (v: unknown, max: number) => typeof v === "string" && [...v].length >= 1 && [...v].length <= max
  if (s.skills !== undefined) {
    if (!Array.isArray(s.skills) || s.skills.length > 8) bad(`${at}.skills 要是数组，最多 8 个`)
    else {
      if (kind === "resource" && s.skills.length) bad(`${at}.skills：资源点不能有技能`)
      const ids = new Set<string>()
      s.skills.forEach((k, i) => {
        const w = `${at}.skills[${i}]`
        if (!isObj(k)) return bad(`${w} 要写成 { id, name, cooldown, desc }`)
        if (typeof k.id !== "string" || !NAME.test(k.id)) bad(`${w}.id 要是小写字母开头的小写名字（cmd.cast 用它）`)
        else if (ids.has(k.id)) bad(`${w}.id 和前面的技能重名`)
        else ids.add(k.id)
        if (!short(k.name, 6)) bad(`${w}.name 要写 1～6 个字的中文名`)
        if (!short(k.desc, 80)) bad(`${w}.desc 要写 1～80 字的效果说明（bot 作者看它）`)
        if (!isInt(k.cooldown, 1, 100_000)) bad(`${w}.cooldown 要是 1～100000 的整数（tick）`)
        if (k.initialCooldown !== undefined && !isInt(k.initialCooldown, 0, 100_000)) bad(`${w}.initialCooldown 要是 0～100000 的整数`)
        if (k.target !== undefined && !["none", "point", "unit"].includes(k.target as string)) bad(`${w}.target 要是 none、point、unit 之一`)
        if (k.range !== undefined && !isInt(k.range, 0, 64)) bad(`${w}.range 要是 0～64 的整数`)
        if ((k.target === "point" || k.target === "unit") && !isInt(k.range, 1, 64)) bad(`${w}：target 是 ${k.target} 时要写 range（1～64）`)
        if (k.cost !== undefined) {
          if (!isObj(k.cost)) bad(`${w}.cost 要写成 { 资源名: 数量 }`)
          else for (const [r, n] of Object.entries(k.cost)) if (!resSet.has(r) || !isInt(n, 0)) bad(`${w}.cost.${r}：资源要在 resources 里，数量是非负整数`)
        }
      })
    }
  }
  if (s.auras !== undefined) {
    if (!Array.isArray(s.auras) || s.auras.length > 4) bad(`${at}.auras 要是数组，最多 4 个`)
    else
      s.auras.forEach((a, i) => {
        const w = `${at}.auras[${i}]`
        if (!isObj(a)) return bad(`${w} 要写成 { name, damagePct, defensePct, ... }`)
        if (!short(a.name, 6)) bad(`${w}.name 要写 1～6 个字的中文名`)
        if (a.radius !== undefined && !isInt(a.radius, -1, 32)) bad(`${w}.radius 要是 -1～32 的整数（-1 是等于视野）`)
        if (a.affects !== undefined && !["own", "allies", "enemies"].includes(a.affects as string)) bad(`${w}.affects 要是 own、allies、enemies 之一`)
        if (a.types !== undefined && (!Array.isArray(a.types) || a.types.some((t) => typeof t !== "string" || !names.has(t)))) bad(`${w}.types 要是已定义的类型名数组`)
        if (a.self !== undefined && typeof a.self !== "boolean") bad(`${w}.self 要是 true / false`)
        if (a.damagePct !== undefined && !isInt(a.damagePct, -100, 1000)) bad(`${w}.damagePct 要是 -100～1000 的整数（百分比）`)
        if (a.defensePct !== undefined && !isInt(a.defensePct, -1000, 90)) bad(`${w}.defensePct 要是 -1000～90 的整数（百分比）`)
        if (!a.damagePct && !a.defensePct) bad(`${w}：damagePct、defensePct 至少写一项（不然光环没有效果）`)
      })
  }
  if (s.passives !== undefined) {
    if (!Array.isArray(s.passives) || s.passives.length > 4) bad(`${at}.passives 要是数组，最多 4 个`)
    else
      s.passives.forEach((x, i) => {
        const w = `${at}.passives[${i}]`
        if (!isObj(x) || x.kind !== "regen") return bad(`${w} 现在只支持 { kind: "regen", name, delay, every, amount }（脱战回血）`)
        if (!short(x.name, 6)) bad(`${w}.name 要写 1～6 个字的中文名`)
        if (!isInt(x.delay, 0, 100_000) || !isInt(x.every, 1, 100_000) || !isInt(x.amount, 1, 100_000)) bad(`${w}：delay ≥ 0、every ≥ 1、amount ≥ 1（整数）`)
        if (kind === "resource") bad(`${w}：资源点不能有被动`)
      })
  }
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
