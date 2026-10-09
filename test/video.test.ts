// 联赛视频：素材包（代码风格指标、成绩）、脚本检查、场景编排；本机有 Chrome / Edge 时再真的渲染一段
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { after, test } from "node:test"
import { checkScript, codeFacts, factTags, gameScores, highlightPlayerWarnings, readSeries, resolveBotFile, scriptWarnings, videoBrief, type VideoScript } from "../src/video/brief.ts"
import { findBrowser } from "../src/video/browser.ts"
import { buildScenes, fightWindows, pacing, relabelSeats, tidy, timelineOf } from "../src/video/render.ts"
import { analyzeLeague, baseTypeOf, fitWinModel, twoSides, winCurve } from "../src/video/analysis.ts"
import { matchPortraits } from "../src/video/workspace.ts"
import { crc32, deflateSync } from "node:zlib"
import type { Replay } from "../src/core/types.ts"

const ROOT = join(import.meta.dirname, "..")
const CLI = join(ROOT, "src", "cli", "arena.ts")
const TMP = mkdtempSync(join(tmpdir(), "rts-arena-video-"))
after(() => rmSync(TMP, { recursive: true, force: true }))

const sh = (args: string[], cwd = TMP) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  return r.stdout
}

// 一场小联赛：两个参考 bot，每对 2 局
sh(["league", "koth", "baseline", "rush", "--per-pair", "2", "--seed", "3", "--out", "lg", "--no-check"])
const seriesFile = join(TMP, "lg", readdirSync(join(TMP, "lg")).find((f) => f.endsWith(".series.json"))!)

test("代码风格指标：行数、注释比例、开头的注释、常量、写法特征", () => {
  const f = codeFacts(`// 速攻 bot：凑够 6 个就上！
// 数值是实测调出来的

const WAVE = 6
let attacking = false

function nearest(a: number) { return a }
export function onTick(view: View, cmd: Commands): void {
  const go = (x: number) => x + 1 // 实测
  if (!attacking) cmd.attackMove(1, 2, 3)
}
`)
  assert.deepEqual(f.header, ["速攻 bot：凑够 6 个就上！", "数值是实测调出来的"])
  assert.equal(f.lines, 12)
  assert.equal(f.functions, 3)
  assert.equal(f.topLevelState, 1)
  assert.deepEqual(f.constants, ["WAVE = 6"])
  assert.equal(f.features["cmd.attackMove"], 1)
  assert.equal(f.features["实测或调参注释"], 3) // "实测" 两处、"调出来" 一处
  // 只数注释里的感叹号（代码里的 ! 不算）
  assert.equal(f.features["注释里的感叹号"], 1)
})

test("素材包：每个选手的文件名、成绩、代码指标，脚本模板；脚本检查列出所有问题", () => {
  const b = videoBrief(seriesFile)
  assert.deepEqual(
    b.players.map((p) => p.name),
    ["baseline", "rush"],
  )
  assert.ok(b.players.every((p) => p.code && p.code.lines > 10 && p.standing))
  const series = readSeries(seriesFile)
  // 模板本身还没填，检查不过
  assert.ok(checkScript(b.scriptTemplate, series).some((e) => e.includes("待填")))
  const bad = checkScript({ players: [{ name: "nobody", tagline: "x", intro: [] }], highlights: [{ index: 99 }] }, series)
  assert.ok(bad.some((e) => e.includes("联赛里的名字")))
  assert.ok(bad.some((e) => e.includes("intro")))
  assert.ok(bad.some((e) => e.includes("少了选手 rush")))
  assert.ok(bad.some((e) => e.includes("局号")))
})

/** 一张渐变的 PNG（测试用的选手形象图） */
function testPng(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4
      raw[o] = 230
      raw[o + 1] = Math.floor((x * 255) / w)
      raw[o + 2] = Math.floor((y * 255) / h)
      raw[o + 3] = 255
    }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])
}

