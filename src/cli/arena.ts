// 命令行入口：npm run arena -- <命令> ...
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { checkLimits } from "../core/limits.ts"
import { runMatch, type MatchBot } from "../core/match.ts"
import { mixSeed } from "../core/rng.ts"
import type { Replay, Ruleset } from "../core/types.ts"
import { compileBot, createBot } from "../sandbox/quickjs.ts"
import { botTsconfig, buildDts, buildPrompt, rulesetDir, typecheck } from "./docgen.ts"

const ROOT = join(import.meta.dirname, "..", "..")
const HELP = `用法：npm run arena -- <命令> [参数]

  list                                  列出规则包
  docs  <规则包> [--out 目录]            生成 arena.d.ts 和 PROMPT.md（默认 out/<规则包>/）
  init  <规则包> <目录>                  建一个 bot 工作目录：arena.d.ts、PROMPT.md、tsconfig.json、bot.ts 模板
  check <规则包> <bot.ts>... [--ticks N] 类型检查 + 在每个位置上和不动的对手试打 N tick（默认 300）
  run   <规则包> <bot.ts>... [选项]      打一局（或多局），写回放
        --seed N      种子（默认随机）
        --games N     连打 N 局，最后报胜率；两人局每个种子换边各打一次
        --out 路径    回放文件（单局）或目录（多局），默认 replays/
        --no-check    跳过类型检查
`

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

/** 各命令接受的选项；值为 true 的是开关，不带值 */
const OPTIONS: Record<string, Record<string, boolean>> = {
  docs: { out: false },
  run: { seed: false, games: false, out: false, "no-check": true },
  check: { ticks: false },
}

function parseArgs(command: string | undefined, argv: string[]): { pos: string[]; opt: Record<string, string | true> } {
  const pos: string[] = []
  const opt: Record<string, string | true> = {}
  const allowed = OPTIONS[command ?? ""] ?? {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const key = a.slice(2)
      if (!(key in allowed)) {
        const names = Object.keys(allowed).map((k) => "--" + k)
        fail(`${command ?? ""} 不认识选项 ${a}${names.length ? `（可用：${names.join("、")}；值用空格隔开，不要写等号）` : ""}`)
      }
      if (allowed[key]) {
        opt[key] = true
        continue
      }
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("--")) fail(`--${key} 后面要跟一个值`)
      opt[key] = next
      i++
    } else pos.push(a)
  }
  return { pos, opt }
}

function listRulesets(): string[] {
  const dir = join(ROOT, "rulesets")
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "index.ts")))
    .map((d) => d.name)
}

async function loadRuleset(id: string | undefined): Promise<Ruleset> {
  if (!id) fail("缺少规则包名。可用的：" + listRulesets().join("、"))
  const file = join(rulesetDir(id), "index.ts")
  if (!existsSync(file)) fail(`没有规则包 "${id}"。可用的：${listRulesets().join("、")}`)
  const mod = (await import(pathToFileURL(file).href)) as { default: Ruleset }
  return mod.default
}

function writeDocs(rules: Ruleset, dir: string): void {
  mkdirSync(dir, { recursive: true })
  const dts = buildDts(rules)
  writeFileSync(join(dir, "arena.d.ts"), dts)
  writeFileSync(join(dir, "PROMPT.md"), buildPrompt(rules, dts))
}

