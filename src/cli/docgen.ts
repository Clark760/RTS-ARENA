// 生成发给 bot 作者的 arena.d.ts 和 PROMPT.md（Node 端）
import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { resolveType, World } from "../core/world.ts"
import type { EntityState, Ruleset } from "../core/types.ts"
import { PKG_ROOT } from "../paths.ts"
import { referenceBots } from "./catalog.ts"

/** 平台自带规则包的目录（RULES.md、objectives.ts 在这里）；别的规则包的目录由调用方给 */
export function rulesetDir(id: string): string {
  return join(PKG_ROOT, "rulesets", id)
}

/** 去掉行首的 export，让类型成为全局声明 */
function ambient(src: string): string {
  return src.replace(/^export\s+/gm, "")
}

function literalUnion(names: string[]): string {
  return names.length === 0 ? "never" : names.map((n) => JSON.stringify(n)).join(" | ")
}

/** dir 是规则包目录（读它的 objectives.ts） */
export function buildDts(rules: Ruleset, dir: string): string {
  const api = readFileSync(join(PKG_ROOT, "src", "api", "bot-api.ts"), "utf8")
  const globals = readFileSync(join(PKG_ROOT, "src", "api", "bot-globals.d.ts"), "utf8")
  const objPath = join(dir, "objectives.ts")
  if (!existsSync(objPath)) throw new Error(`规则包 ${rules.id} 缺少 objectives.ts`)
  const objectives = readFileSync(objPath, "utf8")
  if (!/\b(interface|type)\s+Objectives\b/.test(objectives)) throw new Error(`${objPath} 里要定义 Objectives`)

  const start = api.indexOf("// #region 规则包类型")
  const end = api.indexOf("// #endregion")
  if (start < 0 || end < 0) throw new Error("bot-api.ts 缺少规则包类型区块标记")
  const ruleTypes = [
    `// ---------- 规则包「${rules.name}」（${rules.id}）的类型 ----------`,
    `/** 实体类型名 */`,
    `type TypeName = ${literalUnion(Object.keys(rules.types))}`,
    `/** 资源名 */`,
    `type ResourceName = ${literalUnion(rules.resources)}`,
    "",
    ambient(objectives.replace(/^\/\/.*\n/gm, "")).trim(),
    "",
  ].join("\n")
  const body = api.slice(0, start) + ruleTypes + api.slice(end + "// #endregion".length)
  // 删掉文件开头给引擎开发者看的注释
  const cleaned = ambient(body).replace(/^(\/\/.*\n)+/, "")
  return [
    `// arena.d.ts —— 规则包「${rules.name}」（${rules.id}）的 bot 接口。由 arena docs 生成，不要手改。`,
    "// 这些类型和函数都是全局的，bot 文件里直接用，不需要 import。",
    "",
    cleaned.trim(),
    "",
    "// ---------- 沙箱里的全局变量和函数 ----------",
    globals.replace(/^\/\/.*\n/gm, "").trim(),
    "",
  ].join("\n")
}

function costText(cost: Partial<Record<string, number>>): string {
  const parts = Object.entries(cost).map(([r, n]) => `${n} ${r}`)
  return parts.length ? parts.join(" + ") : "—"
}

/** 克制倍数（D-166）：「（打 cavalry ×3）」 */
function vsText(vs: Partial<Record<string, number>> | undefined): string {
  const parts = Object.entries(vs ?? {}).map(([t, m]) => `${t} ×${m}`)
  return parts.length ? `（打 ${parts.join("、")}）` : ""
}

