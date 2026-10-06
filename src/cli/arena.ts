// 命令行入口：rts-arena <命令> ...（在平台仓库里开发时等价于 npm run arena -- <命令> ...）
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import { checkLimits } from "../core/limits.ts"
import { runMatch, type MatchBot } from "../core/match.ts"
import { mixSeed } from "../core/rng.ts"
import type { Replay, Ruleset } from "../core/types.ts"
import { compileBot, createBot } from "../sandbox/quickjs.ts"
import { botTsconfig, buildDts, buildPrompt, typecheck } from "./docgen.ts"
import { serveViewer } from "./serve.ts"
import { importRuleset, knownBotFile, knownBots, listRulesets, readWorkspaceIn, WORKSPACE_FILE, type Workspace } from "./catalog.ts"

const HELP = `用法：rts-arena <命令> [参数]

在 bot 目录里（有 arena.json 的目录，用 init 建）：
  init <规则包> [目录]                   建 bot 目录（默认当前目录）：arena.json、bot.ts 模板、PROMPT.md、arena.d.ts、tsconfig.json
  init                                  在 bot 目录里重新生成说明书和接口（平台升级后跑一次），不动 bot.ts
  check [--ticks N]                     检查自己的 bot：类型检查 + 在每个位置上和不动的对手试打 N tick（默认 300）
  run [对手...] [选项]                  自己的 bot 打对手（不写就打 baseline），回放和日志写到 ./replays
  view [回放目录] [--port N] [--open]   网页播放器（默认看 ./replays，端口 5180；--open 起来后打开浏览器）

在任何目录：
  list                                  列出规则包和现成的 bot
  docs  <规则包> [--out 目录]            生成 arena.d.ts 和 PROMPT.md（默认 ./out/<规则包>/）
  check <规则包> <bot>... [--ticks N]    检查指定的 bot
  run   <规则包> <bot>... [选项]         指定所有参赛 bot 打一局（或多局）

  <bot> 可以是文件路径，也可以是现成 bot 的名字：baseline（每个规则包的基准 bot）、idle（不动）等，见 list
run 的选项：
        --seed N      种子（默认随机）
        --games N     连打 N 局，最后报胜率；同一个种子把各方的位置轮换一遍（两人局就是换边各打一次）
        --teams 2v2   分队（规则包要支持），按给出的 bot 顺序分组：2v2 就是前 2 个一队、后 2 个一队
        --out 路径    回放目录，默认 ./replays；单局时也可以给 .json 文件名
        --no-check    跳过类型检查
        --json        每行输出一个 JSON 事件（start / game / summary / warning / error），给程序读
`

/** --json：输出改成每行一个 JSON 事件（给网页对战页和 agent 用），人看的文字不再打印 */
let jsonMode = false

function emit(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event))
}

function fail(msg: string): never {
  if (jsonMode) emit({ type: "error", message: msg })
  else console.error(msg)
  process.exit(1)
}

function warn(msg: string): void {
  if (jsonMode) emit({ type: "warning", message: msg })
  else console.warn(`提醒：${msg}`)
}

/** 普通输出；--json 时不打印 */
function say(msg: string): void {
  if (!jsonMode) console.log(msg)
}