const script: VideoScript = {
  players: [
    { name: "baseline", displayName: "基准", byline: "平台自带", tagline: "均衡的标准对手", intro: ["经济、防守、集火都做全了。", "先出 6 个战士再混编。"] },
    { name: "rush", tagline: "拆家速攻", intro: ["凑够 6 个战士就去拆家。"] },
  ],
  outro: "完。",
}

test("联赛汇总记下每局比分；全联赛之最（最快、最久、比分最接近）的标签打在对应那局上", () => {
  const series = readSeries(seriesFile)
  assert.ok(series.results.every((r) => Array.isArray(r.scores) && r.scores.length === r.names.length))
  const tags = factTags(series, gameScores(series, seriesFile))
  const fastest = [...series.results].filter((r) => r.winners.length).sort((a, b) => a.tick - b.tick || a.index - b.index)[0]
  assert.match(tags.get(fastest.index)!.join("；"), /全联赛结束得最快的胜局（\d+ tick）/)
  assert.ok([...tags.values()].flat().some((t) => /比分最接近/.test(t)))
})

test("脚本提醒（D-171）：精彩对局的标题、解说提到了不在这局的选手（按全名、显示名、简称找）", () => {
  const series = {
    participants: [{ name: "GPTbot" }, { name: "大肥鱼" }, { name: "哈基米" }],
    results: [{ index: 109, names: ["大肥鱼", "哈基米"] }],
  } as unknown as Parameters<typeof highlightPlayerWarnings>[1]
  const script = {
    players: [{ name: "GPTbot", displayName: "GPT 6.1 sol" }, { name: "大肥鱼" }, { name: "哈基米" }],
    highlights: [{ index: 109, title: "哈基米没输给 GPT 的那局", commentary: "大肥鱼先清掉中央守卫" }],
  }
  const w = highlightPlayerWarnings(script, series)
  assert.equal(w.length, 1)
  assert.match(w[0], /highlights\[0\]\.title 提到了「GPT」，可第 109 局是 大肥鱼 对 哈基米/)
  // 照这局写的不提醒
  assert.deepEqual(highlightPlayerWarnings({ ...script, highlights: [{ index: 109, title: "大肥鱼翻盘", commentary: "哈基米先手" }] }, series), [])
})

test("脚本提醒：粗体字段里的「一」像破折号，常规字重的介绍不管", () => {
  const w = scriptWarnings({ players: [{ name: "a", tagline: "只输 1 局", intro: ["一稿流"] }], highlights: [{ index: 1, commentary: "一波带走" }], outro: "唯一一胜" }).filter((x) => x.includes("是粗体"))
  assert.equal(w.length, 2)
  assert.ok(w[0].startsWith("outro 是粗体") && w[1].startsWith("highlights[0].commentary 是粗体"))
  // 不再有标题页（D-177）：老脚本的 title、userText、theme 提醒删掉
  assert.ok(scriptWarnings({ title: "x", userText: "y", players: [] }).some((x) => /title、userText 不再使用/.test(x)))
  assert.deepEqual(scriptWarnings(null), [])
  // 选手页：tagline 加 intro 超过 170 字读不完，少于 100 字页面显得空，都提醒（和最初的视频一样写 3～4 句、120～170 字）
  const long = scriptWarnings({ players: [{ name: "a", tagline: "定位", intro: ["很长".repeat(70), "很长".repeat(70)] }] })
  assert.match(long[0], /players\[0\]（a）的 tagline 加 intro 共 282 字/)
  const short = scriptWarnings({ players: [{ name: "a", tagline: "定位", intro: ["很短".repeat(20)] }] })
  assert.match(short[0], /players\[0\]（a）的 tagline 加 intro 只有 42 字，选手页显得空/)
  assert.deepEqual(scriptWarnings({ players: [{ name: "a", tagline: "定位", intro: ["正好".repeat(100)] }] }), [])
  // 规则介绍提到别的规则包：观众不一定玩过，提醒直接讲规则（D-155）
  const other = scriptWarnings({ rules: ["在拓荒的基础上加了 4 种科技建筑。", "先拆掉对方主基地的赢。"] }, ["拓荒", "夺点"])
  assert.equal(other.length, 1)
  assert.match(other[0], /rules\[0\] 提到了别的规则包「拓荒」/)
})