export function unitTable(rules: Ruleset): string {
  const defs = Object.entries(rules.types).map(([name, spec]) => ({ spec, d: resolveType(name, spec) }))
  // 有能建造的单位时才加「能建造」一列
  const building = defs.some(({ d }) => d.builds.length > 0)
  const rows = [
    `| 类型 | 种类 | 占地 | 生命 | 造价 | ${building ? "生产用时 / 建造工作量" : "生产用时"} | 走一格 | 视野 | 攻击（伤害/射程/冷却） | 采集（每次量/用时/容量） | 交货点 | 能生产 |${building ? " 能建造 |" : ""}`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|${building ? "---|" : ""}`,
  ]
  const kindText = { unit: "单位", building: "建筑", resource: "资源点" }
  const buildable = new Set(defs.flatMap(({ d }) => d.builds))
  for (const { spec, d } of defs) {
    const name = d.name
    const res = d.kind === "resource" ? `（产 ${d.resource}，默认储量 ${spec.amount ?? 0}，地图上每个的实际储量见下面的地图）` : ""
    rows.push(
      [
        "",
        `\`${name}\`${res}`,
        kindText[d.kind],
        `${d.w}×${d.h}`,
        d.kind === "resource" ? "—" : d.maxHp > 0 ? d.maxHp : "无敌",
        costText(d.cost),
        d.buildTicks || "—",
        d.moveTicks || "不能动",
        d.sight || "—",
        d.attack ? `${d.attack.damage} / ${d.attack.range} / ${d.attack.cooldown}${vsText(d.attack.vs)}` : "—",
        d.gather ? `${d.gather.amount} / ${d.gather.ticks} / ${d.gather.capacity}` : "—",
        d.dropOff ? "是" : "—",
        d.produces.length ? d.produces.join("、") : "—",
        ...(building ? [d.builds.length ? d.builds.join("、") : "—"] : []),
        "",
      ].join(" | ").trim(),
    )
  }
  if (defs.some(({ d }) => d.attack?.vs)) {
    rows.push("", "攻击一列括号里是**克制倍数**（`game.types[类型].attack.vs`）：打这些类型时伤害乘这个倍数，四舍五入。比如「打 cavalry ×3」是打 cavalry 一下的伤害是 damage × 3（倍数小于 1 就是打这类吃亏）。")
  }
  if (building) {
    const names = [...buildable].map((n) => "`" + n + "`").join("、")
    rows.push("", `能被建造的建筑（${names}）的「建造工作量」：一个工人贴着地基每 tick 干 1，几个工人一起建按人数加快。`)
  }
  return rows.join("\n")
}

/**
 * 开局地图：用最少人数跑一遍规则包的 setup，画成带坐标的字符图，再列出资源点和各家开局的实体。
 * 开局由规则包决定，可能和种子、人数有关，这里画的是种子 1、最少人数时的样子
 */
/** 跑一次规则包的 setup（默认种子 1），返回开局的局面；setup 出错就抛出 */
export function setupWorld(rules: Ruleset, n: number, teams?: number[], seed = 1): World {
  const w = new World(
    rules,
    [...Array(n).keys()].map((i) => `P${i}`),
    seed,
    teams,
  )
  try {
    rules.setup(w)
  } finally {
    rules.release?.()
  }
  return w
}

/** 规则包能打的各种人数（和分队）：check 和说明书都用 */
export function lineups(rules: Ruleset): { label: string; n: number; teams?: number[] }[] {
  const out: { label: string; n: number; teams?: number[] }[] = []
  for (let n = Math.max(1, rules.players.min); n <= rules.players.max; n++) out.push({ label: `${n} 人`, n })
  if (rules.teams && rules.players.min <= 3 && rules.players.max >= 3) out.push({ label: "分队 2v1（P0、P1 一队，P2 一队）", n: 3, teams: [0, 0, 1] })
  if (rules.teams && rules.players.min <= 4 && rules.players.max >= 4) out.push({ label: "分队 2v2（P0、P1 一队，P2、P3 一队）", n: 4, teams: [0, 0, 1, 1] })
  return out
}

/**
 * 地图会不会随种子变：比几个种子的开局。不变返回 null；会变就说清楚哪些每局一样、哪些每局不同，提醒别把坐标写死
 */
