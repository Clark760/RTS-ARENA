// 科技：在拓荒的基础上（同样的地图、开局、单位和胜负），工人还能建 4 种科技建筑。建好的科技建筑在，加成就在（被拆了就没了），
// 同一种建几座也只算一份。加成用局中改数值（ctx.setTypeStats，D-153）实现，D-154
import type { RuleContext, Ruleset, StatPatch, TypeSpec } from "../../src/core/types.ts"
import { STANDARD_TERRAIN } from "../common/standard.ts"
import { enemyBasesOf, frontierResult, frontierSetup, frontierTimeUp, frontierTypes, scoreKills } from "../common/frontier.ts"
import type { Objectives, TechId } from "./objectives.ts"

interface Tech {
  name: string
  /** 加成说明（战况、RULES.md 用） */
  text: string
  /** 改哪类单位的什么数值（改成多少） */
  patches: Record<string, StatPatch>
}

const TECHS: Record<TechId, Tech> = {
  forge: { name: "铁匠铺", text: "战士、弓手伤害 10 → 13", patches: { soldier: { attack: { damage: 13 } }, archer: { attack: { damage: 13 } } } },
  armory: { name: "护甲坊", text: "战士生命 120 → 160、弓手 60 → 80", patches: { soldier: { maxHp: 160 }, archer: { maxHp: 80 } } },
  archery: { name: "箭术场", text: "弓手射程 4 → 5、视野 7 → 8", patches: { archer: { attack: { range: 5 }, sight: 8 } } },
  mining: { name: "矿业所", text: "工人每 4 tick 采 1 金（原来 5 tick）、最多带 6（原来 5）", patches: { worker: { gather: { ticks: 4, capacity: 6 } } } },
}
const TECH_IDS = Object.keys(TECHS) as TechId[]
const isTech = (type: string): type is TechId => TECH_IDS.includes(type as TechId)

function techTypes(): Record<string, TypeSpec> {
  const t = frontierTypes()
  const building = (name: string, label: string, gold: number, buildTicks: number, maxHp: number): TypeSpec => ({
    kind: "building",
    w: 2,
    h: 2,
    maxHp,
    cost: { gold },
    buildTicks,
    sight: 4,
    look: { shape: "hex", label, name },
  })
  t.forge = building("铁匠铺", "锻", 150, 240, 600)
  t.armory = building("护甲坊", "甲", 150, 240, 600)
  t.archery = building("箭术场", "靶", 125, 200, 500)
  t.mining = building("矿业所", "矿", 100, 150, 450)
  t.worker.builds = ["barracks", "tower", "depot", ...TECH_IDS]
  return t
}

const types = techTypes()

/** 科技改到的数值的原值（关掉加成时改回去用） */
function baseOf(type: string, p: StatPatch): StatPatch {
  const s = types[type]
  const out: StatPatch = {}
  if (p.maxHp !== undefined) out.maxHp = s.maxHp
  if (p.moveTicks !== undefined) out.moveTicks = s.moveTicks
  if (p.sight !== undefined) out.sight = s.sight
  if (p.attack && s.attack) out.attack = Object.fromEntries(Object.keys(p.attack).map((k) => [k, s.attack![k as keyof typeof s.attack]]))
  if (p.gather && s.gather) out.gather = Object.fromEntries(Object.keys(p.gather).map((k) => [k, s.gather![k as keyof typeof s.gather]]))
  return out
}

function merge(a: StatPatch, b: StatPatch): StatPatch {
  return { ...a, ...b, ...(a.attack || b.attack ? { attack: { ...a.attack, ...b.attack } } : {}), ...(a.gather || b.gather ? { gather: { ...a.gather, ...b.gather } } : {}) }
}

/** 每个玩家现在生效的科技 */
let active: Set<TechId>[] = []

function resetState(): void {
  active = []
}

/** 按玩家现在有的科技重设他各类单位的数值：科技改到的每一项，有这个科技就是加成后的值，没有就是原值 */
function applyTechs(ctx: RuleContext, p: number, have: Set<TechId>): void {
  const want = new Map<string, StatPatch>()
  for (const id of TECH_IDS)
    for (const [type, patch] of Object.entries(TECHS[id].patches)) want.set(type, merge(want.get(type) ?? {}, have.has(id) ? patch : baseOf(type, patch)))
  for (const [type, patch] of want) ctx.setTypeStats(p, type, patch)
}

function updateTechs(ctx: RuleContext): void {
  const now = ctx.players.map(() => new Set<TechId>())
  for (const e of ctx.entities({ kind: "building" })) if (e.owner >= 0 && isTech(e.type) && !e.construction) now[e.owner].add(e.type)
  for (const p of ctx.players) {
    const before = active[p.id] ?? new Set<TechId>()
    const gained = TECH_IDS.filter((t) => now[p.id].has(t) && !before.has(t))
    const lost = TECH_IDS.filter((t) => !now[p.id].has(t) && before.has(t))
    if (gained.length === 0 && lost.length === 0) continue
    for (const t of gained) ctx.note(`P${p.id} 的${TECHS[t].name}建好了：${TECHS[t].text}`, p.id)
    for (const t of lost) ctx.note(`P${p.id} 没有${TECHS[t].name}了，加成取消（${TECHS[t].text}）`, p.id)
    applyTechs(ctx, p.id, now[p.id])
  }
  active = now
}

const techText = (s: Set<TechId> | undefined) => (s && s.size ? TECH_IDS.filter((t) => s.has(t)).map((t) => TECHS[t].name).join("、") : "无")

const ruleset: Ruleset = {
  id: "tech",
  name: "科技",
  summary: "拓荒加科技：工人还能建铁匠铺、护甲坊、箭术场、矿业所，建筑在加成就在，摧毁对方主基地获胜",
  players: { min: 2, max: 2 },
  maxTicks: 9000,
  tickRate: 10,
  decisionInterval: 5,
  fuel: 130,
  unitCap: 60,
  fog: true,
  resources: ["gold"],
  terrain: STANDARD_TERRAIN,
  types,

  setup(ctx) {
    resetState()
    frontierSetup(ctx, types)
  },

  onTick(ctx) {
    scoreKills(ctx, types)
    updateTechs(ctx)
    ctx.setStatus(`击杀价值 ${ctx.players.map((p) => p.score).join(" : ")}  科技 ${ctx.players.map((p) => `P${p.id}：${techText(active[p.id])}`).join("  ")}`)
  },

  objectives(ctx, player): Objectives {
    return {
      enemyBases: enemyBasesOf(player),
      killValue: ctx.players.map((p) => p.score),
      techs: ctx.players.map((p) => TECH_IDS.filter((t) => active[p.id]?.has(t))),
    }
  },

  result: frontierResult,
  timeUp: frontierTimeUp,
}

export default ruleset
