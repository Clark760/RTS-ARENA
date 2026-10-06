// rts-arena new-rules <目录>：建一个能直接跑的示例规则包（采金赛），自己写规则包从它改起
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { PKG_ROOT } from "../paths.ts"
import { rulesTsconfig } from "./docgen.ts"

const INDEX = `// 示例规则包「采金赛」：先累计交够 600 金的赢；主基地被摧毁直接输；到时间比交货量。从这里改起。
// 写法见同目录的 RULESET.md。类型从 "rts-arena/ruleset" 导入（import type），共用的单位和地图工具从 "rts-arena/standard" 导入。
import type { RuleContext, Ruleset } from "rts-arena/ruleset"
import { baseStarts, spawnMirrored, STANDARD_TERRAIN, standardTypes, symmetricTerrain } from "rts-arena/standard"
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
    // 左上角是玩家 0，右下角中心对称处是玩家 1
    ctx.setTerrain(
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
      { type: "goldmine", owner: -1, x: 14, y: 5, amount: 800 },
    ])
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

const BASELINE = `// 「采金赛」的基准 bot：工人补到 8 个，每个金矿最多 3 人；兵营出战士守家，攒够 6 个去拆对方主基地。

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

export function writeRulesTemplate(dir: string, builtin: string[]): void {
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`${dir} 不是空目录；换一个新目录名`)
  mkdirSync(join(dir, "bots"), { recursive: true })
  const id = idFrom(dir, builtin)
  writeFileSync(join(dir, "index.ts"), INDEX.replace("__ID__", id))
  writeFileSync(join(dir, "objectives.ts"), OBJECTIVES)
  writeFileSync(join(dir, "RULES.md"), RULES)
  writeFileSync(join(dir, "bots", "baseline.ts"), BASELINE)
  writeFileSync(join(dir, "RULESET.md"), readFileSync(join(PKG_ROOT, "src", "api", "RULESET.md"), "utf8"))
  writeFileSync(join(dir, "tsconfig.json"), rulesTsconfig(["index.ts"]))
  writeFileSync(join(dir, ".gitignore"), "replays/\n")
  console.log(`已在 ${dir} 建好示例规则包「采金赛」（id：${id}）。先读 RULESET.md，改 index.ts、objectives.ts、RULES.md，然后：`)
  console.log(`  rts-arena check ${dir}                       检查规则包`)
  console.log(`  rts-arena run ${dir} baseline baseline       用基准 bot 打一局`)
  console.log(`  rts-arena init ${dir} <bot 目录>             给它建一个 bot 目录`)
}