export function mapVariety(rules: Ruleset, n: number, id = rules.id, seed = 1): string | null {
  let worlds: World[]
  try {
    worlds = [1, 2, 3, 4, 5, 6].map((s) => setupWorld(rules, n, undefined, s))
  } catch {
    return null
  }
  const terrainVaries = worlds.some((w) => w.terrain.join("\n") !== worlds[0].terrain.join("\n"))
  const keysOf = (w: World, pick: (e: ReturnType<World["entities"]>[number]) => boolean) =>
    new Set(w.entities().filter(pick).map((e) => `${e.type}@${e.x},${e.y}@${e.owner}`))
  const fixedIn = (pick: (e: ReturnType<World["entities"]>[number]) => boolean) => {
    const sets = worlds.map((w) => keysOf(w, pick))
    const fixed = [...sets[0]].filter((k) => sets.every((s) => s.has(k))).length
    return { fixed, total: sets[0].size, varies: sets.some((s) => s.size !== sets[0].size) || fixed < sets[0].size }
  }
  const res = fixedIn((e) => e.def.kind === "resource")
  const own = fixedIn((e) => e.def.kind !== "resource" && e.owner >= 0)
  const neutral = fixedIn((e) => e.def.kind !== "resource" && e.owner < 0)
  if (!terrainVaries && !res.varies && !own.varies && !neutral.varies) return null
  const same: string[] = []
  const diff: string[] = []
  if (!own.varies) same.push("各家开局的建筑和单位")
  else diff.push("各家开局的建筑和单位的位置")
  if (res.fixed) same.push(`${res.fixed} 个资源点${res.varies ? "（每局位置不变的那些，不一定都在家门口）" : ""}`)
  if (res.varies) diff.push(res.fixed ? `其余 ${res.total - res.fixed} 个资源点的位置` : "资源点的位置")
  if (terrainVaries) diff.push("墙、水这些地形")
  if (neutral.varies) diff.push("中立单位的位置")
  return [
    `**这个规则包的地图每局按种子随机生成**：每局的种子不一样，地图也不一样；规则包保证地图对称（两人图中心对称，多人图四个角转 90° 一样），每家看到的地图相同，联赛里同一张图会换座位各打一次。下面画的只是种子 ${seed} 的一张。`,
    "",
    `- 每局都一样的：${same.length ? same.join("、") : "没有"}`,
    `- 每局不同的：${diff.join("、")}`,
    "",
    `别把会变的坐标写死：开局从 \`game.terrain\` 读地形、从 \`view.entities\` 找资源点，路线、集结点、建筑位置都按当局的地图算。看别的种子的地图：\`rts-arena map ${id} --seed 2\`。`,
  ].join("\n")
}

