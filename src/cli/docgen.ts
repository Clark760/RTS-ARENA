// 生成发给 bot 作者的 arena.d.ts 和 PROMPT.md（Node 端）
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { resolveType } from "../core/world.ts"
import type { Ruleset } from "../core/types.ts"

const ROOT = join(import.meta.dirname, "..", "..")

export function rulesetDir(id: string): string {
  return join(ROOT, "rulesets", id)
}

/** 去掉行首的 export，让类型成为全局声明 */
function ambient(src: string): string {
  return src.replace(/^export\s+/gm, "")
}

function literalUnion(names: string[]): string {
  return names.length === 0 ? "never" : names.map((n) => JSON.stringify(n)).join(" | ")
}

export function buildDts(rules: Ruleset): string {
  const api = readFileSync(join(ROOT, "src", "api", "bot-api.ts"), "utf8")
  const globals = readFileSync(join(ROOT, "src", "api", "bot-globals.d.ts"), "utf8")
  const objPath = join(rulesetDir(rules.id), "objectives.ts")
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
  const rows = [
    "| 类型 | 种类 | 占地 | 生命 | 造价 | 生产用时 | 走一格 | 视野 | 攻击（伤害/射程/冷却） | 采集（每次量/用时/容量） | 交货点 | 能生产 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ]
  const kindText = { unit: "单位", building: "建筑", resource: "资源点" }
  for (const [name, spec] of Object.entries(rules.types)) {
    const d = resolveType(name, spec)
    const res = d.kind === "resource" ? `（产 ${d.resource}，储量 ${spec.amount ?? 0}）` : ""
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
        "",
      ].join(" | ").trim(),
    )
  }
  return rows.join("\n")
}

export function buildPrompt(rules: Ruleset, dts: string): string {
  const rulesMd = readFileSync(join(rulesetDir(rules.id), "RULES.md"), "utf8").trim()
  const platform = readFileSync(join(ROOT, "src", "api", "PLATFORM.md"), "utf8").trim()
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
export function typecheck(rules: Ruleset, files: string[]): string {
  const dir = join(ROOT, "out", "check", rules.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "arena.d.ts"), buildDts(rules))
  writeFileSync(join(dir, "tsconfig.json"), botTsconfig(["arena.d.ts", ...files.map((f) => resolve(f))]))
  const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc")
  const r = spawnSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json"), "--pretty", "false"], { encoding: "utf8" })
  return r.status === 0 ? "" : (r.stdout + r.stderr).trim()
}