test("场景编排：片头片尾署名、标题、每个选手、排名、精彩对局（标题卡 + 回放）", () => {
  const series = readSeries(seriesFile)
  assert.deepEqual(checkScript(script, series), [])
  const scenes = buildScenes(series, script, seriesFile, 10)
  const kinds = scenes.map((s) => s.data.kind)
  // 开场（D-179）：第一帧是选手阵容，接着冷开场（第一局精彩对局最大的一仗），再是片头署名
  assert.deepEqual(kinds.slice(0, 3), ["lineup", "replay", "brandOpen"])
  const lineup = scenes[0].data as { title: string; players: { name: string }[] }
  assert.equal(lineup.players.length, 2)
  assert.match(lineup.title, /谁能赢？$/)
  const cold = scenes[1].data as { hook: string | null; frames: number }
  assert.equal(cold.hook, lineup.title)
  assert.equal(cold.frames, 7 * 10)
  // 片头片尾、选手页、标题卡的节奏加快：带 speed，时长按它缩短（片头 3.5 秒 → 2.7 秒）
  for (const s of scenes.filter((x) => ["brandOpen", "player", "brandClose"].includes(x.data.kind))) assert.equal((s.data as { speed?: number }).speed, 1.3)
  // 标题卡保持原速（要读的东西多）
  for (const s of scenes.filter((x) => x.data.kind === "hlTitle")) assert.equal((s.data as { speed?: number }).speed, undefined)
  assert.equal(scenes[2].data.frames, Math.round((10 * 3.5) / 1.3))
  assert.equal(kinds.at(-1), "brandClose")
  // 片尾名单按脚本里的出场顺序
  const close = scenes.at(-1)!.data as { credits: string[] }
  assert.deepEqual(close.credits.slice(0, 2), ["基准 · 平台自带", "rush"])
  // 片头之后直接是规则介绍（D-177：没有标题页了）
  assert.deepEqual(kinds.slice(3, 8), ["rules", "player", "player", "standings", "hlTitle"])
  // 规则介绍：没写 rules 就用规则包的一句话简介；配第一局精彩对局的开局地图（有控制点标记）和单位图例（带近战 / 射程）
  const rules = scenes[3].data as { lines: string[]; ents: number[]; markers: { kind: string }[]; legend: { name: string; detail: string }[]; tickNote: string }
  assert.match(rules.tickNote, /1 秒 = 10 tick，一局最多 \d+ tick/)
  assert.equal(rules.lines.length, 1)
  assert.ok(rules.ents.length > 0 && rules.markers.some((m) => m.kind === "zone"))
  assert.ok(rules.legend.some((l) => l.name === "弓手" && /射程 4/.test(l.detail)) && rules.legend.some((l) => l.name === "战士" && /近战/.test(l.detail)))
  // 能力按规则包里实际的写：夺点的工人只采矿、不能建造
  const worker = rules.legend.find((l) => l.name === "工人")!
  assert.ok(/采矿/.test(worker.detail) && !/建造/.test(worker.detail), worker.detail)
  // 选手页按字数定时长（介绍长的那页更长）
  const longIntro = buildScenes(series, { ...script, players: [{ ...script.players[0], intro: ["一句比较长的介绍，".repeat(8)] }, script.players[1]] }, seriesFile, 10)
  const players = longIntro.filter((s) => s.data.kind === "player")
  assert.ok(players[0].data.frames > players[1].data.frames, players.map((s) => s.data.frames).join(","))
  const withRules = buildScenes(series, { ...script, rules: ["占住正中的控制点，点里只有你的单位时每 tick 得 1 分", "先拿满 600 分的赢"] }, seriesFile, 10)
  assert.equal((withRules.find((x) => x.data.kind === "rules")!.data as { lines: string[] }).lines.length, 2)
  // 脚本写了开场的大字就用它
  const hooked = buildScenes(series, { ...script, hook: { text: "两个参考 bot 谁更强？" } }, seriesFile, 10)
  assert.equal((hooked[0].data as { title: string }).title, "两个参考 bot 谁更强？")
  // 竖屏短版：开场、片头、精彩对局的大战（每段最多 12 秒）、排名、片尾
  const short = buildScenes(series, script, seriesFile, 10, undefined, null, { short: true })
  const sk = short.map((x) => x.data.kind)
  assert.deepEqual(sk.slice(0, 3), ["lineup", "replay", "brandOpen"])
  assert.deepEqual(sk.slice(-2), ["standings", "brandClose"])
  assert.ok(!sk.includes("player") && !sk.includes("hlTitle") && !sk.includes("rules"))
  assert.ok(short.filter((x) => x.data.kind === "replay").every((x) => x.data.frames <= 12 * 10))
  const hl = series.summary!.highlights!.slice(0, 3).length
  assert.equal(kinds.filter((k) => k === "replay").length, hl + 1)
  // 时间表：每段都有名字，首尾相接
  const tl = timelineOf(scenes, 10)
  assert.equal(tl[0].label, "开场阵容")
  assert.ok(tl.every((x, k) => x.label && (k === 0 || x.from === tl[k - 1].to)))
  assert.ok(tl.some((x) => /^选手 基准$/.test(x.label)) && tl.some((x) => /^精彩对局 1 回放$/.test(x.label)))
  // 回放场景每帧都能算出局面，最后一帧定格显示结果；往回要的帧从头重算，结果一样
  const rs = scenes.find((s) => s.data.kind === "replay" && !(s.data as { hook: string | null }).hook)
  if (rs) {
    const mid = rs.frame!(Math.floor(rs.data.frames / 2))
    let last = rs.frame!(0)
    for (let i = 1; i < rs.data.frames; i++) last = rs.frame!(i)
    assert.ok(last.final && last.progress === 1 && last.ents.length > 0)
    // 夺点：控制点标记、规则包的状态栏、规则包写的事件（P0/P1 换成了选手名）
    assert.ok(last.markers.some((m) => m.kind === "zone"))
    assert.ok(last.status.length > 0)
    assert.ok(last.events.some((e) => /夺下控制点/.test(e) && !/\bP\d/.test(e)), last.events.join(" | "))
    assert.deepEqual(rs.frame!(Math.floor(rs.data.frames / 2)).ents, mid.ents)
  }
})