export function mapSection(rules: Ruleset, seed = 1, id = rules.id): string {
  const n = rules.players.min
  let w: World
  try {
    w = setupWorld(rules, n, undefined, seed)
  } catch (e) {
    return `## 地图\n\n（画不出来：规则包的 setup 出错了：${(e as Error).message.split("\n")[0]}）`
  }
  const W = w.width
  const H = w.height
  const ents = w.entities()
  const out = [`## 开局地图（${n} 人、种子 ${seed} 时的样子；${W}×${H}，左上角是 (0, 0)，x 向右、y 向下）`, ""]
  const variety = mapVariety(rules, n, id, seed)
  if (variety) out.push(variety, "")
  if (W * H <= 20_000) {
    const g = w.terrain.map((row) => row.split(""))
    for (const e of ents) {
      const ch = e.def.kind === "resource" ? "$" : e.owner < 0 ? "n" : e.def.kind === "unit" ? String.fromCharCode(97 + e.owner) : String.fromCharCode(65 + e.owner)
      for (let y = e.y; y < e.y + e.h; y++) for (let x = e.x; x < e.x + e.w; x++) g[y][x] = ch
    }
    const tens = "    " + [...Array(W).keys()].map((x) => (x % 10 === 0 ? String(Math.floor(x / 10) % 10) : " ")).join("")
    const ones = "    " + [...Array(W).keys()].map((x) => String(x % 10)).join("")
    out.push("```", tens, ones, ...g.map((row, y) => String(y).padStart(3) + " " + row.join("")), "```", "")
    const terrain = Object.entries(rules.terrain)
      .map(([ch, t]) => `\`${ch}\` ${t.walkable ? "能走" : "不能走"}`)
      .join("，")
    out.push(`图例：${terrain}；\`$\` 资源点；大写字母是建筑（A 是 P0 的、B 是 P1 的……），小写字母是单位（a 是 P0 的……），\`n\` 是中立的非资源实体。`, "")
  } else out.push("（地图太大，不画字符图，只列实体）", "")
  const resources = ents.filter((e) => e.def.kind === "resource")
  if (resources.length) out.push(...resourceGroups(resources, ents, n), "")
  for (let p = -1; p < n; p++) {
    const mine = ents.filter((e) => e.owner === p && e.def.kind !== "resource")
    if (!mine.length) continue
    const byType = new Map<string, string[]>()
    for (const e of mine) byType.set(e.type, [...(byType.get(e.type) ?? []), `(${e.x}, ${e.y})`])
    out.push(`${p < 0 ? "中立" : `P${p}`}：${[...byType].map(([t, at]) => `${t} ${at.join(" ")}`).join("；")}`)
  }
  // 别的人数、分队时，各座位从哪里开始（地图只画了最少人数的）
  const others = lineups(rules).filter((l) => l.n !== n || l.teams)
  if (others.length) {
    out.push("", "其他人数、分队时各座位的开局位置（每个玩家第一个建筑的左上角，没有建筑就是第一个单位）：")
    for (const l of others) {
      try {
        const ow = setupWorld(rules, l.n, l.teams)
        const seat = (p: number) => {
          const own = ow.entities({ owner: p })
          const e = own.find((x) => x.def.kind === "building") ?? own[0]
          return e ? `P${p} ${e.type} (${e.x}, ${e.y})` : `P${p} 没有实体`
        }
        out.push(`- ${l.label}：${[...Array(l.n).keys()].map(seat).join("，")}`)
      } catch (e) {
        out.push(`- ${l.label}：setup 出错了（${(e as Error).message.split("\n")[0]}）`)
      }
    }
  }
  if (w.markers.length) {
    out.push("", "开局的标记（规则包画在地图上的区域和文字，回放里看得到）：")
    for (const m of w.markers) {
      const who = (o: number | null | undefined) => (o === null || o === undefined || o < 0 ? "" : `，属于 P${o}`)
      out.push(m.kind === "zone" ? `- 区域 (${m.x}, ${m.y}) ${m.w}×${m.h}${m.label ? ` 「${m.label}」` : ""}${who(m.owner)}` : `- 文字 (${m.x}, ${m.y})「${m.text}」${who(m.owner)}`)
    }
  }
  out.push("", "你不一定是 P0：开局看 `view.me` 和自己实体的位置。建筑的坐标是占地左上角。")
  return out.join("\n")
}

/** 资源点按挨着的（3 格以内）分成几片，每片标出离谁近 */
function resourceGroups(resources: readonly EntityState[], ents: readonly EntityState[], n: number): string[] {
  const parent = resources.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const gap = (a: EntityState, b: EntityState) => Math.max(0, a.x - (b.x + b.w - 1), b.x - (a.x + a.w - 1)) + Math.max(0, a.y - (b.y + b.h - 1), b.y - (a.y + a.h - 1))
  for (let i = 0; i < resources.length; i++) for (let j = 0; j < i; j++) if (gap(resources[i], resources[j]) <= 3) parent[find(i)] = find(j)
  const groups = new Map<number, EntityState[]>()
  resources.forEach((e, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), e]))
  // 每个玩家的"家"：他的建筑（没有建筑就用他的单位）
  const home = [...Array(n).keys()].map((p) => {
    const own = ents.filter((e) => e.owner === p && e.def.kind !== "resource")
    const base = own.filter((e) => e.def.kind === "building")
    return base.length ? base : own
  })
  const out = [`资源点（${resources.length} 个，按挨在一起的分成 ${groups.size} 片；距离是这片里最近的资源点到各家最近的建筑，按占地算，和 dist() 一样）：`]
  for (const g of groups.values()) {
    const d = home.map((h) => (h.length ? Math.min(...g.flatMap((r) => h.map((b) => gap(r, b)))) : null))
    const known = d.map((v, p) => ({ v, p })).filter((x): x is { v: number; p: number } => x.v !== null).sort((a, b) => a.v - b.v)
    const where =
      known.length === 0
        ? ""
        : known.length === 1 || known[0].v * 1.5 < known[1].v
          ? `靠近 P${known[0].p}`
          : known[known.length - 1].v <= known[0].v * 1.5
            ? known[known.length - 1].v - known[0].v <= 2
              ? "中间（各家差不多远）"
              : `中间偏 P${known[0].p}`
            : `在 ${known.filter((x) => x.v <= known[0].v * 1.5).map((x) => `P${x.p}`).join("、")} 之间`
    const total = g.reduce((a, e) => a + e.amount, 0)
    const dist = known.length ? `，距离 ${[...Array(n).keys()].map((p) => (d[p] === null ? "" : `P${p} ${d[p]}`)).filter(Boolean).join("、")}` : ""
    out.push(`- ${where}${dist}：${g.map((e) => `${e.type} (${e.x}, ${e.y}) 储量 ${e.amount}`).join("；")}${g.length > 1 ? `（共 ${total}）` : ""}`)
  }
  return out
}

