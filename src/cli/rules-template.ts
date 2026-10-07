// rts-arena new-rules <目录>：建一个能直接跑的示例规则包（采金赛），自己写规则包从它改起
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { PKG_ROOT } from "../paths.ts"
import { loadSandboxedRuleset } from "../sandbox/ruleset.ts"
import { buildDts, RULES_GLOBALS_DTS, rulesTsconfig } from "./docgen.ts"

export const INDEX = `// 示例规则包「采金赛」：先累计交够 600 金的赢；主基地被摧毁直接输；到时间比交货量。从这里改起。
// 写法见同目录的 RULESET.md。类型从 "rts-arena/ruleset" 导入（import type），共用的单位和地图工具从 "rts-arena/standard" 导入。
import type { RuleContext, Ruleset } from "rts-arena/ruleset"
import {
  baseStarts,
  randomSymmetricMap,
  spawnMirrored,
  STANDARD_OBSTACLE_CHARS,
  STANDARD_SHAPES,
  STANDARD_TERRAIN,
  standardTypes,
  symmetricTerrain,
} from "rts-arena/standard"
import type { Objectives } from "./objectives.ts"

const W = 32
const H = 24
const TARGET = 600
const types = standardTypes()

function hasBase(ctx: RuleContext, player: number): boolean {
  return ctx.entities({ owner: player, type: "base" }).length > 0
}

const ruleset: Ruleset = {
  id: "__ID__",
  name: "采金赛",
  summary: "先累计交够 600 金的赢，摧毁对方主基地也直接赢",
  players: { min: 2, max: 2 },
  maxTicks: 4000,
  tickRate: 10,
  decisionInterval: 5,
  fuel: 100,
  unitCap: 30,
  fog: true,
  resources: ["gold"],
  terrain: STANDARD_TERRAIN,
  types,

  setup(ctx) {
    // 左上角是玩家 0，右下角中心对称处是玩家 1。
    // 地图按种子随机（每局不同，bot 没法对着一张图调参数）：家固定，墙、水和中间那个大金矿的位置每局换，两边中心对称
    const map = randomSymmetricMap(ctx.rng, {
      width: W,
      height: H,
      symmetry: "point",
      base: symmetricTerrain(W, H, ".", []),
      terrain: STANDARD_TERRAIN,
      keepClear: [{ x: 0, y: 0, w: 10, h: 9 }], // 家：主基地、兵营、工人、家门口的金矿
      obstacles: { count: [2, 4], shapes: STANDARD_SHAPES, chars: STANDARD_OBSTACLE_CHARS },
      mines: [{ region: { x: 11, y: 3, w: 6, h: 6 }, offsets: [{ x: 0, y: 0 }] }],
      connect: [{ x: 5, y: 6 }], // 家门口；它的对称位置（对方家门口）和每个矿都要走得到
    })
    // 生成不出合格的地图（几乎不会）就用固定布局
    ctx.setTerrain(
      map?.terrain ??
        symmetricTerrain(W, H, ".", [
          { ch: "#", x: 10, y: 0, w: 2, h: 6 },
          { ch: "~", x: 14, y: 9, w: 4, h: 2 },
        ]),
    )
    spawnMirrored(ctx, W, H, types, [
      { type: "base", owner: 0, x: 2, y: 2 },
      { type: "barracks", owner: 0, x: 7, y: 5 },
      { type: "worker", owner: 0, x: 5, y: 2 },
      { type: "worker", owner: 0, x: 5, y: 3 },
      { type: "worker", owner: 0, x: 5, y: 4 },
      { type: "goldmine", owner: -1, x: 1, y: 7 },
      { type: "goldmine", owner: -1, x: 3, y: 7 },
    ])
    if (map) for (const m of map.mines) ctx.spawn("goldmine", -1, m.x, m.y, { amount: 800 })
    else spawnMirrored(ctx, W, H, types, [{ type: "goldmine", owner: -1, x: 14, y: 5, amount: 800 }])
    for (let p = 0; p < ctx.playerCount; p++) ctx.setResources(p, { gold: 100 })
  },

  onTick(ctx) {
    // 分数就是累计交了多少金
    for (const ev of ctx.events) if (ev.kind === "deposit") ctx.addScore(ev.player, ev.amount)
    ctx.setStatus(\`交货 \${ctx.players.map((p) => p.score).join(" : ")}（先到 \${TARGET}）\`)
  },

  objectives(ctx, player): Objectives {
    return {
      target: TARGET,
      delivered: ctx.players.map((p) => p.score),
      enemyBases: baseStarts(W, H).filter((b) => b.owner !== player),
    }
  },

  result(ctx) {
    const lost = ctx.players.filter((p) => !hasBase(ctx, p.id))
    if (lost.length === 2) return { winner: null, reason: "双方主基地同时被摧毁" }
    if (lost.length === 1) return { winner: 1 - lost[0].id, reason: "摧毁了对方的主基地" }
    const done = ctx.players.filter((p) => p.score >= TARGET)
    if (done.length === 2) return { winner: null, reason: \`同时交够 \${TARGET} 金\` }
    if (done.length === 1) return { winner: done[0].id, reason: \`先交够 \${TARGET} 金\` }
    return null
  },

  timeUp(ctx) {
    const [a, b] = ctx.players
    if (a.score === b.score) return { winner: null, reason: \`时间到，交货一样多（\${a.score}）\` }
    return { winner: a.score > b.score ? 0 : 1, reason: \`时间到，交货 \${a.score} : \${b.score}\` }
  },
}

export default ruleset
`

