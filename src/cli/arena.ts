// 命令行入口：npm run arena -- <命令> ...
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
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
  check <规则包> <bot>... [--ticks N]    类型检查 + 在每个位置上和不动的对手试打 N tick（默认 300）
  run   <规则包> <bot>... [选项]         打一局（或多局），写回放

  <bot> 可以是文件路径，也可以是现成 bot 的名字：baseline（每个规则包的基准 bot）、idle（不动）等，见 list
        --seed N      种子（默认随机）
        --games N     连打 N 局，最后报胜率；同一个种子把座位轮换一遍（两人局就是换边各打一次）
        --out 路径    回放目录，默认 replays/；单局时也可以给 .json 文件名
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

/** 一组 bot 的显示名；不同文件同名时带上所在目录（如 koth/baseline 和 annihilation/baseline） */
function botNames(files: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const uniq = [...new Set(files)]
  for (const f of uniq) {
    const name = botName(f)
    const clash = uniq.some((g) => g !== f && resolve(g) !== resolve(f) && botName(g) === name)
    out.set(f, clash ? `${basename(dirname(resolve(f)))}/${name}` : name)
  }
  return out
}

/** 规则包能用的现成 bot：bots/<规则包>/*.ts 和通用的 bots/*.ts */
function knownBots(id: string): string[] {
  const list = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => f.slice(0, -3)) : [])
  return [...new Set([...list(join(ROOT, "bots", id)), ...list(join(ROOT, "bots"))])]
}

/** bot 参数可以是文件路径，也可以是现成 bot 的名字（如 baseline、idle） */
function resolveBots(rules: Ruleset, args: string[]): string[] {
  return args.map((a) => {
    if (existsSync(a)) return a
    if (/^[\w-]+$/.test(a)) {
      for (const f of [join(ROOT, "bots", rules.id, `${a}.ts`), join(ROOT, "bots", `${a}.ts`)])
        if (existsSync(f)) return relative(process.cwd(), f)
    }
    fail(`找不到 bot "${a}"：既不是文件，也不是「${rules.name}」的现成 bot（${knownBots(rules.id).join("、")}）`)
  })
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function makeBots(rules: Ruleset, files: string[], seed: number, names: Map<string, string>): Promise<MatchBot[]> {
  const bots: MatchBot[] = []
  for (const [p, file] of files.entries()) {
    const name = names.get(file) ?? botName(file)
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
  if (replay.players.length > 2 && r.ranking)
    console.log(`  名次：${r.ranking.map((g, i) => `${i + 1}. ${g.map((p) => `P${p} ${replay.players[p].name}`).join(" = ")}`).join("  ")}`)
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

async function cmdRun(rules: Ruleset, args: string[], opt: Record<string, string | true>): Promise<void> {
  if (args.length < rules.players.min || args.length > rules.players.max)
    fail(`「${rules.name}」需要 ${rules.players.min}~${rules.players.max} 个 bot，给了 ${args.length} 个`)
  const files = resolveBots(rules, args)
  const names = botNames(files)
  if (!opt["no-check"]) {
    const out = typecheck(rules, [...new Set(files)])
    if (out) fail(`类型检查没通过（加 --no-check 可以跳过）：\n${out}`)
  }
  for (const w of checkLimits(rules)) console.warn(`提醒：${w}`)
  const games = opt.games ? Number(opt.games) : 1
  if (!Number.isInteger(games) || games < 1) fail("--games 要是正整数")
  const baseSeed = typeof opt.seed === "string" ? Number(opt.seed) : Math.floor(Math.random() * 1e9)
  if (!Number.isInteger(baseSeed)) fail("--seed 要是整数")
  const outOpt = typeof opt.out === "string" ? opt.out : undefined
  const n = files.length
  // 按座位记战绩：同一个文件坐好几个位置（镜像对打）时也分得清
  const seatStats = files.map(() => ({ wins: 0, places: [] as number[] }))
  let draws = 0
  // 本次运行的编号：几个 agent 同一秒用同一个种子跑也不会写到同一个文件
  const runId = randomBytes(3).toString("hex")
  if (n > 2 && games > 1 && games % n !== 0) console.warn(`提醒：--games ${games} 不是 ${n} 的倍数，最后一个种子没轮完所有座位`)
  for (let g = 0; g < games; g++) {
    // 同一个种子把座位轮换一遍（两人局就是换边各打一次），抵消地图和随机数的影响。seats[p] 是坐在 P{p} 的参赛者编号
    const seed = n > 1 ? baseSeed + Math.floor(g / n) : baseSeed + g
    const seats = [...Array(n).keys()].map((p) => (p + g) % n)
    const order = seats.map((i) => files[i])
    const bots = await makeBots(rules, order, seed, names)
    const t0 = performance.now()
    const replay = runMatch({ ruleset: rules, bots, seed })
    const ms = performance.now() - t0
    for (const w of checkLimits(rules, replay)) console.warn(`提醒：${w}`)
    let file: string
    // --out 以 .json 结尾是单局的回放文件名，否则是目录
    if (games === 1 && outOpt?.endsWith(".json")) file = outOpt
    else file = join(outOpt ?? join(ROOT, "replays"), `${rules.id}-${stamp()}-${runId}-s${seed}${games > 1 ? `-g${g + 1}` : ""}.json`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(replay))
    console.log(`第 ${g + 1} 局  种子 ${seed}  ${order.map((f, p) => `P${p}=${names.get(f)}`).join("  ")}  用时 ${(ms / 1000).toFixed(1)} 秒`)
    printResult(replay)
    console.log(`  回放：${relative(process.cwd(), file)}`)
    // 每个 bot 一份只有它自己信息的日志
    const stem = file.replace(/\.json$/, "")
    for (let p = 0; p < n; p++) {
      const logFile = `${stem}.P${p}-${safeName(names.get(order[p])!)}.log`
      writeFileSync(logFile, botLog(replay, p, g + 1))
      console.log(`  P${p} 的日志：${relative(process.cwd(), logFile)}`)
    }
    const ranking = replay.result.ranking!
    if (replay.result.winner === null) draws++
    for (let p = 0; p < n; p++) {
      const place = 1 + ranking.findIndex((group) => group.includes(p))
      seatStats[seats[p]].places.push(place)
      if (replay.result.winner === p) seatStats[seats[p]].wins++
    }
  }
  if (games > 1) {
    const avg = (xs: number[]) => (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)
    const label = (i: number) => (files.indexOf(files[i]) === i && files.lastIndexOf(files[i]) === i ? names.get(files[i])! : `${names.get(files[i])}#${i + 1}`)
    const parts = seatStats.map((s, i) => `${label(i)} 赢 ${s.wins}${n > 2 ? `（平均名次 ${avg(s.places)}）` : ""}`)
    console.log(`\n共 ${games} 局：${parts.join("，")}，平 ${draws}`)
  }
}

function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|\s]/g, "_")
}