/** 参考 bot：和规则包一起发布，每个写 bot 的人拿到的都一样，名字和打法都列出来 */
function botsSection(dir: string): string {
  const bots = referenceBots(dir)
  const rows = bots.map((b) => `| \`${b.name}\` | ${(b.about || "（没写打法说明）").replace(/\|/g, "/")} |`)
  return [
    "## 参考 bot（陪练对手）",
    "",
    "这些 bot 和规则包一起发布，每个写 bot 的人拿到的都一样。命令里直接写名字就能和它打，比如 `rts-arena run " + (bots.find((b) => b.name !== "baseline" && b.name !== "idle")?.name ?? "baseline") + "`；`rts-arena league` 不写对手就和下面所有的（不含 idle）循环对打。",
    "",
    "| 名字 | 打法 |",
    "|---|---|",
    ...rows,
    "",
    "- `baseline` 是基准（这个规则包的标准对手），先打赢它。但只对着一个对手调出来的 bot 容易过拟合（专门克制它的打法，换个对手就输），每改一版都用 `rts-arena league` 和所有参考 bot 打一遍，看总的得分率，别只看对 baseline 的胜率。",
    "- 想要别的打法当陪练，可以自己再写几个（比如照着你担心的打法写），和参考 bot 一起放进联赛。",
    "- 参考 bot 的源码随规则包发布，在规则包目录的 `bots/` 里（平台自带的规则包在 rts-arena 安装目录的 `rulesets/<规则包>/bots/`）。",
  ].join("\n")
}

/** 谁能建造什么；没有能建造的单位时直接说，免得 bot 作者去试 */
function buildersLine(rules: Ruleset): string {
  const list = Object.entries(rules.types)
    .filter(([, t]) => (t.builds ?? []).length > 0)
    .map(([k, t]) => `${k} 能建 ${(t.builds ?? []).join("、")}`)
  return list.length ? `- 建造：${list.join("；")}（见平台通用说明的「建造」）` : "- 建造：这个规则包没有能建造的单位，cmd.build 用不上（平台通用说明里的「建造」一节可以跳过）"
}

/**
 * 说明书开头的"必须自己跑对战"：有的 agent 只写代码、不执行命令，交上来的 bot 从没打过一局。
 * 放在最前面，写成固定的工作循环，并要求交付时报告跑过的命令和结果
 */