test("规则页：开局快照里没有标记（规则包第 1 个 tick 才放）时用回放里第一次出现的；图例用规则包写的中文名 look.name", () => {
  const dir = join(TMP, "lg-nomark")
  cpSync(join(TMP, "lg"), dir, { recursive: true })
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json") && !x.endsWith(".series.json") && !x.endsWith(".analysis.json"))) {
    const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as Replay
    r.initial.markers = []
    r.types.archer.look = { ...r.types.archer.look!, name: "射手" }
    writeFileSync(join(dir, f), JSON.stringify(r))
  }
  const sf = join(dir, basename(seriesFile))
  const rules = buildScenes(readSeries(sf), script, sf, 10).find((x) => x.data.kind === "rules")!.data as { markers: { kind: string }[]; legend: { name: string }[] }
  assert.ok(rules.markers.some((m) => m.kind === "zone"))
  assert.ok(rules.legend.some((l) => l.name === "射手") && rules.legend.some((l) => l.name === "战士"))
})

test("平台拼的文字：中文名前后的空格去掉，英文名的留着", () => {
  // 规则包的状态栏用空格隔开几项，换成选手名后空格要留着；事件句子照样去掉
  const seats = [{ name: "大肥鱼" }, { name: "哈基米" }]
  assert.equal(relabelSeats("台址 P0 P1 空 争", seats, false), "台址 大肥鱼 哈基米 空 争")
  assert.equal(relabelSeats("P1 夺下控制点", seats), "哈基米夺下控制点")
  assert.equal(tidy("联赛得分率 50% 的 Gemini 赢了 98% 的 大肥鱼"), "联赛得分率 50% 的 Gemini 赢了 98% 的大肥鱼")
  assert.equal(tidy("t1044～1169 大战：大肥鱼 损失 7，Gemini 3.8 flash 损失 11"), "t1044～1169 大战：大肥鱼损失 7，Gemini 3.8 flash 损失 11")
  assert.equal(tidy("大肥鱼 获胜"), "大肥鱼获胜")
})