/** 某个玩家视角的对局日志：只有它自己的日志、报错、被拒命令和统计 */
function botLog(replay: Replay, p: number, game: number): string {
  const r = replay.result
  const me = replay.players[p]
  const others = replay.players.map((x, i) => `P${i} ${x.name}`).filter((_, i) => i !== p)
  const place = 1 + r.ranking!.findIndex((g) => g.includes(p))
  const outcome = r.winner === null ? "平局" : r.winner === p ? "你赢了" : `你输了（赢家 P${r.winner} ${replay.players[r.winner].name}）`
  const st = replay.bots[p]
  const avg = st.calls ? (st.fuelTotal / st.calls).toFixed(1) : "0"
  const lines = [
    `# ${me.name} 的对局日志（只有这个 bot 自己的信息）`,
    `规则包：${replay.ruleset.name}（${replay.ruleset.id}）  种子：${replay.seed}  第 ${game} 局`,
    `你是 P${p}（${me.bot}）；对手：${others.join("、")}`,
    `结果：第 ${r.tick} tick，${outcome}——${r.reason}${replay.players.length > 2 ? `；你的名次 ${place} / ${replay.players.length}` : ""}`,
    `统计：调用 ${st.calls} 次，燃料平均 ${avg} 最高 ${st.fuelMax}，报错 ${st.errors}，燃料耗尽 ${st.fuelOuts}，被拒命令 ${st.rejected}${st.status === "dead" ? `，停止运行：${st.deadReason}` : ""}`,
    "",
    "## 逐条记录（tick 是记录所在的那一帧；日志属于上一次决策）",
  ]
  for (const f of replay.frames) {
    for (const l of f.logs ?? []) if (l.p === p) for (const t of l.text) lines.push(`[${f.t}] 日志  ${t}`)
    for (const e of f.errs ?? []) {
      if (e.p !== p) continue
      const kind = e.msg.startsWith("命令被拒") ? "被拒" : "报错"
      lines.push(`[${f.t}] ${kind}  ${e.msg.replace(/\n/g, "\n        ")}`)
    }
  }
  return lines.join("\n") + "\n"
}

async function cmdCheck(rules: Ruleset, args: string[], opt: Record<string, string | true>): Promise<void> {
  const files = resolveBots(rules, args)
  const checkTicks = typeof opt.ticks === "string" ? Number(opt.ticks) : CHECK_TICKS
  if (!Number.isInteger(checkTicks) || checkTicks < 1) fail("--ticks 要是正整数")
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
        console.log(`${id}\t${r.name}\t${r.players.min}~${r.players.max} 人\t现成 bot：${knownBots(id).join("、")}`)
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