const RUN_FIRST = [
  "## 最重要：写完必须自己跑对战",
  "",
  '**每改一版 bot，都要在这个 bot 目录里执行命令、真的打几局，看结果再改。** 你能执行命令（终端、Bash、shell 工具）就一定要用，不要只读代码、凭推断觉得"应该能赢"——没打过的 bot 几乎都有没发现的问题：命令被拒、工人闲着、单位卡在墙边、连最简单的对手都打不过。',
  "",
  "每一版按这个顺序跑：",
  "",
  "```bash",
  "rts-arena check                    # 1. 类型检查 + 在每个位置试打（每个位置一张不同的地图）；有报错、被拒命令先修",
  "rts-arena run --games 10 --quiet   # 2. 和基准 bot 打 10 局，看胜率",
  "rts-arena league                   # 3. 和所有参考 bot 循环对打，看总的得分率、输给了谁",
  "rts-arena report                   # 4. 看最新一局的战报；输的局重点看最后的「可能的问题」",
  "```",
  "",
  "- 命令的输出就是改 bot 的依据：报错和被拒命令、战报里的「可能的问题」、联赛里输给了谁。改完再从第 1 步跑起。",
  "- 局数少时胜率的误差很大（`run` 和 `league` 都会给 95% 区间，区间盖住 50% 就还分不出高下）。想确认新的一版是不是真的更强：改之前把旧版另存一份（比如 `versions/v3.ts`），改完跑 `rts-arena compare versions/v3.ts`——两个版本对每个参考 bot 用同一批种子、坐同一个位置各打一局，按组配对比，直接告诉你分不分得出高下，只存两个版本结果不一样的局的回放（同一张图一个赢一个输，对着看最有用）。默认每个对手 10 组，差距小时加 `--per-pair 30`；两个版本每组结果都一样的对手，下次可以不带。跑很多局时加 `--no-replays` 不存回放，省硬盘。",
  "- 只想看开局、经济（比如到第 1500 tick 采了多少）：`rts-arena run --ticks 1500` 打到那一刻就结束。",
  '- 交付时写清楚：跑了哪些命令、最后一版的联赛得分率、对每个参考 bot 的胜负。**没跑过对战，就不要说"测试通过"或"应该能赢"。**',
  "- 提示找不到 `rts-arena` 命令时，先问用户平台装在哪、怎么运行，不要跳过这一步。",
  '- 实在没法执行命令（环境不允许）时，直接告诉用户："我这里不能运行命令，请你在 bot 目录里运行 `rts-arena league`，把输出贴给我。"拿到结果再改。',
].join("\n")

export function buildPrompt(rules: Ruleset, dir: string, dts: string): string {
  const rulesMd = readFileSync(join(dir, "RULES.md"), "utf8").trim()
  const platform = readFileSync(join(PKG_ROOT, "src", "api", "PLATFORM.md"), "utf8").trim()
  const terrain = Object.entries(rules.terrain)
    .map(([ch, t]) => `\`${ch}\` ${t.walkable ? "可通行" : "不可通行"}`)
    .join("，")
  const params = [
    `- 玩家数：${rules.players.min === rules.players.max ? rules.players.min : `${rules.players.min}~${rules.players.max}`}`,
    `- 一局最多 ${rules.maxTicks} tick（回放里每秒 ${rules.tickRate} tick）`,
    `- 每 ${rules.decisionInterval} tick 调用一次 onTick，每次燃料上限 ${rules.fuel}`,
    `- 每个玩家单位上限：${rules.unitCap > 0 ? `${rules.unitCap}（含生产队列）` : "不限"}`,
    `- 战争迷雾：${rules.fog ? "有" : "无"}`,
    `- 资源：${rules.resources.join("、")}`,
    `- 地形：${terrain}`,
    buildersLine(rules),
  ].join("\n")
  return [
    `# 「${rules.name}」bot 编写说明`,
    "",
    `> 由 \`arena docs ${rules.id}\` 生成。你要写一个 TypeScript 文件控制一方，和别的 bot 对战。接口的完整定义在文末（也在同目录的 arena.d.ts 里）。`,
    "",
    RUN_FIRST,
    "",
    "## 玩法",
    "",
    rulesMd,
    "",
    "## 参数",
    "",
    params,
    "",
    "## 实体类型",
    "",
    "时间单位都是 tick。",
    "",
    unitTable(rules),
    "",
    mapSection(rules),
    "",
    botsSection(dir),
    "",
    "# 平台通用说明",
    "",
    platform,
    "",
    "## 接口定义（arena.d.ts）",
    "",
    "```ts",
    dts.trim(),
    "```",
    "",
  ].join("\n")
}

