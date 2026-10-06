// 命令行入口：rts-arena <命令> ...（在平台仓库里开发时等价于 npm run arena -- <命令> ...）
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { checkLimits } from "../core/limits.ts"
import { runMatch, type MatchBot } from "../core/match.ts"
import { mixSeed } from "../core/rng.ts"
import type { Replay, Ruleset } from "../core/types.ts"
import { compileBot, createBot } from "../sandbox/quickjs.ts"
import { botTsconfig, buildDts, buildPrompt, lineups, setupWorld, typecheck, typecheckRuleset } from "./docgen.ts"
import { serveViewer } from "./serve.ts"
import {
  findRuleset,
  knownBotFile,
  knownBots,
  referenceBots,
  listRulesets,
  loadRulesetRef,
  looksLikePath,
  readWorkspaceIn,
  rulesetHint,
  WORKSPACE_FILE,
  type RulesetRef,
  type Workspace,
} from "./catalog.ts"
import { PKG_ROOT } from "../paths.ts"
import { buildReport } from "./report.ts"
import { leagueStandings, leagueTables, standingsText, teamSplits, type LeagueGame, type LeagueResult } from "./league.ts"
import { LeagueStats, statsText, type LeagueStatsJson } from "./league-stats.ts"
import { excitement, gameFacts, pickHighlights, type GameFacts, type Highlight } from "./highlights.ts"
import { videoBrief, type VideoScript } from "../video/brief.ts"
import { renderLeagueVideo } from "../video/render.ts"
import { BASELINE as TEMPLATE_BASELINE, GREEDY as TEMPLATE_GREEDY, INDEX as TEMPLATE_INDEX, RUSH as TEMPLATE_RUSH, writeRulesTemplate } from "./rules-template.ts"

const HELP = `用法：rts-arena <命令> [参数]

<规则包> 是平台自带规则包的名字（见 list），或者自己写的规则包目录（如 ./my-rules）。规则包都在沙箱里跑。

在 bot 目录里（有 arena.json 的目录，用 init 建）：
  init <规则包> [目录]                   建 bot 目录（默认当前目录）：arena.json、bot.ts 模板、PROMPT.md、arena.d.ts、tsconfig.json
  init                                  在 bot 目录里重新生成说明书和接口（平台升级后跑一次），不动 bot.ts
  check [--ticks N]                     检查自己的 bot：类型检查 + 在每个位置上和不动的对手试打 N tick（默认 300）
  run [对手...] [选项]                  自己的 bot 打对手（不写就打 baseline），回放和日志写到 ./replays
  league [对手...] [选项]               联赛：自己的 bot 和对手循环对打，出排行榜（不写对手就和所有现成的 bot 打）
  view [回放目录] [--port N] [--open]   网页播放器（默认看 ./replays，端口 5180；--open 起来后打开浏览器）
  video-brief [联赛汇总] [--out 文件]   联赛视频的素材包（给大模型写脚本用）：选手文件名、代码风格、成绩、精彩对局、脚本模板
  video [联赛汇总] --script 脚本.json [--out 视频.mp4] [--preview 秒,秒] [--check 秒,秒]
                                        按脚本渲染联赛视频（片头片尾平台署名、标题和用户原话、选手介绍、排行榜、精彩对局），
                                        用本机的 Chrome / Edge 渲染；--preview 只出这几秒的预览图，--check 出完视频后从成品里截图检查
                                        （不写联赛汇总就用 ./replays 里最新的一场联赛；写法见平台仓库的 skills/league-video/SKILL.md）
  report [回放] [--player N] [--every T] [--full]
                                        文字战报：每隔 T tick 双方的经济、兵力、建筑，关键事件、战斗、损失、可能的问题
                                        （不写回放就看 ./replays 里最新的一局；不写 --player 就按你的 bot 坐的座位写；
                                        事件太多时会省略中间的，--full 全部列出）

在任何目录：
  list [规则包]                         列出规则包和现成的 bot（写了规则包就列出它的参考 bot 和打法）
  docs  <规则包> [--out 目录]            生成 arena.d.ts 和 PROMPT.md（默认 ./out/<规则包>/）
  check <规则包> <bot>... [--ticks N]    检查指定的 bot
  run   <规则包> <bot>... [选项]         指定所有参赛 bot 打一局（或多局）
  league <规则包> <bot>... [选项]        联赛：这些 bot 循环对打（两人局或多人局），出排行榜和对阵表

写规则包：
  new-rules <目录>                      建一个规则包目录：能直接跑的示例规则包、写法说明 RULESET.md、接口副本 api/、tsconfig.json
                                        （对已有的规则包目录运行：只刷新 RULESET.md、api/ 这些平台提供的文件）
  check <规则包> [--ticks N]             检查规则包本身：类型检查、加载、各种人数试打 N tick、打一整局看结束判定

  <bot> 可以是文件路径，也可以是现成 bot 的名字：baseline（每个规则包的基准 bot）、idle（不动）等，见 list
run 的选项：
        --seed N      种子（默认随机）
        --games N     连打 N 局，最后报胜率；同一个种子把各方的位置轮换一遍（两人局就是换边各打一次）
        --teams 2v2   分队（规则包要支持），按给出的 bot 顺序分组：2v2 就是前 2 个一队、后 2 个一队
        --out 路径    回放目录，默认 ./replays；单局时也可以给 .json 文件名
        --no-check    跳过类型检查
        --quiet       每局只打一行（结果、谁出了错），最后的胜率照常打印
        --json        每行输出一个 JSON 事件（start / game / summary / warning / error），给程序读
league 的选项：
        --size K      每局几个人（默认 2；规则包不能两个人打时是它的最少人数）
        --per-table N 每桌打几局（默认轮换座位一圈，两人局默认每对 4 局；两人局也可以写 --per-pair）。
                      局数少时排名的误差很大：同一个 bot 写两次放进联赛，看两份差多少就知道
        --tables M    多人局的组合太多时抽几桌（默认：组合不超过 20 桌就全打，否则让每个 bot 大约上场 6 桌）
        --teams 2v2   分队联赛（规则包要支持分队）；--partners mixed 轮换搭档（默认，所有分组方式都打，
                      每个 bot 拿所在队的名次分），--partners same 每队由同一个 bot 组成（bot 不够一局的人数时默认）
        --seed、--out、--no-check、--json 同 run
                      名次分：第一名 1 分、最后一名 0 分、中间平分（两人局就是胜 1 平 0.5）；
                      等级分（1500 起）把名次拆成两两比较，按全部对局一起算，和打的先后顺序无关
`

/** HELP 里某个命令的那几行（命令行和续行、"xx 的选项"那一段）；没有这个命令返回 null */
function helpFor(cmd: string): string | null {
  const lines = HELP.split("\n")
  const out: string[] = []
  const head = new RegExp(`^  ${cmd.replace(/[^a-z-]/g, "")}(\\s|$)`)
  for (let i = 0; i < lines.length; i++) {
    if (head.test(lines[i])) {
      out.push(lines[i])
      while (i + 1 < lines.length && /^ {20,}\S/.test(lines[i + 1])) out.push(lines[++i])
    } else if (lines[i].startsWith(`${cmd} 的选项`)) {
      out.push("", lines[i])
      while (i + 1 < lines.length && /^ {6,}\S/.test(lines[i + 1])) out.push(lines[++i])
    }
  }
  if (!out.length) return null
  return `用法：rts-arena ${cmd} …（全部命令：rts-arena help）\n\n${out.join("\n")}`
}

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
  run: { seed: false, games: false, out: false, teams: false, "no-check": true, json: true, quiet: true },
  league: { seed: false, size: false, teams: false, partners: false, "per-table": false, "per-pair": false, tables: false, out: false, "no-check": true, json: true },
  check: { ticks: false },
  view: { port: false, open: true },
  report: { player: false, every: false, full: true },
  "video-brief": { out: false },
  video: { script: false, out: false, preview: false, check: false, browser: false, fps: false },
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