/** 各命令接受的选项；值为 true 的是开关，不带值 */
const OPTIONS: Record<string, Record<string, boolean>> = {
  docs: { out: false },
  run: { seed: false, games: false, out: false, teams: false, "no-check": true, json: true },
  check: { ticks: false },
  view: { port: false, open: true },
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

async function loadRuleset(id: string | undefined): Promise<Ruleset> {
  if (!id) fail("缺少规则包名。可用的：" + listRulesets().join("、"))
  try {
    return await importRuleset(id)
  } catch (e) {
    fail((e as Error).message)
  }
}

function readWorkspace(): Workspace | null {
  try {
    return readWorkspaceIn(".")
  } catch (e) {
    fail(`${WORKSPACE_FILE} 读不出来：${(e as Error).message}`)
  }
}

/**
 * check / run 的两种写法：第一个参数是规则包名，就是"指定所有 bot"；
 * 否则在 bot 目录里，规则包和自己的 bot 从 arena.json 读，参数是对手。
 */
async function target(pos: string[], command: string): Promise<{ rules: Ruleset; bots: string[]; mine: boolean }> {
  if (pos[0] !== undefined && listRulesets().includes(pos[0])) return { rules: await loadRuleset(pos[0]), bots: pos.slice(1), mine: false }
  const ws = readWorkspace()
  if (!ws)
    fail(
      pos.length === 0
        ? `当前目录不是 bot 目录（没有 ${WORKSPACE_FILE}）。先 rts-arena init <规则包>，或者写成 rts-arena ${command} <规则包> <bot>...`
        : `"${pos[0]}" 不是规则包名，当前目录也不是 bot 目录（没有 ${WORKSPACE_FILE}）。可用的规则包：${listRulesets().join("、")}`,
    )
  if (!existsSync(ws.bot)) fail(`${WORKSPACE_FILE} 里写的 bot 文件 ${ws.bot} 不存在`)
  return { rules: await loadRuleset(ws.ruleset), bots: [ws.bot, ...pos], mine: true }
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

/** bot 参数可以是文件路径，也可以是现成 bot 的名字（如 baseline、idle） */
function resolveBots(rules: Ruleset, args: string[]): string[] {
  return args.map((a) => {
    if (existsSync(a)) return a
    const known = knownBotFile(rules.id, a)
    if (known) return relative(process.cwd(), known)
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
  const won = r.winners ?? []
  const winner = won.length === 0 ? "平局" : `${won.map((p) => `P${p}（${replay.players[p].name}）`).join("、")}获胜`
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
  for (const w of checkLimits(rules)) warn(w)
  const games = opt.games ? Number(opt.games) : 1
  if (!Number.isInteger(games) || games < 1) fail("--games 要是正整数")
  const baseSeed = typeof opt.seed === "string" ? Number(opt.seed) : Math.floor(Math.random() * 1e9)
  if (!Number.isInteger(baseSeed)) fail("--seed 要是整数")
  const outOpt = typeof opt.out === "string" ? opt.out : undefined
  const n = files.length
  // 分队：--teams 2v2 表示按给出的顺序前 2 个一队、后 2 个一队；不给就每人一队
  const groups = parseTeams(opt.teams, n)
  if (groups.length < n && !rules.teams) fail(`「${rules.name}」不支持分队`)
  // 按座位记战绩：同一个文件坐好几个位置（镜像对打）时也分得清
  const seatStats = files.map(() => ({ wins: 0, places: [] as number[] }))
  let draws = 0
  // 本次运行的编号：几个 agent 同一秒用同一个种子跑也不会写到同一个文件
  const runId = randomBytes(3).toString("hex")
  const k = groups.length
  if (k > 2 && games > 1 && games % k !== 0) warn(`--games ${games} 不是 ${k} 的倍数，最后一个种子没轮完所有位置`)
  if (k === 2 && games > 1 && games % 2 === 1) warn(`--games ${games} 是奇数，最后一个种子只打了一边`)
  const label = (i: number) => (files.indexOf(files[i]) === i && files.lastIndexOf(files[i]) === i ? names.get(files[i])! : `${names.get(files[i])}#${i + 1}`)
  const participants = files.map((f, i) => ({ name: label(i), file: f }))
  // 本次比赛的汇总文件：每打完一局更新一次，网页对战页的历史记录读它
  const startStamp = stamp()
  const seriesFile =
    games === 1 && outOpt?.endsWith(".json")
      ? outOpt.replace(/\.json$/, ".series.json")
      : join(outOpt ?? "replays", `${rules.id}-${startStamp}-${runId}.series.json`)
  const series = {
    format: "rts-arena-series",
    version: 1,
    ruleset: { id: rules.id, name: rules.name },
    startedAt: new Date().toISOString(),
    seed: baseSeed,
    games,
    teams: typeof opt.teams === "string" ? opt.teams : null,
    participants,
    results: [] as Record<string, unknown>[],
    summary: null as Record<string, unknown> | null,
  }
  const saveSeries = () => {
    mkdirSync(dirname(seriesFile), { recursive: true })
    writeFileSync(seriesFile, JSON.stringify(series, null, 1))
  }
  emit0({ type: "start", ruleset: rules.id, name: rules.name, games, seed: baseSeed, teams: series.teams, participants, series: basename(seriesFile) })
  for (let g = 0; g < games; g++) {
    // 同一个种子把各队的位置轮换一遍（两边就是换边各打一次），抵消地图和随机数的影响。
    // seats[p] 是坐在 P{p} 的参赛者编号，teams[p] 是这个座位的队伍编号
    const seed = baseSeed + Math.floor(g / k)
    const rotated = [...Array(k).keys()].map((t) => groups[(t + g) % k])
    const seats = rotated.flat()
    const teams = rotated.flatMap((members, t) => members.map(() => t))
    const order = seats.map((i) => files[i])
    const bots = await makeBots(rules, order, seed, names)
    const t0 = performance.now()
    const replay = runMatch({ ruleset: rules, bots, seed, teams })
    const ms = performance.now() - t0
    for (const w of checkLimits(rules, replay)) warn(w)
    let file: string
    // --out 以 .json 结尾是单局的回放文件名，否则是目录
    if (games === 1 && outOpt?.endsWith(".json")) file = outOpt
    else file = join(outOpt ?? "replays", `${rules.id}-${stamp()}-${runId}-s${seed}${games > 1 ? `-g${g + 1}` : ""}.json`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(replay))
    const lineup =
      k === n
        ? order.map((f, p) => `P${p}=${names.get(f)}`).join("  ")
        : rotated.map((members, t) => `队${t + 1}[${members.map((i) => `P${seats.indexOf(i)}=${names.get(files[i])}`).join(" ")}]`).join(" 对 ")
    say(`第 ${g + 1} 局  种子 ${seed}  ${lineup}  用时 ${(ms / 1000).toFixed(1)} 秒`)
    if (!jsonMode) printResult(replay)
    say(`  回放：${relative(process.cwd(), file)}`)
    // 每个 bot 一份只有它自己信息的日志
    const stem = file.replace(/\.json$/, "")
    const logs: { seat: number; name: string; file: string }[] = []
    for (let p = 0; p < n; p++) {
      const logFile = `${stem}.P${p}-${safeName(names.get(order[p])!)}.log`
      writeFileSync(logFile, botLog(replay, p, g + 1))
      say(`  P${p} 的日志：${relative(process.cwd(), logFile)}`)
      logs.push({ seat: p, name: names.get(order[p])!, file: basename(logFile) })
    }
    const ranking = replay.result.ranking!
    const won = replay.result.winners ?? []
    if (won.length === 0) draws++
    for (let p = 0; p < n; p++) {
      const place = 1 + ranking.findIndex((group) => group.includes(p))
      seatStats[seats[p]].places.push(place)
      if (won.includes(p)) seatStats[seats[p]].wins++
    }
    const entry = {
      type: "game",
      index: g + 1,
      seed,
      seats,
      names: order.map((f) => names.get(f)),
      teams,
      winners: won,
      ranking,
      reason: replay.result.reason,
      tick: replay.result.tick,
      ms: Math.round(ms),
      replay: basename(file),
      logs,
      bots: replay.bots.map((b) => ({ seat: b.player, calls: b.calls, errors: b.errors, fuelOuts: b.fuelOuts, rejected: b.rejected, status: b.status, deadReason: b.deadReason })),
    }
    series.results.push(entry)
    saveSeries()
    emit0(entry)
  }
  const avg = (xs: number[]) => Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2))
  series.summary = {
    type: "summary",
    games,
    draws,
    participants: seatStats.map((st, i) => ({ name: label(i), file: files[i], wins: st.wins, avgPlace: avg(st.places) })),
    teams: k === n ? null : groups.map((members) => ({ members: members.map(label), wins: seatStats[members[0]].wins, avgPlace: avg(seatStats[members[0]].places) })),
  }
  saveSeries()
  emit0(series.summary)
  if (games > 1 && !jsonMode) {
    const parts =
      k === n
        ? seatStats.map((st, i) => `${label(i)} 赢 ${st.wins}${n > 2 ? `（平均名次 ${avg(st.places).toFixed(2)}）` : ""}`)
        : groups.map((members, t) => {
            // 同队的人胜场相同，名次也相同
            const st = seatStats[members[0]]
            return `队${t + 1}（${members.map(label).join("、")}）赢 ${st.wins}${k > 2 ? `（平均名次 ${avg(st.places).toFixed(2)}）` : ""}`
          })
    console.log(`\n共 ${games} 局：${parts.join("，")}，平 ${draws}`)
  }
}

/** 只在 --json 时输出的事件 */
function emit0(event: Record<string, unknown>): void {
  if (jsonMode) emit(event)
}

/** "2v2"、"1v1v1v1"、"3v1" → 按顺序分组的参赛者编号；不给就每人一队 */
function parseTeams(spec: string | true | undefined, n: number): number[][] {
  if (spec === undefined) return [...Array(n).keys()].map((i) => [i])
  if (typeof spec !== "string" || !/^\d+(v\d+)+$/.test(spec)) fail(`--teams 要写成 2v2、3v1、1v1v1v1 这样`)
  const sizes = spec.split("v").map(Number)
  if (sizes.some((x) => x < 1)) fail("--teams 里每队至少 1 人")
  const total = sizes.reduce((a, b) => a + b, 0)
  if (total !== n) fail(`--teams ${spec} 一共 ${total} 人，但给了 ${n} 个 bot`)
  const out: number[][] = []
  let i = 0
  for (const size of sizes) {
    out.push([...Array(size).keys()].map((j) => i + j))
    i += size
  }
  return out
}

function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|\s]/g, "_")
}