/** 给 bot 作者的 tsconfig：只有 ES 标准库和 arena.d.ts，没有 DOM 和 Node */
export function botTsconfig(files: string[]): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022"],
        types: [],
        strict: true,
        noEmit: true,
        erasableSyntaxOnly: true,
        module: "preserve",
        moduleDetection: "force",
        skipLibCheck: false,
      },
      files,
    },
    null,
    2,
  )
}

/** 用 tsc 检查 bot；返回错误输出，没有错误返回空字符串 */
export function typecheck(rules: Ruleset, rulesDir: string, files: string[]): string {
  // 每次一个临时目录：几个 agent 同时跑 check / run 不会互相覆盖
  const dir = join(tmpdir(), "rts-arena-check", `${rules.id}-${process.pid}-${randomBytes(3).toString("hex")}`)
  mkdirSync(dir, { recursive: true })
  try {
    return runTsc(rules, rulesDir, files, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function runTsc(rules: Ruleset, rulesDir: string, files: string[], dir: string): string {
  writeFileSync(join(dir, "arena.d.ts"), buildDts(rules, rulesDir))
  writeFileSync(join(dir, "tsconfig.json"), botTsconfig(["arena.d.ts", ...files.map((f) => resolve(f))]))
  return tsc(join(dir, "tsconfig.json"))
}

/** 跑 tsc -p，返回错误输出（没有错误返回空字符串）。typescript 装在哪都行（平台的 node_modules 里，或者被提升到上层） */
function tsc(project: string): string {
  const bin = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc")
  const r = spawnSync(process.execPath, [bin, "-p", project, "--pretty", "false"], { encoding: "utf8" })
  return r.status === 0 ? "" : (r.stdout + r.stderr).trim()
}

/**
 * 写规则包用的 tsconfig：类型从 "rts-arena/ruleset" 导入（就是 src/core/types.ts），
 * 共用工具从 "rts-arena/standard" 导入（rulesets/common/standard.ts）。路径是这台机器上平台的绝对路径，平台挪了位置要重新生成
 */
/** paths：rts-arena/ruleset、rts-arena/standard 指到哪。不给就是这台机器上平台的文件 */
export function rulesTsconfig(files: string[], paths?: { ruleset: string; standard: string }): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022"],
        types: [],
        strict: true,
        noEmit: true,
        erasableSyntaxOnly: true,
        verbatimModuleSyntax: true,
        allowImportingTsExtensions: true,
        module: "preserve",
        moduleResolution: "bundler",
        moduleDetection: "force",
        paths: {
          "rts-arena/ruleset": [paths?.ruleset ?? join(PKG_ROOT, "src", "core", "types.ts").split("\\").join("/")],
          "rts-arena/standard": [paths?.standard ?? join(PKG_ROOT, "rulesets", "common", "standard.ts").split("\\").join("/")],
        },
      },
      files,
    },
    null,
    2,
  )
}

/** 规则包沙箱里的全局（不是 Node，只有这些和 ES2022 自带的） */
export const RULES_GLOBALS_DTS = `// 规则包沙箱里能用的全局（除了 ES2022 自带的 Math、JSON、Map 这些）。由 rts-arena new-rules 生成，不要改。
// 没有 Date、网络、文件、定时器。

/** 调试输出：打到命令行的标准错误（每次回调最多 20 行、每行 300 字，整局 2000 行） */
declare const console: {
  log(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  debug(...args: unknown[]): void
}
`

/** 对规则包目录做类型检查（index.ts 和它 import 的文件） */
export function typecheckRuleset(rulesDir: string): string {
  const dir = join(tmpdir(), "rts-arena-check", `rules-${process.pid}-${randomBytes(3).toString("hex")}`)
  mkdirSync(dir, { recursive: true })
  try {
    writeFileSync(join(dir, "globals.d.ts"), RULES_GLOBALS_DTS)
    writeFileSync(join(dir, "tsconfig.json"), rulesTsconfig([resolve(rulesDir, "index.ts").split("\\").join("/"), "globals.d.ts"]))
    return tsc(join(dir, "tsconfig.json"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