/** 认出并加载规则包；base 是相对路径的起点 */
async function loadRuleset(ref: string | undefined, base = "."): Promise<{ rules: Ruleset; src: RulesetRef }> {
  if (!ref) fail("缺少规则包。平台自带的：" + listRulesets().join("、") + "；自己写的规则包写目录路径")
  const src = findRuleset(ref, base) ?? fail(rulesetHint(ref))
  try {
    return { rules: await loadRulesetRef(src), src }
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
async function target(pos: string[], command: string): Promise<{ rules: Ruleset; src: RulesetRef; bots: string[]; mine: boolean }> {
  // 第一个参数是规则包（名字，或者里面有 index.ts 的目录）；bot 文件不会被当成规则包
  if (pos[0] !== undefined && findRuleset(pos[0])) return { ...(await loadRuleset(pos[0])), bots: pos.slice(1), mine: false }
  const ws = readWorkspace()
  if (!ws)
    fail(
      pos.length === 0
        ? `当前目录不是 bot 目录（没有 ${WORKSPACE_FILE}）。先 rts-arena init <规则包>，或者写成 rts-arena ${command} <规则包> <bot>...`
        : `"${pos[0]}" 不是规则包，当前目录也不是 bot 目录（没有 ${WORKSPACE_FILE}）。${rulesetHint(pos[0])}`,
    )
  if (!existsSync(ws.bot)) fail(`${WORKSPACE_FILE} 里写的 bot 文件 ${ws.bot} 不存在`)
  return { ...(await loadRuleset(ws.ruleset)), bots: [ws.bot, ...pos], mine: true }
}

/** rulesDir 是规则包目录，out 是写到哪 */
function writeDocs(rules: Ruleset, rulesDir: string, out: string): void {
  mkdirSync(out, { recursive: true })
  const dts = buildDts(rules, rulesDir)
  writeFileSync(join(out, "arena.d.ts"), dts)
  writeFileSync(join(out, "PROMPT.md"), buildPrompt(rules, rulesDir, dts))
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
function resolveBots(rules: Ruleset, src: RulesetRef, args: string[]): string[] {
  return args.map((a) => {
    if (existsSync(a)) return a
    const known = knownBotFile(src, a)
    if (known) return relative(process.cwd(), known)
    fail(`找不到 bot "${a}"：既不是文件，也不是「${rules.name}」的现成 bot（${knownBots(src).join("、")}）`)
  })
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 回放和日志里显示的 bot 文件：平台自带的写成"平台自带 bots/xxx.ts"，不写一长串相对路径 */
function displayFile(file: string): string {
  const abs = resolve(file)
  return abs.startsWith(PKG_ROOT + sep) ? `平台自带 ${relative(PKG_ROOT, abs).split(sep).join("/")}` : file
}

async function makeBots(rules: Ruleset, files: string[], seed: number, names: Map<string, string>): Promise<MatchBot[]> {
  const bots: MatchBot[] = []
  for (const [p, file] of files.entries()) {
    const name = names.get(file) ?? botName(file)
    const compiled = compileBot(readFileSync(file, "utf8"))
    if ("error" in compiled) bots.push({ name, file: displayFile(file), runner: null, loadError: compiled.error })
    else bots.push({ name, file: displayFile(file), runner: await createBot(compiled.code, mixSeed(seed, "bot", p), { fuel: rules.fuel }) })
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

async function cmdRun(rules: Ruleset, src: RulesetRef, args: string[], opt: Record<string, string | true>): Promise<void> {
  if (args.length < rules.players.min || args.length > rules.players.max)
    fail(`「${rules.name}」需要 ${rules.players.min}~${rules.players.max} 个 bot，给了 ${args.length} 个`)
  const files = resolveBots(rules, src, args)
  const names = botNames(files)
  if (!opt["no-check"]) {
    const out = typecheck(rules, src.dir, [...new Set(files)])
    if (out) fail(`类型检查没通过（加 --no-check 可以跳过）：\n${out}`)
    rulesetTypeWarning(src)
  }
  for (const w of checkLimits(rules)) warn(w)
  const games = opt.games ? Number(opt.games) : 1
  if (!Number.isInteger(games) || games < 1) fail("--games 要是正整数")
  const quiet = opt.quiet === true
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
  // 所有座位都是同一个 bot：换边打出来和原来一模一样，没有意义，改成每局换一个种子
  const mirror = n > 1 && new Set(files.map((f) => resolve(f))).size === 1
  if (mirror && games > 1) say("（所有座位是同一个 bot：每局换一个种子，不换边）")
  if (!mirror && k > 2 && games > 1 && games % k !== 0) warn(`--games ${games} 不是 ${k} 的倍数，最后一个种子没轮完所有位置`)
  if (!mirror && k === 2 && games > 1 && games % 2 === 1) warn(`--games ${games} 是奇数，最后一个种子只打了一边`)
  /** 每个座位赢了几局（看出地图或规则包是不是偏向某一边） */
  const seatWins = new Array<number>(n).fill(0)
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
    const seed = mirror ? baseSeed + g : baseSeed + Math.floor(g / k)
    const rotated = [...Array(k).keys()].map((t) => groups[(t + g) % k])
    const seats = rotated.flat()
    const teams = rotated.flatMap((members, t) => members.map(() => t))
    const order = seats.map((i) => files[i])
    // --out 以 .json 结尾是单局的回放文件名，否则是目录
    const file = games === 1 && outOpt?.endsWith(".json") ? outOpt : join(outOpt ?? "replays", `${rules.id}-${stamp()}-${runId}-s${seed}-g${g + 1}.json`)
    const { replay, ms, logs } = await playAndSave(rules, order, names, seed, teams, file, g + 1)
    const lineup =
      k === n
        ? order.map((f, p) => `P${p}=${names.get(f)}`).join("  ")
        : rotated.map((members, t) => `队${t + 1}[${members.map((i) => `P${seats.indexOf(i)}=${names.get(files[i])}`).join(" ")}]`).join(" 对 ")
    if (quiet) {
      const r = replay.result
      const w = r.winners ?? []
      const trouble = replay.bots
        .filter((b) => b.status === "dead" || b.errors || b.fuelOuts)
        .map((b) => `P${b.player} ${b.status === "dead" ? "已停止" : `报错 ${b.errors}、燃料耗尽 ${b.fuelOuts}`}`)
      say(
        `第 ${g + 1}/${games} 局  种子 ${seed}  ${lineup}：${w.length ? `${w.map((p) => `P${p}`).join("、")} 赢` : "平局"}（第 ${r.tick} tick，${r.reason}）${trouble.length ? `  ！${trouble.join("；")}` : ""}  ${basename(file)}`,
      )
    } else {
      say(`第 ${g + 1} 局  种子 ${seed}  ${lineup}  用时 ${(ms / 1000).toFixed(1)} 秒`)
      if (!jsonMode) printResult(replay)
      say(`  回放：${relative(process.cwd(), file)}`)
      for (const l of logs) say(`  P${l.seat} 的日志：${relative(process.cwd(), join(dirname(file), l.file))}`)
    }
    const ranking = replay.result.ranking!
    const won = replay.result.winners ?? []
    if (won.length === 0) draws++
    for (let p = 0; p < n; p++) {
      const place = 1 + ranking.findIndex((group) => group.includes(p))
      seatStats[seats[p]].places.push(place)
      if (won.includes(p)) seatStats[seats[p]].wins++
      if (won.includes(p)) seatWins[p]++
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
      bots: botsBrief(replay),
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
    /** seatWins[p]：坐在 P{p} 的赢了几局 */
    seatWins,
  }
  saveSeries()
  emit0(series.summary)
  say(`（回放和日志在 ${relative(process.cwd(), dirname(seriesFile)) || "."}；每个 bot 的日志开头附了一份它视角的战报；任何回放都可以用 rts-arena report <回放> --player N 看）`)
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
    console.log(`按座位：${seatWins.map((w, p) => `P${p} 赢 ${w}`).join("，")}${mirror ? "（自己打自己时这一行就是看地图和规则包偏不偏向某一边）" : ""}`)
  }
}

/** 目录里最新的回放文件（不算 .series.json） */
function latestReplay(dir: string): string | null {
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".series.json"))
    .map((f) => join(dir, f))
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return files[0] ?? null
}

/**
 * 打一局，写回放和每个 bot 一份只有它自己信息的日志（开头附它视角的战报）。
 * 规则包出错（沙箱规则包的燃料、超时、返回值不对等）时这一局作废，整条命令停下
 */
async function playAndSave(
  rules: Ruleset,
  order: string[],
  names: Map<string, string>,
  seed: number,
  teams: number[] | undefined,
  file: string,
  gameNo: number,
): Promise<{ replay: Replay; ms: number; logs: { seat: number; name: string; file: string }[] }> {
  const bots = await makeBots(rules, order, seed, names)
  const t0 = performance.now()
  let replay: Replay
  try {
    replay = runMatch({ ruleset: rules, bots, seed, teams })
  } catch (e) {
    fail(`第 ${gameNo} 局（种子 ${seed}）没打完：${(e as Error).message}`)
  }
  const ms = performance.now() - t0
  for (const w of checkLimits(rules, replay)) warn(w)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(replay))
  const stem = file.replace(/\.json$/, "")
  const logs: { seat: number; name: string; file: string }[] = []
  for (let p = 0; p < order.length; p++) {
    const logFile = `${stem}.P${p}-${safeName(names.get(order[p])!)}.log`
    writeFileSync(logFile, botLog(replay, p, gameNo))
    logs.push({ seat: p, name: names.get(order[p])!, file: basename(logFile) })
  }
  return { replay, ms, logs }
}

/** 每局的 bot 统计（对战页用） */
const botsBrief = (replay: Replay) =>
  replay.bots.map((b) => ({ seat: b.player, calls: b.calls, errors: b.errors, fuelOuts: b.fuelOuts, rejected: b.rejected, status: b.status, deadReason: b.deadReason }))

/**
 * 本地联赛，三种赛制：
 * - 各自为战（默认）：每局 size 个人，参赛的 bot 按组合分桌（组合多时抽桌）；
 * - 分队、轮换搭档（--teams 2v2，bot 够多时默认）：每桌挑够人数的 bot，所有分组方式都打、各队轮换位置，每个 bot 拿所在队的名次分；
 * - 分队、同一个 bot 组队（--teams 2v2 --partners same）：每队由同一个 bot 的几份副本组成，参赛者就是这些"队"。
 * 同一桌每轮用同一个种子轮换位置；先把每桌的第 1 局都打完再打第 2 局，中途停下时各桌打的局数差不多。
 * 出排行榜（名次分、得分率、等级分）、对阵表（分队时还有搭档表）和统计
 */
/** mine：在 bot 目录里跑的，第一个参赛者是自己的 bot */
async function cmdLeague(rules: Ruleset, src: RulesetRef, args: string[], opt: Record<string, string | true>, mine = false): Promise<void> {
  const { min, max } = rules.players
  const intOpt = (key: string): number | undefined => {
    const v = opt[key]
    if (v === undefined) return undefined
    const x = typeof v === "string" ? Number(v) : NaN
    if (!Number.isInteger(x)) fail(`--${key} 要是整数`)
    return x
  }
  // ---------- 赛制 ----------
  const teamSpec = typeof opt.teams === "string" ? opt.teams : undefined
  let sizes: number[] | null = null
  if (opt.teams !== undefined) {
    if (!teamSpec || !/^\d+(v\d+)+$/.test(teamSpec)) fail("--teams 要写成 2v2、3v3、2v2v2、3v1 这样")
    sizes = teamSpec.split("v").map(Number)
    if (sizes.some((s) => s < 1)) fail("--teams 里每队至少 1 人")
    if (!rules.teams) fail(`「${rules.name}」不支持分队`)
    if (opt.size !== undefined) fail("分队联赛每局的人数由 --teams 决定，不要再写 --size")
  }
  const players = sizes ? sizes.reduce((a, b) => a + b, 0) : (intOpt("size") ?? (min <= 2 && max >= 2 ? 2 : min))
  if (players < Math.max(2, min) || players > max)
    fail(`「${rules.name}」每局 ${min}～${max} 人，${sizes ? `--teams ${teamSpec} 一共 ${players} 人` : `--size ${players}`} 不行${min < 2 ? "（联赛每局至少 2 人）" : ""}`)
  const partnersOpt = opt.partners
  if (partnersOpt !== undefined && !sizes) fail("--partners 只在分队联赛（--teams）里用")
  if (partnersOpt !== undefined && partnersOpt !== "mixed" && partnersOpt !== "same") fail("--partners 要写 mixed（轮换搭档）或 same（同一个 bot 组队）")
  const N = args.length
  const mode: "ffa" | "mixed" | "same" = !sizes ? "ffa" : partnersOpt === "same" ? "same" : partnersOpt === "mixed" || N >= players ? "mixed" : "same"
  /** 每局几方（各自为战是人数，分队是队数） */
  const sides = sizes ? sizes.length : players
  /** 每桌要几个参赛者 */
  const unit = mode === "same" ? sides : players
  if (N < unit)
    fail(
      mode === "mixed"
        ? `轮换搭档每局要 ${players} 个不同的 bot，只给了 ${N} 个；bot 不够时用 --partners same（每队由同一个 bot 组成）`
        : `每局 ${unit} 方，至少要 ${unit} 个 bot`,
    )
  if (N > 16) fail("联赛最多 16 个 bot")
  const files = resolveBots(rules, src, args)
  const names = botNames(files)
  // 同一个 bot 可以写好几次（看看它和自己的副本打得怎样、给排行榜当参照）：和 run 一样带上编号
  const twice = (f: string) => files.filter((g) => resolve(g) === resolve(f)).length > 1
  const labels = files.map((f, i) => (twice(f) ? `${names.get(f)}#${i + 1}` : names.get(f)!))
  // 名字和文件名对不上的（bot.ts 用的是目录名），说一声哪个名字是哪个文件
  const renamed = [...new Set(files)].filter((f) => names.get(f) !== basename(f).replace(/\.ts$/, ""))
  if (renamed.length) say(`（名字对应的文件：${renamed.map((f) => `${names.get(f)} = ${displayFile(f)}`).join("，")}）`)
  if (mode === "mixed" && files.some((f) => botName(f) === "idle"))
    warn("轮换搭档的分队联赛里有 idle：分到它当队友的 bot 等于少一个人打，排名会受分到谁的运气影响；想要参照物可以换成 baseline")
  if (!opt["no-check"]) {
    const out = typecheck(rules, src.dir, [...new Set(files)])
    if (out) fail(`类型检查没通过（加 --no-check 可以跳过）：\n${out}`)
    rulesetTypeWarning(src)
  }
  for (const w of checkLimits(rules)) warn(w)
  const tablesOpt = intOpt("tables")
  if (tablesOpt !== undefined && tablesOpt < 1) fail("--tables 要是正整数")
  const baseSeed = typeof opt.seed === "string" ? Number(opt.seed) : Math.floor(Math.random() * 1e9)
  if (!Number.isInteger(baseSeed)) fail("--seed 要是整数")
  const outDir = typeof opt.out === "string" ? opt.out : "replays"
  if (outDir.endsWith(".json")) fail("联赛的 --out 要写目录")
  const schedule = leagueTables(N, unit, baseSeed, tablesOpt)
  const tables = schedule.tables

  // 每桌的一轮：位置怎么排。slots[t] 是第 t 方（各自为战是第 t 个座位，分队是第 t 队）的参赛者；variant 不同的用不同的种子
  const equalSizes = !sizes || sizes.every((s) => s === sizes![0])
  const layoutsOf = (table: number[]): { slots: number[][]; variant: number }[] => {
    const rotate = <T>(xs: T[], r: number) => [...xs.slice(r), ...xs.slice(0, r)]
    if (mode !== "mixed") return [...Array(sides).keys()].map((r) => ({ slots: rotate(table, r).map((p) => [p]), variant: 0 }))
    // 轮换搭档：所有分法；队伍一样大时再轮换各队的位置（先把每种分法打一遍，再换位置）
    const splits = teamSplits(table, sizes!)
    const out = []
    for (let r = 0; r < (equalSizes ? sides : 1); r++) for (const [si, split] of splits.entries()) out.push({ slots: rotate(split, r), variant: si })
    return out
  }
  const cycle = layoutsOf(tables[0]).length
  // 默认一轮；两人局一轮只有 2 局，误差太大，默认打两轮（每对 4 局）
  const perTable = intOpt("per-table") ?? intOpt("per-pair") ?? (cycle === 2 ? 4 : cycle)
  if (perTable < 1 || perTable > 200) fail("--per-table 要是 1～200")
  if (perTable % cycle !== 0) warn(`每桌 ${perTable} 局不是 ${cycle} 的倍数，${mode === "mixed" ? "分法和位置" : "座位"}没轮换完整`)
  const total = tables.length * perTable
  if (total > 5000) fail(`一共要打 ${total} 局，太多了；减少 bot、--per-table，或者用 --tables 少抽几桌`)

  const runId = randomBytes(3).toString("hex")
  const seriesFile = join(outDir, `${rules.id}-${stamp()}-${runId}.series.json`)
  const participants = files.map((f, i) => ({ name: labels[i], file: f }))
  const stats = new LeagueStats(labels)
  const series = {
    format: "rts-arena-series",
    version: 1,
    kind: "league",
    ruleset: { id: rules.id, name: rules.name },
    startedAt: new Date().toISOString(),
    seed: baseSeed,
    games: total,
    size: players,
    teams: teamSpec ?? null,
    partners: mode === "ffa" ? null : mode,
    perTable,
    tables: tables.length,
    complete: schedule.complete,
    participants,
    results: [] as Record<string, unknown>[],
    /** 打到现在的排名和统计（每局更新） */
    standings: null as LeagueResult | null,
    stats: null as LeagueStatsJson | null,
    summary: null as Record<string, unknown> | null,
  }
  const saveSeries = () => {
    mkdirSync(dirname(seriesFile), { recursive: true })
    writeFileSync(seriesFile, JSON.stringify(series, null, 1))
  }
  emit0({ type: "start", league: true, ruleset: rules.id, name: rules.name, games: total, size: players, teams: series.teams, partners: series.partners, perTable, tables: tables.length, complete: schedule.complete, seed: baseSeed, participants, series: basename(seriesFile) })
  const rounds = perTable % cycle === 0
  const notFull = `不到整轮：一轮是 ${cycle} 局`
  const how =
    mode === "ffa"
      ? players === 2
        ? `两两对打，${tables.length} 对，每对 ${perTable} 局（${rounds ? "换边" : notFull}）`
        : `每局 ${players} 人，${schedule.complete ? "所有组合" : "抽了"} ${tables.length} 桌，每桌 ${perTable} 局（${rounds ? "轮换座位" : notFull}）`
      : mode === "mixed"
        ? `分队 ${teamSpec}、轮换搭档，${schedule.complete ? "所有组合" : "抽了"} ${tables.length} 桌，每桌 ${perTable} 局（${rounds ? `每种分法都打${equalSizes ? "、各队轮换位置" : ""}` : notFull}）`
        : `分队 ${teamSpec}、每队是同一个 bot${partnersOpt === undefined ? `（bot 不够一局的 ${players} 人，自动用这种，没有搭档表；要轮换搭档就给够 ${players} 个 bot）` : ""}，${schedule.complete ? "所有组合" : "抽了"} ${tables.length} 桌，每桌 ${perTable} 局（${rounds ? "轮换位置" : notFull}）`
  say(`联赛：${rules.name}（${rules.id}），${N} 个 bot（${labels.join("、")}），${how}，共 ${total} 局，种子从 ${baseSeed} 起`)

  const record: LeagueGame[] = []
  /** 每局的看点，打完再按最终排名算爆冷、挑精彩对局 */
  const played: { index: number; seed: number; replay: string; tick: number; seats: number[]; sideOf: number[]; facts: GameFacts }[] = []
  let index = 0
  for (let g = 0; g < perTable; g++)
    for (const [ti, table] of tables.entries()) {
      index++
      const layouts = layoutsOf(table)
      const layout = layouts[g % layouts.length]
      // 同一桌、同一轮里只是换位置的几局用同一个种子
      const seed = baseSeed + ti * 10000 + Math.floor(g / layouts.length) * 100 + layout.variant
      const slots = layout.slots
      const seats = slots.flatMap((group, t) => (mode === "same" ? Array<number>(sizes![t]).fill(group[0]) : group))
      const teams = sizes ? slots.flatMap((group, t) => Array<number>(mode === "same" ? sizes![t] : group.length).fill(t)) : undefined
      const order = seats.map((i) => files[i])
      const file = join(outDir, `${rules.id}-${stamp()}-${runId}-s${seed}-g${index}.json`)
      const { replay, ms, logs } = await playAndSave(rules, order, names, seed, teams, file, index)
      // 名次换成参赛者编号（同一个 bot 组队时去重）
      const seen = new Set<number>()
      const ranking = (replay.result.ranking ?? [])
        .map((group) => [...new Set(group.map((p) => seats[p]))].filter((x) => !seen.has(x) && (seen.add(x), true)))
        .filter((group) => group.length > 0)
      record.push(mode === "mixed" ? { players: seats, ranking, teams: slots } : mode === "same" ? { players: slots.map((s) => s[0]), ranking } : { players: seats, ranking })
      stats.add(seats, replay)
      played.push({ index, seed, replay: basename(file), tick: replay.result.tick, seats, sideOf: replay.players.map((pl, p) => pl.team ?? p), facts: gameFacts(replay) })
      const won = replay.result.winners ?? []
      let lineup: string
      let outcome: string
      if (!sizes) {
        lineup = seats.map((i, p) => `P${p}=${labels[i]}`).join(" ")
        outcome = players === 2 ? (ranking[0]?.length === 1 ? `${labels[ranking[0][0]]} 赢` : "平局") : `名次 ${ranking.map((grp) => grp.map((i) => labels[i]).join(" = ")).join(" > ")}`
      } else {
        lineup = slots.map((_, t) => `队${t + 1}[${seats.map((i, p) => (teams![p] === t ? `P${p}=${labels[i]}` : "")).filter(Boolean).join(" ")}]`).join(" 对 ")
        const winTeams = [...new Set(won.map((p) => teams![p]))]
        outcome = winTeams.length === 1 ? `队${winTeams[0] + 1} 赢` : "平局"
      }
      say(`第 ${index}/${total} 局  ${lineup}  种子 ${seed}：${outcome}（第 ${replay.result.tick} tick，${replay.result.reason}）  用时 ${(ms / 1000).toFixed(1)} 秒  ${basename(file)}`)
      const entry = {
        type: "game",
        index,
        table,
        seed,
        seats,
        names: order.map((f) => names.get(f)),
        teams: teams ?? seats.map((_, p) => p),
        winners: won,
        ranking: replay.result.ranking,
        reason: replay.result.reason,
        tick: replay.result.tick,
        ms: Math.round(ms),
        replay: basename(file),
        logs,
        bots: botsBrief(replay),
      }
      series.results.push(entry)
      series.standings = leagueStandings(labels, record)
      series.stats = stats.toJSON()
      saveSeries()
      emit0(entry)
      emit0({ type: "standings", ...series.standings, stats: series.stats })
    }
  const st = leagueStandings(labels, record)
  const highlights = leagueHighlights(played, st, labels, mine ? 0 : undefined)
  series.summary = {
    type: "summary",
    league: true,
    size: players,
    // 分队写法（"2v2"）；不叫 teams，免得和普通比赛汇总里的 teams（各队战绩）混在一起
    teamSpec: series.teams,
    partners: series.partners,
    games: total,
    draws: record.filter((g) => (g.ranking[0]?.length ?? 0) > 1).length,
    standings: st.table,
    matrix: st.matrix,
    partnersMatrix: st.partners ?? null,
    stats: stats.toJSON(),
    highlights,
    // 和普通比赛的汇总一样的字段，老的显示方式也能看
    participants: st.table.map((s) => ({ name: s.name, file: files[s.index], wins: s.wins, avgPlace: s.avgPlace })),
  }
  saveSeries()
  emit0(series.summary)
  if (!jsonMode) {
    console.log("\n" + standingsText(labels, st, { multi: sides > 2 || mode === "mixed", teams: mode === "mixed" }))
    console.log("\n" + statsText(stats.toJSON(), st))
    console.log("\n" + highlightsText(highlights))
    if (mine) {
      // 自己的 bot 输掉的局（没拿到第一的），方便直接去看回放
      const lost = played.filter((g) => {
        const side = (i: number) => g.sideOf[g.seats.indexOf(i)]
        return g.seats.includes(0) && g.facts.winner !== side(0)
      })
      console.log(`\n## 你的 bot（${labels[0]}）没拿到第一的局：${lost.length} 局`)
      for (const g of lost.slice(0, 12)) {
        const foes = [...new Set(g.seats.filter((i) => i !== 0))].map((i) => labels[i]).join("、")
        console.log(`  第 ${g.index} 局 对 ${foes}（${g.facts.winner === null ? "平局" : "输了"}，第 ${g.tick} tick）  ${g.replay}`)
      }
      if (lost.length > 12) console.log(`  另有 ${lost.length - 12} 局`)
    }
  }
  say(`\n回放和每个 bot 的日志在 ${outDir}；排名和统计记在 ${relative(process.cwd(), seriesFile)}；看某一局：rts-arena report <回放>`)
}

/** 自己写的规则包没通过类型检查：只提醒（比赛照打），详情让规则包作者用 check 看 */
function rulesetTypeWarning(src: RulesetRef): void {
  if (src.builtin) return
  const out = typecheckRuleset(src.dir)
  if (!out) return
  const rel = relative(process.cwd(), src.dir).split(sep).join("/") || "."
  // 不带 ./ 会被当成平台自带规则包的名字
  const at = rel.startsWith(".") || rel.startsWith("/") || /^[a-zA-Z]:/.test(rel) ? rel : `./${rel}`
  const lines = out.trim().split("\n")
  warn(`规则包 ${at} 没通过类型检查（不影响这次比赛；规则包作者用 rts-arena check ${at} 看详情）：\n${lines.slice(0, 3).join("\n")}${lines.length > 3 ? `\n…还有 ${lines.length - 3} 行` : ""}`)
}

/**
 * 联赛的精彩对局：每局的看点（逆转、优势换手、大战、险胜）加上按最终排名算的爆冷（得分率低的赢了高的），
 * 挑精彩度最高的几局（同一组对手最多 2 局）
 */
function leagueHighlights(
  played: { index: number; seed: number; replay: string; tick: number; seats: number[]; sideOf: number[]; facts: GameFacts }[],
  st: LeagueResult,
  labels: string[],
  mine?: number,
): Highlight[] {
  const rate = new Map(st.table.map((s) => [s.index, s.rate]))
  const all = played.map((g) => {
    const members = (side: number) => [...new Set(g.seats.filter((_, p) => g.sideOf[p] === side))]
    const name = (side: number) => members(side).map((i) => labels[i]).join("+")
    const sideRate = (side: number) => {
      const m = members(side)
      return m.reduce((a, i) => a + (rate.get(i) ?? 0), 0) / Math.max(1, m.length)
    }
    const f = g.facts
    let upset: { level: number; text: string } | null = null
    if (f.winner !== null) {
      const foe = f.sides.filter((x) => x !== f.winner).sort((a, b) => sideRate(b) - sideRate(a))[0]
      if (foe !== undefined) {
        const gap = sideRate(foe) - sideRate(f.winner)
        upset = {
          level: Math.max(0, Math.min(1, gap / 0.4)),
          text: `爆冷：联赛得分率 ${Math.round(sideRate(f.winner) * 100)}% 的 ${name(f.winner)} 赢了 ${Math.round(sideRate(foe) * 100)}% 的 ${name(foe)}`,
        }
      }
    }
    const { score, reasons } = excitement(f, upset, name)
    return {
      index: g.index,
      seed: g.seed,
      replay: g.replay,
      who: f.sides.map(name).join(" 对 "),
      winner: f.winner === null ? null : name(f.winner),
      tick: g.tick,
      score,
      reasons,
      key: f.sides
        .map((x) => members(x).sort((a, b) => a - b).join(","))
        .sort()
        .join("|"),
    }
  })
  const byIndex = new Map(played.map((g) => [g.index, g]))
  return pickHighlights(all, Math.min(5, Math.max(1, Math.round(played.length / 4))), (h) => mine !== undefined && !!byIndex.get(h.index)?.seats.includes(mine))
}

function highlightsText(list: Highlight[]): string {
  const lines = ["## 精彩对局（按逆转、优势换手、大战、险胜、爆冷打的精彩度挑的）"]
  if (list.length === 0) lines.push("  这次没有特别精彩的：大多是一边倒，或者没怎么打起来")
  list.forEach((h, i) => {
    lines.push(`  ${i + 1}. 第 ${h.index} 局 ${h.who}，${h.winner ? `${h.winner} 赢` : "平局"}（第 ${h.tick} tick，精彩度 ${h.score}）`)
    lines.push(`     ${h.reasons.join("；")}`)
    lines.push(`     回放 ${h.replay}`)
  })
  return lines.join("\n")
}

/** 联赛汇总文件：给了文件就用它；给了目录或者没给，就找里面（默认 ./replays）最新的一场联赛 */
function findLeagueSeries(arg: string | undefined): string {
  const dir = arg === undefined ? "replays" : arg
  if (arg !== undefined && !(existsSync(arg) && statSync(arg).isDirectory())) {
    if (!existsSync(arg)) fail(`找不到 ${arg}`)
    return arg
  }
  if (!existsSync(dir)) fail(`${dir} 不存在；写成 rts-arena video <联赛汇总 *.series.json>`)
  const leagues = readdirSync(dir)
    .filter((f) => f.endsWith(".series.json"))
    .map((f) => join(dir, f))
    .filter((f) => {
      try {
        return (JSON.parse(readFileSync(f, "utf8")) as { kind?: string }).kind === "league"
      } catch {
        return false
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return leagues[0] ?? fail(`${dir} 里没有联赛的汇总文件（先跑 rts-arena league）`)
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
    `# ${me.name} 的对局日志（只有这个 bot 自己的信息；后面附了战报）`,
    `规则包：${replay.ruleset.name}（${replay.ruleset.id}）  种子：${replay.seed}  第 ${game} 局`,
    `你是 P${p}（${me.bot}）${allies.length ? `；盟友：${allies.join("、")}` : ""}；对手：${others.join("、")}`,
    `结果：第 ${r.tick} tick，${outcome}——${r.reason}${replay.players.length > 2 ? `；你的名次 ${place} / ${replay.players.length}` : ""}`,
    `统计：调用 ${st.calls} 次，燃料平均 ${avg} 最高 ${st.fuelMax}，报错 ${st.errors}，燃料耗尽 ${st.fuelOuts}，被拒命令 ${st.rejected}${st.status === "dead" ? `，停止运行：${st.deadReason}` : ""}`,
    "",
    // 战报是全局视角（赛后复盘，双方信息都有），从这个 bot 的座位写
    buildReport(replay, { player: p }).replace(/^# /, "## ").replace(/\n## /g, "\n### ").trimEnd(),
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

async function cmdCheck(rules: Ruleset, src: RulesetRef, args: string[], opt: Record<string, string | true>): Promise<void> {
  const files = resolveBots(rules, src, args)
  const checkTicks = typeof opt.ticks === "string" ? Number(opt.ticks) : CHECK_TICKS
  if (!Number.isInteger(checkTicks) || checkTicks < 1) fail("--ticks 要是正整数")
  let ok = true
  const out = typecheck(rules, src.dir, files)
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
      let replay: Replay
      try {
        replay = runMatch({ ruleset: { ...rules, maxTicks: Math.min(rules.maxTicks, checkTicks) }, bots, seed: 1 })
      } catch (e) {
        ok = false
        console.log(`${file}（位置 P${seat}）：试打时规则包出错：${(e as Error).message}`)
        continue
      }
      const st = replay.bots[seat]
      const errs = replay.frames.flatMap((f) => (f.errs ?? []).filter((e) => e.p === seat).map((e) => `第 ${f.t} tick：${e.msg}`))
      const where = `${file}（位置 P${seat}）`
      if (st.status === "dead" || st.errors > 0 || st.fuelOuts > 0) {
        ok = false
        console.log(`${where}：试打 ${replay.result.tick} tick 出了问题${st.deadReason ? `，bot 停止运行：${st.deadReason}` : ""}`)
      } else {
        console.log(`${where}：试打 ${replay.result.tick} tick 通过（调用 ${st.calls} 次，燃料最高 ${st.fuelMax}，被拒命令 ${st.rejected}）`)
      }
      // bot 自己的 console.log：第一个位置上打印前几行（onStart 里打的也在）
      if (seat === 0) {
        const logs = replay.frames.flatMap((f) => (f.logs ?? []).filter((l) => l.p === seat).flatMap((l) => l.text.map((t) => `t${f.t} ${t}`)))
        if (logs.length) {
          console.log(`  bot 的日志（前 ${Math.min(5, logs.length)} 行，共 ${logs.length} 行）：`)
          for (const l of logs.slice(0, 5)) console.log(`    ${l.slice(0, 200)}`)
        }
      }
      for (const line of errs.slice(0, 5)) console.log(`  ${line.split("\n").slice(0, 3).join(" | ")}`)
      if (errs.length > 5) console.log(`  另有 ${errs.length - 5} 条，见 run 的回放`)
    }
  }
  if (!ok) process.exit(1)
}

/**
 * 检查规则包本身：类型检查（自己写的规则包）、加载和格式、说明书能生成、bots/ 里的 bot 过类型检查，
 * 每种人数（支持分队时再加 2v2）试打 N tick，最后用不动的 bot 打一整局，看 result / timeUp 能不能正常给出结果
 */
async function cmdCheckRules(src: RulesetRef, opt: Record<string, string | true>): Promise<void> {
  const checkTicks = typeof opt.ticks === "string" ? Number(opt.ticks) : CHECK_TICKS
  if (!Number.isInteger(checkTicks) || checkTicks < 1) fail("--ticks 要是正整数")
  let ok = true
  const bad = (msg: string) => {
    ok = false
    console.log(msg)
  }
  const tsOut = typecheckRuleset(src.dir)
  if (tsOut) bad(`规则包类型检查没通过：\n${tsOut}`)
  else console.log("规则包类型检查通过")
  let rules: Ruleset
  try {
    rules = await loadRulesetRef(src)
  } catch (e) {
    console.log(`加载失败：${(e as Error).message}`)
    process.exit(1)
  }
  console.log(`在沙箱里加载通过：「${rules.name}」（${rules.id}），${rules.players.min}～${rules.players.max} 人${rules.teams ? "，支持分队" : ""}`)
  for (const w of checkLimits(rules)) console.log(`提醒：${w}`)
  try {
    buildPrompt(rules, src.dir, buildDts(rules, src.dir))
    console.log("说明书（PROMPT.md、arena.d.ts）能生成")
  } catch (e) {
    bad(`说明书生成不了：${(e as Error).message}`)
  }
  // setup 里 spawnNear 没找到空位（静默返回 null，实体没放下）
  for (const l of lineups(rules)) {
    try {
      for (const note of setupWorld(rules, l.n, l.teams).notes) console.log(`提醒：${l.label}时，${note}。从建筑里面找会从它的外圈开始；找不到通常是附近太挤或者被墙围住了`)
    } catch {
      // setup 出错在后面试打时会报出来
    }
  }
  if (!src.builtin) {
    // 改了玩法（index.ts 和模板不一样）后，bots/ 里还是 new-rules 模板（采金赛）原样的 bot
    const norm = (s: string) => s.replace(/\r\n/g, "\n")
    const changed = existsSync(join(src.dir, "index.ts")) && norm(readFileSync(join(src.dir, "index.ts"), "utf8")).replace(/id: "[^"]*"/, `id: "__ID__"`) !== TEMPLATE_INDEX
    const tmpl = new Map([
      ["baseline", TEMPLATE_BASELINE],
      ["rush", TEMPLATE_RUSH],
      ["greedy", TEMPLATE_GREEDY],
    ])
    for (const b of referenceBots(src.dir)) {
      const t = tmpl.get(b.name)
      if (changed && t && norm(readFileSync(b.file, "utf8")) === t)
        console.log(`提醒：bots/${b.name}.ts 还是 new-rules 模板（采金赛）的原样。改了玩法后要换成按你的玩法写的 bot，或者删掉（类型检查和试打通过不代表它会玩你的玩法）`)
    }
    // objectives.ts 改过之后 bots/arena.d.ts 要跟着更新（编辑器用它）
    const dtsFile = join(src.dir, "bots", "arena.d.ts")
    const dts = buildDts(rules, src.dir)
    if (existsSync(dtsFile) && readFileSync(dtsFile, "utf8") !== dts) {
      writeFileSync(dtsFile, dts)
      console.log("已刷新 bots/arena.d.ts（objectives.ts 或实体类型改过了）")
    }
  }
  const botFiles = knownBots(src).map((n) => knownBotFile(src, n)!)
  const tc = typecheck(rules, src.dir, botFiles)
  if (tc) bad(`现成 bot 的类型检查没通过：\n${tc}`)
  else console.log(`现成 bot 类型检查通过：${knownBots(src).join("、")}`)
  // 参考 bot：鼓励几个不同打法的陪练，只有一个基准 bot 时写 bot 的人容易只对着它过拟合
  const refs = referenceBots(src.dir).filter((b) => b.name !== "idle")
  for (const b of refs) if (!b.about) console.log(`提醒：bots/${b.name}.ts 第一行没写打法说明（// 开头的一句话，会列进 PROMPT.md 的参考 bot 表）`)
  if (refs.length < 3)
    console.log(
      `提醒：参考 bot 只有 ${refs.length} 个（${refs.map((b) => b.name).join("、") || "无"}）。建议在 bots/ 里再写几个不同打法的陪练（速攻、先发展、守家、骚扰……），和 baseline 一起发布：只有一个基准 bot 时，写 bot 的人容易只对着它调、过拟合`,
    )

  const baseline = knownBotFile(src, "baseline")
  /** baselineSeats：哪些座位坐 baseline（没有 baseline 就都不动） */
  const lineup = async (n: number, seed: number, baselineSeats: number[] = [0]): Promise<MatchBot[]> => {
    const bots: MatchBot[] = []
    for (let p = 0; p < n; p++) {
      const file = baselineSeats.includes(p) && baseline ? baseline : "idle"
      const code = file === "idle" ? IDLE_CODE : (compileBot(readFileSync(file, "utf8")) as { code: string }).code ?? IDLE_CODE
      bots.push({ name: file === "idle" ? "idle" : "baseline", file, runner: await createBot(code, mixSeed(seed, "bot", p), { fuel: rules.fuel }) })
    }
    return bots
  }
  const configs: { n: number; teams?: number[] }[] = []
  for (let n = rules.players.min; n <= rules.players.max; n++) configs.push({ n })
  if (rules.teams && rules.players.max >= 4) configs.push({ n: 4, teams: [0, 0, 1, 1] })
  const who = baseline ? "P0 是 baseline、其余不动" : "都是不动的 bot"
  for (const c of configs) {
    const label = c.teams ? "2v2" : `${c.n} 人`
    try {
      const t0 = performance.now()
      const replay = runMatch({ ruleset: { ...rules, maxTicks: Math.min(rules.maxTicks, checkTicks) }, bots: await lineup(c.n, 1), seed: 1, teams: c.teams })
      const st = replay.bots[0]
      const botTrouble = baseline && (st.status === "dead" || st.errors > 0 || st.fuelOuts > 0)
      if (botTrouble) bad(`${label}（${who}）试打 ${replay.result.tick} tick：baseline 出了问题${st.deadReason ? `：${st.deadReason}` : `，报错 ${st.errors}、燃料耗尽 ${st.fuelOuts}`}`)
      else
        console.log(
          `${label}（${who}）试打 ${replay.result.tick} tick 通过，用时 ${((performance.now() - t0) / 1000).toFixed(1)} 秒，实体峰值 ${replay.perf.peakEntities}${baseline ? `，baseline 被拒命令 ${st.rejected}` : ""}`,
        )
    } catch (e) {
      bad(`${label} 试打时规则包出错：${(e as Error).message}`)
    }
  }
  // 整局：打到底看结束判定。有 baseline 时它在第一个、最后一个座位各打一次不动的对手，再自己打自己一次
  const m = rules.players.min
  const team4 = rules.teams && rules.players.min <= 4 && rules.players.max >= 4
  const full: { label: string; seats: number[]; n?: number; teams?: number[] }[] = baseline
    ? [
        { label: "P0 是 baseline、其余不动", seats: [0] },
        ...(m > 1 ? [{ label: `P${m - 1} 是 baseline、其余不动`, seats: [m - 1] }] : []),
        { label: "全是 baseline", seats: [...Array(m).keys()] },
        // 分队的胜负判定最容易出错：完整打一局 2v2
        ...(team4 ? [{ label: "分队 2v2，P0、P1 是 baseline，P2、P3 不动", seats: [0, 1], n: 4, teams: [0, 0, 1, 1] }] : []),
      ]
    : [{ label: "都是不动的 bot", seats: [] }]
  for (const [i, c] of full.entries()) {
    try {
      const t0 = performance.now()
      const replay = runMatch({ ruleset: rules, bots: await lineup(c.n ?? m, 2 + i, c.seats), seed: 2 + i, teams: c.teams })
      const r = replay.result
      console.log(`整局（${c.label}）：第 ${r.tick} tick 结束，${r.winners?.length ? `赢家 ${r.winners.map((p) => `P${p}`).join("、")}` : "平局"}——${r.reason}（用时 ${((performance.now() - t0) / 1000).toFixed(1)} 秒）`)
    } catch (e) {
      bad(`整局（${c.label}）打不完，规则包出错：${(e as Error).message}`)
    }
  }
  if (!ok) process.exit(1)
  console.log("规则包检查通过")
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
  let ref = pos[0]
  let dir = pos[1] ?? "."
  if (ref === undefined) {
    // 不带参数：更新当前 bot 目录
    const ws = readWorkspace() ?? fail(`用法：rts-arena init <规则包> [目录]。平台自带的规则包：${listRulesets().join("、")}`)
    ref = ws.ruleset
    dir = "."
  }
  const { rules, src } = await loadRuleset(ref)
  mkdirSync(dir, { recursive: true })
  const wsFile = join(dir, WORKSPACE_FILE)
  const old = existsSync(wsFile) ? (JSON.parse(readFileSync(wsFile, "utf8")) as Partial<Workspace>) : {}
  const bot = old.bot ?? "bot.ts"
  // 自己写的规则包记相对 bot 目录的路径（正斜杠，换台机器、换系统也能用）
  const rulesetField = src.builtin ? rules.id : relative(resolve(dir), src.dir).split(sep).join("/") || "."
  writeFileSync(wsFile, JSON.stringify({ ruleset: looksLikePath(rulesetField) || src.builtin ? rulesetField : `./${rulesetField}`, bot }, null, 2) + "\n")
  writeDocs(rules, src.dir, dir)
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
  jsonMode = (command === "run" || command === "league") && rest.includes("--json")
  const { pos, opt } = parseArgs(command, rest)
  switch (command) {
    case "list": {
      // list <规则包>：这个规则包的参考 bot 和打法
      if (pos[0]) {
        const { rules: r, src } = await loadRuleset(pos[0])
        console.log(`「${r.name}」（${r.id}）的参考 bot（命令里写名字就能和它打；rts-arena league 不写对手就和它们全部循环对打）：`)
        for (const b of referenceBots(src.dir)) console.log(`  ${b.name.padEnd(10)} ${b.about || "（没写打法说明）"}`)
        console.log(`源码在 ${join(src.dir, "bots")}${sep}（idle 在 ${join(PKG_ROOT, "bots")}${sep}）`)
        return
      }
      for (const id of listRulesets()) {
        const { rules: r, src } = await loadRuleset(id)
        console.log(`${id}\t${r.name}\t${r.players.min}~${r.players.max} 人${r.teams ? "、可分队" : ""}\t${r.summary ?? ""}`)
        console.log(`\t参考 bot：${knownBots(src).join("、")}`)
      }
      console.log("（rts-arena list <规则包> 看每个参考 bot 的打法；自己写的规则包用目录路径，比如 rts-arena run ./my-rules a.ts b.ts；rts-arena new-rules <目录> 建一个）")
      return
    }
    case "docs": {
      const { rules, src } = await loadRuleset(pos[0])
      const dir = typeof opt.out === "string" ? opt.out : join("out", rules.id)
      writeDocs(rules, src.dir, dir)
      console.log(`已生成 ${relative(process.cwd(), join(dir, "arena.d.ts"))} 和 PROMPT.md`)
      return
    }
    case "new-rules": {
      if (!pos[0]) fail("用法：rts-arena new-rules <目录>")
      try {
        await writeRulesTemplate(pos[0], listRulesets())
      } catch (e) {
        fail((e as Error).message)
      }
      return
    }
    case "init": {
      await cmdInit(pos)
      return
    }
    case "check": {
      // 只写了规则包、没写 bot：检查规则包本身
      const only = pos.length === 1 ? findRuleset(pos[0]) : null
      if (only) return cmdCheckRules(only, opt)
      const t = await target(pos, "check")
      if (t.bots.length === 0) fail("缺少 bot 文件")
      await cmdCheck(t.rules, t.src, t.bots, opt)
      return
    }
    case "run": {
      const t = await target(pos, "run")
      // bot 目录里不写对手：打基准 bot，人数不够就都补基准
      if (t.mine && t.bots.length > t.rules.players.max)
        fail(
          `「${t.rules.name}」最多 ${t.rules.players.max} 个 bot：在 bot 目录里，你的 ${t.bots[0]} 会自动排在第一个，再加上写的 ${t.bots.length - 1} 个就多了。` +
            `想自己指定所有参赛的 bot（比如拿旧版本打参考 bot），在前面写上规则包：rts-arena run ${t.src.ref} ${t.bots.slice(1).join(" ")}`,
        )
      const onlyBaseline = t.mine && t.bots.length === 1
      if (onlyBaseline) while (t.bots.length < t.rules.players.min) t.bots.push("baseline")
      await cmdRun(t.rules, t.src, t.bots, opt)
      const others = knownBots(t.src).filter((b) => b !== "baseline" && b !== "idle")
      if (onlyBaseline && others.length)
        say(`（这次只打了 baseline。还有别的打法的参考 bot：${others.join("、")}——rts-arena league 和它们全部打一遍，免得只对 baseline 过拟合）`)
      return
    }
    case "video-brief": {
      const file = findLeagueSeries(pos[0])
      const brief = videoBrief(file)
      const json = JSON.stringify(brief, null, 2)
      if (typeof opt.out === "string") {
        writeFileSync(opt.out, json)
        console.log(`已写好素材包 ${opt.out}（联赛 ${file}）。照着里面的 scriptTemplate 和 rules 写脚本，然后：rts-arena video ${file} --script <脚本.json>`)
      } else console.log(json)
      return
    }
    case "video": {
      const file = findLeagueSeries(pos[0])
      if (typeof opt.script !== "string") fail("要用 --script 给出脚本（JSON）；先用 rts-arena video-brief 拿素材包和脚本模板")
      let script: VideoScript
      try {
        script = JSON.parse(readFileSync(opt.script, "utf8")) as VideoScript
      } catch (e) {
        fail(`脚本 ${opt.script} 读不出来：${(e as Error).message}`)
      }
      const secs = (v: string | true | undefined, what: string) => {
        if (v === undefined) return undefined
        const list = String(v).split(",").map(Number)
        if (list.some((x) => !Number.isFinite(x) || x < 0)) fail(`${what} 要写成用逗号隔开的秒数，比如 2,15,40`)
        return list
      }
      const fps = typeof opt.fps === "string" ? Number(opt.fps) : 30
      if (!Number.isInteger(fps) || fps < 10 || fps > 60) fail("--fps 要是 10～60 的整数")
      const out = typeof opt.out === "string" ? opt.out : file.replace(/\.series\.json$/, ".mp4")
      const t0 = performance.now()
      let lastPct = -1
      try {
        const r = await renderLeagueVideo({
          seriesFile: file,
          script,
          out,
          browser: typeof opt.browser === "string" ? opt.browser : undefined,
          fps,
          preview: secs(opt.preview, "--preview"),
          check: secs(opt.check, "--check"),
          onProgress: (done, total) => {
            const pct = Math.floor((done / total) * 10) * 10
            if (pct !== lastPct) {
              lastPct = pct
              process.stdout.write(`渲染 ${pct}%（${done}/${total} 帧）\n`)
            }
          },
        })
        if (!r.file) console.log(`预览图：${r.images.join("、")}（整段视频 ${r.seconds.toFixed(1)} 秒）`)
        else {
          console.log(`已生成 ${r.file}：${r.seconds.toFixed(1)} 秒，${r.frames} 帧，${(r.bytes / 1e6).toFixed(1)} MB，用时 ${((performance.now() - t0) / 1000).toFixed(0)} 秒`)
          if (r.probe) console.log(`浏览器解码检查：时长 ${r.probe.duration.toFixed(1)} 秒，${r.probe.width}×${r.probe.height}`)
          if (r.images.length) console.log(`从成品截的图：${r.images.join("、")}`)
        }
      } catch (e) {
        fail((e as Error).message)
      }
      return
    }
    case "report": {
      const file = pos[0] ?? latestReplay("replays") ?? fail("./replays 里没有回放；写成 rts-arena report <回放文件>")
      if (!existsSync(file)) fail(`找不到回放 ${file}`)
      let replay: Replay
      try {
        replay = JSON.parse(readFileSync(file, "utf8")) as Replay
        if (replay.format !== "rts-arena-replay") throw new Error("不是回放文件")
      } catch (e) {
        fail(`${file} 读不出来：${(e as Error).message}`)
      }
      let player = typeof opt.player === "string" ? Number(opt.player) : undefined
      if (player !== undefined && !(Number.isInteger(player) && player >= 0 && player < replay.players.length)) fail(`--player 要是 0～${replay.players.length - 1}`)
      // 在 bot 目录里：自己的 bot 坐在哪（--games 会换边，每局的座位不一样）
      const ws = (() => {
        try {
          return readWorkspaceIn(".")
        } catch {
          return null
        }
      })()
      const mySeats = ws ? replay.players.map((p, i) => (resolve(p.bot) === resolve(ws.bot) ? i : -1)).filter((i) => i >= 0) : []
      if (player === undefined && mySeats.length > 0) {
        player = mySeats[0]
        console.log(`（你的 bot ${ws!.bot} 这局坐在 P${player}，按 P${player} 写；看别的座位用 --player N）`)
      } else if (player !== undefined && mySeats.length > 0 && !mySeats.includes(player))
        console.log(`（注意：P${player} 不是你的 bot，你的 ${ws!.bot} 这局坐在 ${mySeats.map((p) => `P${p}`).join("、")}；下面战报里的"你"指 P${player}）`)
      const every = typeof opt.every === "string" ? Number(opt.every) : undefined
      if (every !== undefined && !(Number.isInteger(every) && every > 0)) fail("--every 要是正整数")
      if (!pos[0]) console.log(`（最新的一局：${file}）`)
      process.stdout.write(buildReport(replay, { player, every, full: opt.full === true }))
      return
    }
    case "league": {
      const t = await target(pos, "league")
      // 只写了自己的 bot（或者只写了规则包）：和这个规则包所有现成的 bot 打（不算 idle）
      if (t.bots.length <= 1) for (const b of knownBots(t.src)) if (b !== "idle") t.bots.push(b)
      await cmdLeague(t.rules, t.src, t.bots, opt, t.mine)
      return
    }
    case "view": {
      const port = typeof opt.port === "string" ? Number(opt.port) : 5180
      if (!Number.isInteger(port) || port < 1 || port > 65535) fail("--port 要是 1~65535 的整数")
      // 对战页在后台用 node 执行同一个命令入口来跑比赛
      serveViewer(pos[0] ?? "replays", port, process.argv[1], opt.open === true)
      return
    }
    default: {
      // help <命令>：只看这个命令的那几行
      const only = command === "help" && pos[0] ? helpFor(pos[0]) : null
      if (only) return void console.log(only)
      console.log(HELP)
      if (command && command !== "help") process.exit(1)
    }
  }
}

await main()
