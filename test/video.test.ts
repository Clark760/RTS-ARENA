// 联赛视频：素材包（代码风格指标、成绩）、脚本检查、场景编排；本机有 Chrome / Edge 时再真的渲染一段
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { checkScript, codeFacts, factTags, gameScores, readSeries, scriptWarnings, videoBrief, type VideoScript } from "../src/video/brief.ts"
import { findBrowser } from "../src/video/browser.ts"
import { buildScenes, pacing, tidy, timelineOf } from "../src/video/render.ts"
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

const script: VideoScript = {
  title: "测试联赛",
  userText: "随便说一句话",
  theme: "两个参考 bot 的对决",
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

test("脚本提醒：粗体字段里的「一」像破折号，常规字重的介绍不管", () => {
  const w = scriptWarnings({ title: "唯一一胜", players: [{ name: "a", tagline: "只输 1 局", intro: ["一稿流"] }], highlights: [{ index: 1, commentary: "一波带走" }], outro: "完" })
  assert.equal(w.length, 2)
  assert.ok(w[0].startsWith("title 是粗体") && w[1].startsWith("highlights[0].commentary 是粗体"))
  assert.deepEqual(scriptWarnings(null), [])
  // 选手页最长 9 秒：tagline 加 intro 超过 100 字提醒
  const long = scriptWarnings({ players: [{ name: "a", tagline: "定位", intro: ["很长".repeat(30), "很长".repeat(30)] }] })
  assert.match(long[0], /players\[0\]（a）的 tagline 加 intro 共 122 字/)
})

test("场景编排：片头片尾署名、标题、每个选手、排名、精彩对局（标题卡 + 回放）", () => {
  const series = readSeries(seriesFile)
  assert.deepEqual(checkScript(script, series), [])
  const scenes = buildScenes(series, script, seriesFile, 10)
  const kinds = scenes.map((s) => s.data.kind)
  assert.equal(kinds[0], "brandOpen")
  // 片头片尾、选手页、标题卡的节奏加快：带 speed，时长按它缩短（片头 3.5 秒 → 2.7 秒）
  for (const s of scenes.filter((x) => ["brandOpen", "player", "hlTitle", "brandClose"].includes(x.data.kind))) assert.equal((s.data as { speed?: number }).speed, 1.3)
  assert.equal(scenes[0].data.frames, Math.round((10 * 3.5) / 1.3))
  assert.equal(kinds.at(-1), "brandClose")
  // 片尾名单按脚本里的出场顺序
  const close = scenes.at(-1)!.data as { credits: string[] }
  assert.deepEqual(close.credits.slice(0, 2), ["基准 · 平台自带", "rush"])
  assert.deepEqual(kinds.slice(1, 6), ["title", "rules", "player", "player", "standings"])
  // 规则介绍：没写 rules 就用规则包的一句话简介；配第一局精彩对局的开局地图（有控制点标记）和单位图例（带近战 / 射程）
  const rules = scenes[2].data as { lines: string[]; ents: number[]; markers: { kind: string }[]; legend: { name: string; detail: string }[] }
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
  assert.equal((withRules[2].data as { lines: string[] }).lines.length, 2)
  const hl = series.summary!.highlights!.slice(0, 3).length
  assert.equal(kinds.filter((k) => k === "replay").length, hl)
  // 时间表：每段都有名字，首尾相接
  const tl = timelineOf(scenes, 10)
  assert.equal(tl[0].label, "片头署名")
  assert.ok(tl.every((x, k) => x.label && (k === 0 || x.from === tl[k - 1].to)))
  assert.ok(tl.some((x) => /^选手 基准$/.test(x.label)) && tl.some((x) => /^精彩对局 1 回放$/.test(x.label)))
  // 回放场景每帧都能算出局面，最后一帧定格显示结果；往回要的帧从头重算，结果一样
  const rs = scenes.find((s) => s.data.kind === "replay")
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

test("平台拼的文字：中文名前后的空格去掉，英文名的留着", () => {
  assert.equal(tidy("联赛得分率 50% 的 Gemini 赢了 98% 的 大肥鱼"), "联赛得分率 50% 的 Gemini 赢了 98% 的大肥鱼")
  assert.equal(tidy("t1044～1169 大战：大肥鱼 损失 7，Gemini 3.8 flash 损失 11"), "t1044～1169 大战：大肥鱼损失 7，Gemini 3.8 flash 损失 11")
  assert.equal(tidy("大肥鱼 获胜"), "大肥鱼获胜")
})

test("回放变速：tick 随帧单调往前、首尾对齐；打起来的地方比没动静的地方放得慢", () => {
  const series = readSeries(seriesFile)
  const g = [...series.results].sort((a, b) => b.tick - a.tick)[0]
  const replay = JSON.parse(readFileSync(join(TMP, "lg", g.replay), "utf8")) as Replay
  const n = 200
  const p = pacing(replay, n)
  const ticks = Array.from({ length: n }, (_, i) => p.tickOf(i))
  assert.equal(ticks[0], 0)
  assert.equal(ticks[n - 1], replay.result.tick)
  assert.ok(ticks.every((t, i) => i === 0 || t >= ticks[i - 1]))
  // 每帧推进的 tick：快进的帧比不快进的帧多
  const step = (i: number) => ticks[i + 1] - ticks[i]
  const fast = ticks.slice(0, -1).map((_, i) => i).filter((i) => p.fast(i))
  const slow = ticks.slice(0, -1).map((_, i) => i).filter((i) => !p.fast(i))
  if (fast.length && slow.length) {
    const avg = (xs: number[]) => xs.reduce((a, i) => a + step(i), 0) / xs.length
    assert.ok(avg(fast) > avg(slow) * 1.5)
  }
})

test("video-init：视频目录里有说明、选手代码、战报、待填脚本；已经有脚本时不覆盖", () => {
  sh(["video-init", "lg", "vd", "--text", "用户的一句话", "--about", "rush 是某某模型写的"])
  const dir = join(TMP, "vd")
  const prompt = readFileSync(join(dir, "PROMPT.md"), "utf8")
  assert.match(prompt, /用户的一句话/)
  // 用户补充的背景、平台算好的联赛速查（最快的局、每人赢了谁输给谁）
  assert.match(prompt, /用户补充的背景\*\*：rush 是某某模型写的/)
  assert.match(prompt, /### 联赛速查/)
  // 规则说明一起导出，PROMPT 里有规则介绍的写法
  assert.ok(existsSync(join(dir, "RULES.md")))
  assert.match(prompt, /3\. \*\*规则介绍\*\*/)
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
  assert.equal(tmpl.userText, "用户的一句话")
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
  writeFileSync(join(dir, "script.json"), JSON.stringify({ ...script, title: "唯一一胜" }))
  assert.match(sh(["video", "--preview", "1"], dir), /提醒：title 是粗体/)
  writeFileSync(join(dir, "script.json"), JSON.stringify(script))
  const out = sh(["video", "--preview", "1,6"], dir)
  assert.match(out, /预览图/)
  assert.match(out, /每段的时间（整段 [\d.]+ 秒）：\n\s+0\.0～2\.7\s+秒  片头署名/)
  assert.ok(statSync(join(dir, "夺点联赛-6s.png")).size > 10_000)
  // 两张以上的预览拼一张总览
  assert.match(out, /总览：夺点联赛-总览\.png/)
  assert.ok(statSync(join(dir, "夺点联赛-总览.png")).size > 10_000)
  // auto：每段一张，回放段两张
  const auto = sh(["video", "--preview", "auto"], dir)
  const shots = /预览图：(.*)/.exec(auto)![1].split("、")
  const segs = auto.split("\n").filter((l) => /^\s+[\d.]+～/.test(l))
  assert.equal(shots.length, segs.length + segs.filter((l) => l.endsWith("回放")).length)
  assert.ok(shots.every((f) => existsSync(join(dir, f))))
  const full = sh(["video", "--out", "v.mp4", "--fps", "10", "--check", "2"], dir)
  assert.match(full, /浏览器解码检查：时长 [\d.]+ 秒，1920×1080/)
  assert.ok(statSync(join(dir, "v.mp4")).size > 100_000)
  assert.ok(existsSync(join(dir, "v-check-2s.png")))
})