test("回放变速（D-172、D-174）：tick 随帧单调往前、首尾对齐；大战 2 倍速，其余有单位倒下的小冲突 4 倍速，没动静的快进至少 4 倍", () => {
  const series = readSeries(seriesFile)
  const g = [...series.results].sort((a, b) => b.tick - a.tick)[0]
  const replay = JSON.parse(readFileSync(join(TMP, "lg", g.replay), "utf8")) as Replay
  const fps = 30
  const p = pacing(replay, fps)
  const n = p.playFrames
  const ticks = Array.from({ length: n }, (_, i) => p.tickOf(i))
  assert.equal(ticks[0], 0)
  assert.equal(ticks[n - 1], replay.result.tick)
  assert.ok(ticks.every((t, i) => i === 0 || t >= ticks[i - 1]))
  const { battles, skirmishes } = fightWindows(replay)
  assert.ok(skirmishes.length > 0, "这局应该有小冲突")
  const rate = replay.tickRate
  const T = replay.result.tick
  const inBattle = (t: number) => battles.some(([x, y]) => t >= x && t < y)
  const battleTicks = battles.reduce((a, [x, y]) => a + (y - x), 0)
  let skirmishTicks = 0
  for (const [x, y] of skirmishes) for (let t = x; t < y; t++) if (!inBattle(t)) skirmishTicks++
  // 大战一共放 battleTicks / (2 × rate) 秒，小冲突 skirmishTicks / (4 × rate) 秒，没动静的最多 10 秒
  const lo = (battleTicks / (2 * rate) + skirmishTicks / (4 * rate)) * fps
  const hi = (battleTicks / (2 * rate) + (T - battleTicks) / (4 * rate)) * fps
  assert.ok(n >= lo - 2 && n <= Math.max(hi, lo + 10 * fps) + 2, `${n} 帧（${lo}～${hi}）`)
  // 段中间的帧：大战一秒正好推进 2 × rate 个 tick，小冲突 4 × rate 个
  const check = (wins: [number, number][], mode: string, per: number) => {
    for (const [x, y] of wins) {
      const inside = ticks.map((_, i) => i).filter((i) => ticks[i] > x + 1 && ticks[i + fps] !== undefined && ticks[i + fps] < y - 1 && (mode === "battle" || !battles.some(([bx, by]) => by > ticks[i] && bx < ticks[i + fps])))
      for (const i of inside.slice(0, 5)) assert.ok(Math.abs(ticks[i + fps] - ticks[i] - per * rate) <= 1, `${mode}：第 ${i} 帧起一秒推进了 ${ticks[i + fps] - ticks[i]} tick`)
      for (const i of inside) assert.equal(p.mode(i), mode)
    }
  }
  check(battles, "battle", 2)
  check(skirmishes, "skirmish", 4)
  const quiet = ticks.slice(0, -1).map((_, i) => i).filter((i) => p.mode(i) === "quiet")
  if (quiet.length > fps) assert.ok(ticks[quiet[0] + fps] - ticks[quiet[0]] >= rate * 4 - 1)
})