/** 显示名：文件名去掉 .ts；init 建出来的都叫 bot.ts，改用所在目录名 */
function botName(file: string): string {
  const name = basename(file).replace(/\.ts$/, "")
  return name === "bot" ? basename(dirname(resolve(file))) : name
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function makeBots(rules: Ruleset, files: string[], seed: number): Promise<MatchBot[]> {
  const bots: MatchBot[] = []
  for (const [p, file] of files.entries()) {
    const name = botName(file)
    const compiled = compileBot(readFileSync(file, "utf8"))
    if ("error" in compiled) bots.push({ name, file, runner: null, loadError: compiled.error })
    else bots.push({ name, file, runner: await createBot(compiled.code, mixSeed(seed, "bot", p), { fuel: rules.fuel }) })
  }
  return bots
}

function printResult(replay: Replay): void {
  const r = replay.result
  const winner = r.winner === null ? "平局" : `玩家 ${r.winner}（${replay.players[r.winner].name}）获胜`
  console.log(`  第 ${r.tick} tick 结束：${winner}——${r.reason}`)
  for (const b of replay.bots) {
    const avg = b.calls ? (b.fuelTotal / b.calls).toFixed(1) : "0"
    const dead = b.status === "dead" ? `  已停止：${b.deadReason}` : ""
    console.log(
      `  P${b.player} ${replay.players[b.player].name}: 调用 ${b.calls} 次，燃料 平均 ${avg} 最高 ${b.fuelMax}，报错 ${b.errors}，燃料耗尽 ${b.fuelOuts}，被拒命令 ${b.rejected}${dead}`,
    )
  }
  // 每个玩家按种类汇总报错和被拒原因（数字归一后算同一种），列出最多的几种和第一次出现的位置
  for (let p = 0; p < replay.players.length; p++) {
    const kinds = new Map<string, { n: number; t: number; msg: string }>()
    for (const f of replay.frames) {
      for (const e of f.errs ?? []) {
        if (e.p !== p) continue
        const head = e.msg.split("\n")[0].replace(/\s+\{.*$/, "")
        const key = head.replace(/#\d+/g, "#").replace(/\d+/g, "N")
        const k = kinds.get(key)
        if (k) k.n++
        else kinds.set(key, { n: 1, t: f.t, msg: e.msg.split("\n").slice(0, 3).join(" | ") })
      }
    }
    const top = [...kinds.values()].sort((a, b) => b.n - a.n)
    for (const k of top.slice(0, 4)) console.log(`    P${p} ×${k.n}（首次第 ${k.t} tick）${k.msg}`)
    if (top.length > 4) console.log(`    P${p} 另有 ${top.length - 4} 种，见回放`)
  }
}

async function cmdRun(rules: Ruleset, files: string[], opt: Record<string, string | true>): Promise<void> {
  if (files.length < rules.players.min || files.length > rules.players.max)
    fail(`「${rules.name}」需要 ${rules.players.min}~${rules.players.max} 个 bot，给了 ${files.length} 个`)
  for (const f of files) if (!existsSync(f)) fail(`找不到 bot 文件 ${f}`)
  if (!opt["no-check"]) {
    const out = typecheck(rules, [...new Set(files)])
    if (out) fail(`类型检查没通过（加 --no-check 可以跳过）：\n${out}`)
  }
  for (const w of checkLimits(rules)) console.warn(`提醒：${w}`)
  const games = opt.games ? Number(opt.games) : 1
  if (!Number.isInteger(games) || games < 1) fail("--games 要是正整数")
  if (files.length === 2 && games > 1 && games % 2 === 1) console.warn(`提醒：--games ${games} 是奇数，最后一个种子只打了一边`)
  const baseSeed = typeof opt.seed === "string" ? Number(opt.seed) : Math.floor(Math.random() * 1e9)
  if (!Number.isInteger(baseSeed)) fail("--seed 要是整数")
  const outOpt = typeof opt.out === "string" ? opt.out : undefined
  const wins = new Map<string, number>()
  let draws = 0
  const paired = files.length === 2
  for (let g = 0; g < games; g++) {
    // 两人局：同一个种子两边各打一次（第 1、2 局同种子换边，依此类推），抵消地图和随机数的影响
    const seed = paired ? baseSeed + Math.floor(g / 2) : baseSeed + g
    const order = paired && g % 2 === 1 ? [files[1], files[0]] : files
    const bots = await makeBots(rules, order, seed)
    const t0 = performance.now()
    const replay = runMatch({ ruleset: rules, bots, seed })
    const ms = performance.now() - t0
    for (const w of checkLimits(rules, replay)) console.warn(`提醒：${w}`)
    let file: string
    if (games === 1 && outOpt && !(existsSync(outOpt) && statSync(outOpt).isDirectory())) file = outOpt
    else file = join(outOpt ?? join(ROOT, "replays"), `${rules.id}-${stamp()}-s${seed}${games > 1 ? `-g${g + 1}` : ""}.json`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(replay))
    console.log(`第 ${g + 1} 局  种子 ${seed}  ${order.map((f, p) => `P${p}=${botName(f)}`).join("  ")}  用时 ${(ms / 1000).toFixed(1)} 秒`)
    printResult(replay)
    console.log(`  回放：${relative(process.cwd(), file)}`)
    const wnr = replay.result.winner
    if (wnr === null) draws++
    else wins.set(order[wnr], (wins.get(order[wnr]) ?? 0) + 1)
  }
  if (games > 1) {
    console.log(`\n共 ${games} 局：` + [...new Set(files)].map((f) => `${botName(f)} 赢 ${wins.get(f) ?? 0}`).join("，") + `，平 ${draws}`)
  }
}

async function cmdCheck(rules: Ruleset, files: string[], opt: Record<string, string | true>): Promise<void> {
  const checkTicks = typeof opt.ticks === "string" ? Number(opt.ticks) : CHECK_TICKS
  if (!Number.isInteger(checkTicks) || checkTicks < 1) fail("--ticks 要是正整数")
  for (const f of files) if (!existsSync(f)) fail(`找不到 bot 文件 ${f}`)
  let ok = true
  const out = typecheck(rules, files)
  if (out) {
    ok = false
    console.log(`类型检查没通过：\n${out}`)
  } else console.log("类型检查通过")
  for (const file of files) {
    const compiled = compileBot(readFileSync(file, "utf8"))
    if ("error" in compiled) {
      ok = false
      console.log(`${file}：${compiled.error}`)
      continue
    }
    // 在每个位置上和不动的对手试打（默认 300 tick），抓开局阶段的运行错误
    const n = rules.players.min
    for (let seat = 0; seat < n; seat++) {
      const bots: MatchBot[] = []
      for (let p = 0; p < n; p++) {
        const code = p === seat ? compiled.code : IDLE_CODE
        bots.push({ name: p === seat ? botName(file) : "idle", file, runner: await createBot(code, mixSeed(1, "bot", p), { fuel: rules.fuel }) })
      }
      const replay = runMatch({ ruleset: { ...rules, maxTicks: Math.min(rules.maxTicks, checkTicks) }, bots, seed: 1 })
      const st = replay.bots[seat]
      const errs = replay.frames.flatMap((f) => (f.errs ?? []).filter((e) => e.p === seat).map((e) => `第 ${f.t} tick：${e.msg}`))
      const where = `${file}（位置 P${seat}）`
      if (st.status === "dead" || st.errors > 0 || st.fuelOuts > 0) {
        ok = false
        console.log(`${where}：试打 ${replay.result.tick} tick 出了问题${st.deadReason ? `，bot 停止运行：${st.deadReason}` : ""}`)
      } else {
        console.log(`${where}：试打 ${replay.result.tick} tick 通过（调用 ${st.calls} 次，燃料最高 ${st.fuelMax}，被拒命令 ${st.rejected}）`)
      }
      for (const line of errs.slice(0, 5)) console.log(`  ${line.split("\n").slice(0, 3).join(" | ")}`)
      if (errs.length > 5) console.log(`  另有 ${errs.length - 5} 条，见 run 的回放`)
    }
  }
  if (!ok) process.exit(1)
}

/** check 试打的长度 */
const CHECK_TICKS = 300
const IDLE_CODE = "export function onTick() {}"

const BOT_TEMPLATE = `// 一个最简单的 bot：闲着的采集单位去采最近的资源点。从这里改起（还不会生产，也不会打仗）。

export function onTick(view: View, cmd: Commands): void {
  const mine = view.entities.filter((e) => e.owner === view.me)
  const resources = view.entities.filter((e) => game.types[e.type].kind === "resource")
  for (const u of mine) {
    if (u.order?.kind !== "idle" || !game.types[u.type].gather || resources.length === 0) continue
    const target = resources.reduce((a, b) => (dist(u, a) <= dist(u, b) ? a : b))
    cmd.gather(u, target)
  }
}
`

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  const { pos, opt } = parseArgs(command, rest)
  switch (command) {
    case "list": {
      for (const id of listRulesets()) {
        const r = await loadRuleset(id)
        console.log(`${id}\t${r.name}\t${r.players.min}~${r.players.max} 人`)
      }
      return
    }
    case "docs": {
      const rules = await loadRuleset(pos[0])
      const dir = typeof opt.out === "string" ? opt.out : join(ROOT, "out", rules.id)
      writeDocs(rules, dir)
      console.log(`已生成 ${relative(process.cwd(), join(dir, "arena.d.ts"))} 和 PROMPT.md`)
      return
    }
    case "init": {
      const rules = await loadRuleset(pos[0])
      const dir = pos[1] ?? fail("缺少目录")
      writeDocs(rules, dir)
      writeFileSync(join(dir, "tsconfig.json"), botTsconfig(["arena.d.ts", "bot.ts"]))
      if (!existsSync(join(dir, "bot.ts"))) writeFileSync(join(dir, "bot.ts"), BOT_TEMPLATE)
      console.log(`已建好 ${dir}：先读 PROMPT.md，改 bot.ts，然后 npm run arena -- check ${rules.id} ${join(dir, "bot.ts")}`)
      return
    }
    case "check": {
      const rules = await loadRuleset(pos[0])
      if (pos.length < 2) fail("缺少 bot 文件")
      await cmdCheck(rules, pos.slice(1), opt)
      return
    }
    case "run": {
      const rules = await loadRuleset(pos[0])
      await cmdRun(rules, pos.slice(1), opt)
      return
    }
    default:
      console.log(HELP)
      if (command && command !== "help") process.exit(1)
  }
}

await main()