const OBJECTIVES = `// 给 bot 的目标信息（这个文件也会原样进 bot 作者的 arena.d.ts）

export interface Objectives {
  /** 先累计交够这么多金的赢 */
  target: number
  /** 每个玩家累计交了多少金，下标是玩家编号 */
  delivered: number[]
  /** 对手主基地开局时的左上角坐标（主基地 3×3，不会移动） */
  enemyBases: { owner: number; x: number; y: number }[]
}
`

const RULES = `两人对战，比谁先采够金子。双方各有一个主基地（base）、一个兵营（barracks）、3 个工人和 100 金；家门口 2 个金矿（每个 400），往中间走各有一个大金矿（800）。金矿的位置和剩余量整局都看得见。

**胜利条件**：先累计交够 600 金（交到主基地才算，花掉的也算交过）。摧毁对方的主基地直接获胜。

**时间上限**：4000 tick 还没分出胜负，比累计交货量，多的赢，一样算平局。

**分数**：\`view.players[i].score\` 就是累计交货量。

**目标信息** \`view.objectives\`：

- \`target\`：要交够多少金。
- \`delivered\`：每个玩家累计交了多少金，下标是玩家编号。
- \`enemyBases\`：对手主基地开局时的左上角坐标。
`

// 参考 bot：基准 + 两个不同打法的陪练（第一行注释是打法说明，会列进 PROMPT.md）
export const RUSH = `// 速攻：只留 3 个工人采矿，兵营一直出战士，凑够 4 个就去拆对方主基地（拆掉直接赢），之后新出的兵直接跟上。

let attacking = false

function nearest<T extends Pos>(from: Pos, list: T[]): T | undefined {
  let best: T | undefined
  let bestD = Infinity
  for (const e of list) {
    const d = dist(from, e)
    if (d < bestD) {
      best = e
      bestD = d
    }
  }
  return best
}

export function onTick(view: View, cmd: Commands): void {
  const mine = view.entities.filter((e) => e.owner === view.me)
  const base = mine.find((e) => e.type === "base")
  if (!base) return
  const barracks = mine.find((e) => e.type === "barracks")
  const workers = mine.filter((e) => e.type === "worker")
  const soldiers = mine.filter((e) => e.type === "soldier")
  const mines = view.entities.filter((e) => e.type === "goldmine")
  for (const w of workers) if (w.order?.kind !== "gather") {
    const m = nearest(base, mines)
    if (m) cmd.gather(w, m)
  }
  if (barracks && (barracks.queue?.length ?? 0) < 2 && view.resources.gold >= 75) cmd.produce(barracks, "soldier")

  if (soldiers.length >= 4) attacking = true
  const eb = view.objectives.enemyBases[0]
  const enemyBase = view.entities.find((e) => e.type === "base" && e.owner >= 0 && e.owner !== view.me)
  for (const s of soldiers) {
    if (!attacking) continue
    if (enemyBase && dist(s, enemyBase) <= 6) {
      if (s.order?.kind !== "attack") cmd.attack(s, enemyBase)
    } else if (s.order?.kind === "idle") cmd.attackMove(s, eb.x + 1, eb.y + 1)
  }
}
`

