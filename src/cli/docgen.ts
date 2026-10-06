// 生成发给 bot 作者的 arena.d.ts 和 PROMPT.md（Node 端）
import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { resolveType, World } from "../core/world.ts"
import type { Ruleset } from "../core/types.ts"
import { PKG_ROOT } from "../paths.ts"

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
        d.attack ? `${d.attack.damage} / ${d.attack.range} / ${d.attack.cooldown}` : "—",
        d.gather ? `${d.gather.amount} / ${d.gather.ticks} / ${d.gather.capacity}` : "—",
        d.dropOff ? "是" : "—",
        d.produces.length ? d.produces.join("、") : "—",
        ...(building ? [d.builds.length ? d.builds.join("、") : "—"] : []),
        "",
      ].join(" | ").trim(),
    )
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
export function mapSection(rules: Ruleset): string {
  const n = rules.players.min
  const w = new World(
    rules,
    [...Array(n).keys()].map((i) => `P${i}`),
    1,
  )
  try {
    rules.setup(w)
  } catch (e) {
    return `## 地图\n\n（画不出来：规则包的 setup 出错了：${(e as Error).message.split("\n")[0]}）`
  } finally {
    rules.release?.()
  }
  const W = w.width
  const H = w.height
  const ents = w.entities()
  const out = [`## 开局地图（${n} 人、种子 1 时的样子；${W}×${H}，左上角是 (0, 0)，x 向右、y 向下）`, ""]
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
  if (resources.length) out.push(`资源点（${resources.length} 个）：${resources.map((e) => `${e.type} (${e.x}, ${e.y}) 储量 ${e.amount}`).join("；")}`, "")
  for (let p = -1; p < n; p++) {
    const mine = ents.filter((e) => e.owner === p && e.def.kind !== "resource")
    if (!mine.length) continue
    const byType = new Map<string, string[]>()
    for (const e of mine) byType.set(e.type, [...(byType.get(e.type) ?? []), `(${e.x}, ${e.y})`])
    out.push(`${p < 0 ? "中立" : `P${p}`}：${[...byType].map(([t, at]) => `${t} ${at.join(" ")}`).join("；")}`)
  }
  out.push("", "你不一定是 P0：开局看 `view.me` 和自己实体的位置。建筑的坐标是占地左上角。")
  return out.join("\n")
}

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
  ].join("\n")
  return [
    `# 「${rules.name}」bot 编写说明`,
    "",
    `> 由 \`arena docs ${rules.id}\` 生成。你要写一个 TypeScript 文件控制一方，和别的 bot 对战。接口的完整定义在文末（也在同目录的 arena.d.ts 里）。`,
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

/** 对规则包目录做类型检查（index.ts 和它 import 的文件） */
export function typecheckRuleset(rulesDir: string): string {
  const dir = join(tmpdir(), "rts-arena-check", `rules-${process.pid}-${randomBytes(3).toString("hex")}`)
  mkdirSync(dir, { recursive: true })
  try {
    writeFileSync(join(dir, "tsconfig.json"), rulesTsconfig([resolve(rulesDir, "index.ts").split("\\").join("/")]))
    return tsc(join(dir, "tsconfig.json"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