test("视频分析（D-177）：主基地认得出；胜率模型对称、看得出谁占优；雷达图每人 6 项、每项和最好的比；结果缓存", () => {
  const series = readSeries(seriesFile)
  const replays = series.results.map((g) => JSON.parse(readFileSync(join(TMP, "lg", g.replay), "utf8")) as Replay)
  assert.equal(baseTypeOf(replays[0]), "base")
  assert.deepEqual(twoSides(replays[0]), [0, 1])
  // 只有一个特征时：特征为正就是 A 方赢，权重为正；局面一样时 50%
  const w1 = fitWinModel([{ x: [1], y: 1 }, { x: [0.5], y: 1 }, { x: [-0.3], y: 0 }])
  assert.ok(w1[0] > 0)
  const a = analyzeLeague(series, seriesFile)
  assert.equal(a.weights.length, 8)
  assert.deepEqual(Object.keys(a.radar).sort(), series.participants.map((p) => p.name).sort())
  for (const axes of Object.values(a.radar)) {
    assert.equal(axes.length, 6)
    assert.ok(axes.every((x) => x.score >= 0 && x.score <= 1 && x.label && x.text))
  }
  // 6 项（夺点没有兵种克制，第 5 项是速胜；D-180：最后一项是防守，不再是代码行数）
  assert.deepEqual(
    Object.values(a.radar)[0].map((x) => x.label),
    ["经济", "生产", "战斗", "进攻", "速胜", "防守"],
  )
  // 和最好的比的几项总有人是 1（除非大家都是 0）；防守是丢得最多的那个是 0（除非谁都没丢）；战斗是击杀占比
  for (const k of [0, 1, 3, 4]) assert.ok(Object.values(a.radar).some((axes) => axes[k].score === 1 || axes[k].score === 0))
  assert.ok(Object.values(a.radar).some((axes) => axes[5].score === 0) || Object.values(a.radar).every((axes) => axes[5].score === 1))
  assert.ok(existsSync(seriesFile.replace(/\.series\.json$/, ".analysis.json")))
  assert.deepEqual(analyzeLeague(series, seriesFile), a)
  // 胜率曲线：每 20 tick 一个点、在 0～1 之间；终局多数局判对赢家
  let right = 0
  let decided = 0
  for (const r of replays) {
    const c = winCurve(r, a.weights, 20)!
    assert.ok(c.length >= Math.floor(r.result.tick / 20) && c.every((v) => v >= 0 && v <= 1))
    const won = r.result.winners ?? []
    if (won.length !== 1) continue
    decided++
    const aWins = (r.players[won[0]].team ?? won[0]) === twoSides(r)![0]
    if (aWins === c.at(-1)! > 0.5) right++
  }
  assert.ok(right >= decided * 0.7, `终局判对 ${right}/${decided}`)
  // 场景里带上：选手页的雷达图，回放的胜率曲线和主基地
  const scenes = buildScenes(series, script, seriesFile, 10, undefined, a)
  const pl = scenes.find((x) => x.data.kind === "player")!.data as { radar: unknown[] | null; portrait: string | null }
  assert.equal(pl.radar?.length, 6)
  assert.equal(pl.portrait, null)
  const rp = scenes.find((x) => x.data.kind === "replay")!.data as { win: { curve: number[]; sides: { name: string }[] } | null; types: { name: string; base: boolean }[] }
  assert.ok(rp.win && rp.win.curve.length > 10 && rp.win.sides.length === 2)
  assert.deepEqual(rp.types.filter((t) => t.base).map((t) => t.name), ["base"])
})

test("形象图按名字对应选手：文件名里只对上一个选手的词才算", () => {
  const m = matchPortraits(["Fable5.1", "Opus5.5", "Sonnet5.5", "GPT6.1sol-codex", "DeepseekV4.1Flash-DeepseekHarness"], ["claude fable.png", "claude opus.png", "claude sonnet.png", "claude haiku.png", "gpt.png", "deepseek.png", "gemini.png"])
  assert.deepEqual(Object.fromEntries(m), { "Fable5.1": "claude fable.png", "Opus5.5": "claude opus.png", "Sonnet5.5": "claude sonnet.png", "GPT6.1sol-codex": "gpt.png", "DeepseekV4.1Flash-DeepseekHarness": "deepseek.png" })
})

test("选手代码：联赛记的路径找不到时，再找平台目录（自带的参考 bot）和当前目录 bots/ 里的副本", () => {
  const cwd = process.cwd()
  const dir = mkdtempSync(join(TMP, "ws-"))
  process.chdir(dir)
  try {
    assert.equal(resolveBotFile("rulesets/tech/bots/scholar.ts", seriesFile), resolve(ROOT, "rulesets", "tech", "bots", "scholar.ts"))
    assert.equal(resolveBotFile("elsewhere\\mine.ts", seriesFile), null)
    mkdirSync("bots")
    writeFileSync(join("bots", "mine.ts"), "// mine\n")
    assert.equal(resolveBotFile("elsewhere\\mine.ts", seriesFile), resolve(dir, "bots", "mine.ts"))
  } finally {
    process.chdir(cwd)
  }
})