export const GREEDY = `// 只采不打：主基地一直补工人到 10 个，每个金矿最多 3 人，全力抢着交够金子；一个兵都不出。

function nearest<T extends Pos>(from: Pos, list: T[]): T | undefined {
  let best: T | undefined
  let bestD = Infinity
  for (const e of list) {
    const d = dist(from, e)
    if (d < bestD) {
      best = e
      bestD = d
    }
  }
  return best
}

export function onTick(view: View, cmd: Commands): void {
  const mine = view.entities.filter((e) => e.owner === view.me)
  const base = mine.find((e) => e.type === "base")
  if (!base) return
  const workers = mine.filter((e) => e.type === "worker")
  const mines = view.entities.filter((e) => e.type === "goldmine")
  if ((base.queue?.length ?? 0) === 0 && workers.length < 10 && view.resources.gold >= 50) cmd.produce(base, "worker")
  const load = new Map<number, number>()
  for (const w of workers) if (w.order?.kind === "gather") load.set(w.order.target, (load.get(w.order.target) ?? 0) + 1)
  for (const w of workers) {
    if (w.order?.kind === "gather") continue
    const open = mines.filter((m) => (load.get(m.id) ?? 0) < 3)
    const m = nearest(base, open.length ? open : mines)
    if (!m) continue
    cmd.gather(w, m)
    load.set(m.id, (load.get(m.id) ?? 0) + 1)
  }
}
`

export const BASELINE = `// 基准（均衡）：工人补到 8 个，每个金矿最多 3 人；兵营出战士守家，攒够 6 个去拆对方主基地。

function nearest<T extends Pos>(from: Pos, list: T[]): T | undefined {
  let best: T | undefined
  let bestD = Infinity
  for (const e of list) {
    const d = dist(from, e)
    if (d < bestD) {
      best = e
      bestD = d
    }
  }
  return best
}

export function onTick(view: View, cmd: Commands): void {
  const mine = view.entities.filter((e) => e.owner === view.me)
  const base = mine.find((e) => e.type === "base")
  if (!base) return
  const barracks = mine.find((e) => e.type === "barracks")
  const workers = mine.filter((e) => e.type === "worker")
  const soldiers = mine.filter((e) => e.type === "soldier")
  const mines = view.entities.filter((e) => e.type === "goldmine")
  const enemies = view.entities.filter((e) => e.owner >= 0 && e.owner !== view.me)
  let gold = view.resources.gold

  if ((base.queue?.length ?? 0) === 0 && workers.length < 8 && gold >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }
  if (barracks && (barracks.queue?.length ?? 0) === 0 && workers.length >= 6 && gold >= 75) cmd.produce(barracks, "soldier")

  // 工人：没在采的去人少、离家近的金矿
  const load = new Map<number, number>()
  for (const w of workers) if (w.order?.kind === "gather") load.set(w.order.target, (load.get(w.order.target) ?? 0) + 1)
  for (const w of workers) {
    if (w.order?.kind === "gather" && mines.some((m) => m.id === (w.order as { target: number }).target)) continue
    const open = mines.filter((m) => (load.get(m.id) ?? 0) < 3)
    const m = nearest(base, open)
    if (!m) continue
    cmd.gather(w, m)
    load.set(m.id, (load.get(m.id) ?? 0) + 1)
  }

  // 战士：家附近有敌人就打，攒够 6 个去对方主基地
  const threat = enemies.find((e) => dist(e, base) <= 10)
  const eb = view.objectives.enemyBases[0]
  for (const s of soldiers) {
    if (threat) cmd.attack(s, threat)
    else if (soldiers.length >= 6 && s.order?.kind === "idle") cmd.attackMove(s, eb.x + 1, eb.y + 1)
  }
}
`

/** 目录名变成规则包 id：小写字母开头，只含小写字母、数字、_、-；和平台自带的重名就加后缀 */
function idFrom(dir: string, builtin: string[]): string {
  let id = basename(resolve(dir))
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 28)
  if (!id) id = "my-rules"
  if (builtin.includes(id)) id = `${id}-mine`
  return id
}

const API_HEAD = (what: string) =>
  `// ${what}\n// 这是平台接口的只读副本，查字段、函数签名用；由 rts-arena new-rules 生成，平台升级后对这个目录再运行一次 new-rules 刷新。\n// 规则包代码照常写 import type { ... } from "rts-arena/ruleset"、import { ... } from "rts-arena/standard"，不要直接改这里。\n\n`

/**
 * 写规则包目录里平台提供的文件：接口副本 api/、写法说明 RULESET.md、tsconfig.json、bots/ 的 arena.d.ts 和 tsconfig.json。
 * 规则包自己的文件（index.ts、objectives.ts、RULES.md、bots/*.ts）不动
 */