/** 某个玩家视角的对局日志：只有它自己的日志、报错、被拒命令和统计 */
function botLog(replay: Replay, p: number, game: number): string {
  const r = replay.result
  const me = replay.players[p]
  const ally = (i: number) => replay.players[i].team === me.team
  const allies = replay.players.map((x, i) => `P${i} ${x.name}`).filter((_, i) => i !== p && ally(i))
  const others = replay.players.map((x, i) => `P${i} ${x.name}`).filter((_, i) => !ally(i))
  const place = 1 + r.ranking!.findIndex((g) => g.includes(p))
  const won = r.winners ?? []
  const outcome =
    won.length === 0
      ? "平局"
      : won.includes(p)
        ? allies.length > 0
          ? "你们队赢了"
          : "你赢了"
        : `你输了（赢家 ${won.map((i) => `P${i} ${replay.players[i].name}`).join("、")}）`
  const st = replay.bots[p]
  const avg = st.calls ? (st.fuelTotal / st.calls).toFixed(1) : "0"
  const lines = [
    `# ${me.name} 的对局日志（只有这个 bot 自己的信息）`,
    `规则包：${replay.ruleset.name}（${replay.ruleset.id}）  种子：${replay.seed}  第 ${game} 局`,
    `你是 P${p}（${me.bot}）${allies.length ? `；盟友：${allies.join("、")}` : ""}；对手：${others.join("、")}`,
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

/** 建 bot 目录，或者在已有的 bot 目录里更新说明书 */
async function cmdInit(pos: string[]): Promise<void> {
  let id = pos[0]
  let dir = pos[1] ?? "."
  if (id === undefined) {
    // 不带参数：更新当前 bot 目录
    const ws = readWorkspace() ?? fail(`用法：rts-arena init <规则包> [目录]。可用的规则包：${listRulesets().join("、")}`)
    id = ws.ruleset
    dir = "."
  }
  const rules = await loadRuleset(id)
  mkdirSync(dir, { recursive: true })
  const wsFile = join(dir, WORKSPACE_FILE)
  const old = existsSync(wsFile) ? (JSON.parse(readFileSync(wsFile, "utf8")) as Partial<Workspace>) : {}
  const bot = old.bot ?? "bot.ts"
  writeFileSync(wsFile, JSON.stringify({ ruleset: rules.id, bot }, null, 2) + "\n")
  writeDocs(rules, dir)
  writeFileSync(join(dir, "tsconfig.json"), botTsconfig(["arena.d.ts", bot]))
  const created = !existsSync(join(dir, bot))
  if (created) writeFileSync(join(dir, bot), BOT_TEMPLATE)
  if (!existsSync(join(dir, ".gitignore"))) writeFileSync(join(dir, ".gitignore"), "replays/\n")
  const where = dir === "." ? "当前目录" : ` ${dir} `
  if (created) {
    const at = dir === "." ? "" : `在 ${dir} 里`
    console.log(`已在${where}建好「${rules.name}」的 bot 目录。先读 PROMPT.md，改 ${bot}，然后${at}运行：`)
    console.log(`  rts-arena check              检查`)
    console.log(`  rts-arena run --games 10     和基准 bot 打 10 局`)
    console.log(`  rts-arena view               看回放`)
  } else console.log(`已更新${where}的说明书和接口（「${rules.name}」），${bot} 没动`)
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  jsonMode = command === "run" && rest.includes("--json")
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
      const dir = typeof opt.out === "string" ? opt.out : join("out", rules.id)
      writeDocs(rules, dir)
      console.log(`已生成 ${relative(process.cwd(), join(dir, "arena.d.ts"))} 和 PROMPT.md`)
      return
    }
    case "init": {
      await cmdInit(pos)
      return
    }
    case "check": {
      const t = await target(pos, "check")
      if (t.bots.length === 0) fail("缺少 bot 文件")
      await cmdCheck(t.rules, t.bots, opt)
      return
    }
    case "run": {
      const t = await target(pos, "run")
      // bot 目录里不写对手：打基准 bot，人数不够就都补基准
      if (t.mine && t.bots.length === 1) while (t.bots.length < t.rules.players.min) t.bots.push("baseline")
      await cmdRun(t.rules, t.bots, opt)
      return
    }
    case "view": {
      const port = typeof opt.port === "string" ? Number(opt.port) : 5180
      if (!Number.isInteger(port) || port < 1 || port > 65535) fail("--port 要是 1~65535 的整数")
      // 对战页在后台用 node 执行同一个命令入口来跑比赛
      serveViewer(pos[0] ?? "replays", port, process.argv[1], opt.open === true)
      return
    }
    default:
      console.log(HELP)
      if (command && command !== "help") process.exit(1)
  }
}

await main()