test("video-init：视频目录里有说明、选手代码、战报、待填脚本；已经有脚本时不覆盖", () => {
  // 选手形象图：按名字对应（"hero rush.png" 的 rush 对上 rush），对不上的不用
  const pics = join(TMP, "pics")
  mkdirSync(pics, { recursive: true })
  writeFileSync(join(pics, "claude baseline.png"), testPng(60, 90))
  writeFileSync(join(pics, "hero rush.png"), testPng(60, 90))
  writeFileSync(join(pics, "nobody.png"), testPng(8, 8))
  sh(["video-init", "lg", "vd", "--portraits", pics, "--about", "rush 是某某模型写的"])
  const dir = join(TMP, "vd")
  const prompt = readFileSync(join(dir, "PROMPT.md"), "utf8")
  assert.match(prompt, /选手形象图\*\*：已经按名字对应好/)
  assert.ok(existsSync(join(dir, "portraits", "claude baseline.png")) && !existsSync(join(dir, "portraits", "nobody.png")))
  assert.doesNotMatch(prompt, /userText/)
  // 用户补充的背景、平台算好的联赛速查（最快的局、每人赢了谁输给谁）
  assert.match(prompt, /用户补充的背景\*\*：rush 是某某模型写的/)
  assert.match(prompt, /### 联赛速查/)
  // 规则说明一起导出，PROMPT 里有规则介绍的写法
  assert.ok(existsSync(join(dir, "RULES.md")))
  // 说明里的例子只用占位，不出现真实的模型名、外号（免得诱导大模型去猜这场的选手是谁写的）
  assert.doesNotMatch(prompt, /DeepSeek|大肥鱼|GPT6\.1sol|Gemini/)
  assert.match(prompt, /2\. \*\*规则介绍\*\*/)
  assert.match(prompt, /照这个目录里的 `RULES\.md` 写/)
  assert.match(prompt, /\| 标题卡看点 \|/)
  assert.match(prompt, /全联赛结束得最快的胜局（\d+ tick）/)
  // 速查里每类都有一行，没有的明写"没有"
  for (const k of ["爆冷", "克制环", "逆转", "比分最接近的胜局", "规则包事件最多的局"]) assert.match(prompt, new RegExp(`\\n- ${k}`))
  assert.match(prompt, /`index` 是联赛的\*\*局号\*\*/)
  assert.match(prompt, /结束得最快的胜局：第 \d+ 局/)
  assert.match(prompt, /- baseline（第 \d 名）：赢 \d+ 局/)
  assert.match(prompt, /### 排名/)
  assert.match(prompt, /#### baseline/)
  assert.match(prompt, /rts-arena video --preview/)
  assert.ok(existsSync(join(dir, "bots", "baseline.ts")) && existsSync(join(dir, "bots", "rush.ts")))
  assert.ok(readdirSync(join(dir, "reports")).some((f) => /^game-\d+\.md$/.test(f)))
  const tmpl = JSON.parse(readFileSync(join(dir, "script.json"), "utf8")) as VideoScript
  assert.deepEqual(
    tmpl.players.map((p) => p.portrait),
    ["portraits/claude baseline.png", "portraits/hero rush.png"],
  )
  assert.equal((tmpl as unknown as Record<string, unknown>).userText, undefined)
  // 写给大模型的：每段显示在哪、自动看点别重复、每人的颜色、每局数据
  assert.match(prompt, /别重复看点/)
  assert.match(prompt, /byline` 会出现在片尾/)
  assert.match(prompt, /视频里的颜色：蓝色/)
  assert.match(prompt, /每局数据/)
  assert.match(prompt, /--preview auto/)
  const again = spawnSync(process.execPath, [CLI, "video-init", "lg", "vd"], { cwd: TMP, encoding: "utf8" })
  assert.equal(again.status, 1)
  assert.match(again.stderr, /已经有 script\.json/)
  // 只写目录名：联赛自己找（当前目录的下一层子目录 lg 里）
  sh(["video-init", "vd2"])
  assert.ok(existsSync(join(TMP, "vd2", "PROMPT.md")))
  // 哪儿都没有联赛：报错里写的是 video-init 自己
  const empty = mkdtempSync(join(tmpdir(), "rts-video-empty-"))
  const none = spawnSync(process.execPath, [CLI, "video-init"], { cwd: empty, encoding: "utf8" })
  rmSync(empty, { recursive: true, force: true })
  assert.equal(none.status, 1)
  assert.match(none.stderr, /rts-arena video-init <联赛汇总/)
})

test("渲染：在视频目录里不写参数出预览图；本机有浏览器时出一段 1920×1080 的 MP4 并用浏览器解码检查", { skip: findBrowser() ? false : "本机没有 Chrome / Edge" }, () => {
  const dir = join(TMP, "vd")
  writeFileSync(join(dir, "script.json"), JSON.stringify(script))
  // 粗体字段里的"一"：提醒但照样出图
  writeFileSync(join(dir, "script.json"), JSON.stringify({ ...script, outro: "唯一一胜" }))
  assert.match(sh(["video", "--preview", "1"], dir), /提醒：outro 是粗体/)
  // 带上形象图：选手页的半身像、精彩对局的头像都要走一遍（D-177）
  const withPics = { ...script, players: script.players.map((p, i) => ({ ...p, portrait: i === 0 ? "portraits/claude baseline.png" : "portraits/hero rush.png" })) }
  writeFileSync(join(dir, "script.json"), JSON.stringify(withPics))
  // --lint：不出图，列出每个字段的字数和上限、时间表
  const lint = sh(["video", "--lint"], dir)
  assert.match(lint, /字数（现在 \/ 上限/)
  assert.match(lint, /players\[0\]（baseline）tagline 加 intro：\d+ \/ 260  ← 偏少/)
  assert.match(lint, /每段的时间/)
  assert.match(lint, /格式没问题/)
  const out = sh(["video", "--preview", "1,6"], dir)
  assert.match(out, /预览图/)
  assert.match(out, /每段的时间（整段 [\d.]+ 秒）：\n\s+0\.0～1\.6\s+秒  开场阵容\n\s+1\.6～8\.6\s+秒  冷开场/)
  assert.ok(statSync(join(dir, "preview", "夺点联赛-6s.png")).size > 10_000)
  // 竖屏短版（D-179）：开场阵容和冷开场按竖屏画，1080×1920
  const vert = sh(["video", "--short", "--preview", "1,5", "--out", "短.mp4"], dir)
  assert.match(vert, /0\.0～1\.6\s+秒  开场阵容/)
  const vpng = readFileSync(join(dir, "preview", "短-5s.png"))
  assert.deepEqual([vpng.readUInt32BE(16), vpng.readUInt32BE(20)], [1080, 1920])
  // 两张以上的预览拼一张总览
  assert.match(out, /总览：preview[\\/]夺点联赛-总览\.png/)
  assert.ok(statSync(join(dir, "preview", "夺点联赛-总览.png")).size > 10_000)
  // auto：每段一张，回放段两张
  const auto = sh(["video", "--preview", "auto"], dir)
  const shots = /预览图：(.*)/.exec(auto)![1].split("、")
  const segs = auto.split("\n").filter((l) => /^\s+[\d.]+～/.test(l))
  assert.equal(shots.length, segs.length + segs.filter((l) => l.endsWith("回放") || l.includes("最大的一仗")).length)
  assert.ok(shots.every((f) => existsSync(join(dir, f))))
  const full = sh(["video", "--out", "v.mp4", "--fps", "10", "--check", "2"], dir)
  assert.match(full, /浏览器解码检查：时长 [\d.]+ 秒，1920×1080/)
  assert.ok(statSync(join(dir, "v.mp4")).size > 100_000)
  assert.ok(existsSync(join(dir, "preview", "v-check-2s.png")))
})