async function writePlatformFiles(dir: string): Promise<void> {
  const api = join(dir, "api")
  mkdirSync(api, { recursive: true })
  mkdirSync(join(dir, "bots"), { recursive: true })
  const read = (...p: string[]) => readFileSync(join(PKG_ROOT, ...p), "utf8")
  writeFileSync(join(api, "ruleset.ts"), API_HEAD('"rts-arena/ruleset"：规则包对象 Ruleset、ctx（SetupContext、RuleContext）、实体类型 TypeSpec、实体、事件、叠加层、结果') + read("src", "core", "types.ts").replace('from "../api/bot-api.ts"', 'from "./bot-api.ts"'))
  writeFileSync(join(api, "bot-api.ts"), API_HEAD("bot 接口（TypeDef、命令、事件等，ruleset.ts 引用了其中的类型）") + read("src", "api", "bot-api.ts"))
  writeFileSync(join(api, "standard.ts"), API_HEAD('"rts-arena/standard"：几个规则包共用的标准单位、地形、对称地图工具') + read("rulesets", "common", "standard.ts").replace('from "../../src/core/types.ts"', 'from "./ruleset.ts"'))
  writeFileSync(join(api, "globals.d.ts"), RULES_GLOBALS_DTS)
  writeFileSync(join(dir, "RULESET.md"), read("src", "api", "RULESET.md"))
  // 编辑器用目录里的副本，整个目录拷到别处也能用；rts-arena check 用平台自己的文件检查
  writeFileSync(join(dir, "tsconfig.json"), rulesTsconfig(["index.ts", "api/globals.d.ts"], { ruleset: "./api/ruleset.ts", standard: "./api/standard.ts" }))
  // bots/ 里的 bot 用的接口（和 init 给 bot 目录生成的 arena.d.ts 一样）
  try {
    const rules = await loadSandboxedRuleset(dir, { onLog: () => {} })
    writeFileSync(join(dir, "bots", "arena.d.ts"), buildDts(rules, dir))
    writeFileSync(
      join(dir, "bots", "tsconfig.json"),
      JSON.stringify({ compilerOptions: { target: "ES2022", lib: ["ES2022"], types: [], strict: true, noEmit: true, erasableSyntaxOnly: true, module: "preserve", moduleDetection: "force" }, include: ["*.ts"] }, null, 2),
    )
  } catch (e) {
    console.log(`（规则包现在加载不了，bots/arena.d.ts 没生成：${(e as Error).message.split("\n")[0]}；改好后再运行一次 new-rules ${dir}）`)
  }
}

export async function writeRulesTemplate(dir: string, builtin: string[]): Promise<void> {
  // 已经是规则包目录：只刷新平台提供的文件
  if (existsSync(join(dir, "index.ts"))) {
    await writePlatformFiles(dir)
    console.log(`已刷新 ${dir} 里平台提供的文件：api/（接口副本）、RULESET.md、tsconfig.json、bots/arena.d.ts；index.ts 等你写的文件没动`)
    return
  }
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`${dir} 不是空目录，也不是规则包目录（没有 index.ts）；换一个新目录名`)
  mkdirSync(join(dir, "bots"), { recursive: true })
  const id = idFrom(dir, builtin)
  writeFileSync(join(dir, "index.ts"), INDEX.replace("__ID__", id))
  writeFileSync(join(dir, "objectives.ts"), OBJECTIVES)
  writeFileSync(join(dir, "RULES.md"), RULES)
  writeFileSync(join(dir, "bots", "baseline.ts"), BASELINE)
  writeFileSync(join(dir, "bots", "rush.ts"), RUSH)
  writeFileSync(join(dir, "bots", "greedy.ts"), GREEDY)
  writeFileSync(join(dir, ".gitignore"), "replays/\n")
  await writePlatformFiles(dir)
  console.log(`已在 ${dir} 建好示例规则包「采金赛」（id：${id}）。先读 RULESET.md，改 index.ts、objectives.ts、RULES.md，然后：`)
  console.log(`  rts-arena check ${dir}                       检查规则包`)
  console.log(`  rts-arena run ${dir} baseline baseline       用基准 bot 打一局`)
  console.log(`  rts-arena league ${dir} baseline rush greedy  参考 bot 循环对打（bots/ 里的都会列进 PROMPT.md，改玩法后照着写几个不同打法的）`)
  console.log(`  rts-arena init ${dir} <bot 目录>             给它建一个 bot 目录`)
  console.log(`接口的字段和函数签名在 ${dir}/api/ 里（ruleset.ts、standard.ts）。平台升级后对这个目录再运行一次 new-rules 刷新它们`)
}
