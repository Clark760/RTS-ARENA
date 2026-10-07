// 联赛视频：素材包（代码风格指标、成绩）、脚本检查、场景编排；本机有 Chrome / Edge 时再真的渲染一段
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { checkScript, codeFacts, readSeries, videoBrief, type VideoScript } from "../src/video/brief.ts"
import { findBrowser } from "../src/video/browser.ts"
import { buildScenes } from "../src/video/render.ts"

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

test("场景编排：片头片尾署名、标题、每个选手、排名、精彩对局（标题卡 + 回放）", () => {
  const series = readSeries(seriesFile)
  assert.deepEqual(checkScript(script, series), [])
  const scenes = buildScenes(series, script, seriesFile, 10)
  const kinds = scenes.map((s) => s.data.kind)
  assert.equal(kinds[0], "brandOpen")
  assert.equal(kinds.at(-1), "brandClose")
  assert.deepEqual(kinds.slice(1, 5), ["title", "player", "player", "standings"])
  const hl = series.summary!.highlights!.slice(0, 3).length
  assert.equal(kinds.filter((k) => k === "replay").length, hl)
  // 回放场景每帧都能算出局面，最后一帧定格显示结果
  const rs = scenes.find((s) => s.data.kind === "replay")
  if (rs) {
    let last = rs.frame!(0)
    for (let i = 1; i < rs.data.frames; i++) last = rs.frame!(i)
    assert.ok(last.final && last.progress === 1 && last.ents.length > 0)
  }
})

test("video-init：视频目录里有说明、选手代码、战报、待填脚本；已经有脚本时不覆盖", () => {
  sh(["video-init", "lg", "vd", "--text", "用户的一句话"])
  const dir = join(TMP, "vd")
  const prompt = readFileSync(join(dir, "PROMPT.md"), "utf8")
  assert.match(prompt, /用户的一句话/)
  assert.match(prompt, /### 排名/)
  assert.match(prompt, /#### baseline/)
  assert.match(prompt, /rts-arena video --preview/)
  assert.ok(existsSync(join(dir, "bots", "baseline.ts")) && existsSync(join(dir, "bots", "rush.ts")))
  assert.ok(readdirSync(join(dir, "reports")).some((f) => /^game-\d+\.md$/.test(f)))
  const tmpl = JSON.parse(readFileSync(join(dir, "script.json"), "utf8")) as VideoScript
  assert.equal(tmpl.userText, "用户的一句话")
  const again = spawnSync(process.execPath, [CLI, "video-init", "lg", "vd"], { cwd: TMP, encoding: "utf8" })
  assert.equal(again.status, 1)
  assert.match(again.stderr, /已经有 script\.json/)
})

test("渲染：在视频目录里不写参数出预览图；本机有浏览器时出一段 1920×1080 的 MP4 并用浏览器解码检查", { skip: findBrowser() ? false : "本机没有 Chrome / Edge" }, () => {
  const dir = join(TMP, "vd")
  writeFileSync(join(dir, "script.json"), JSON.stringify(script))
  const out = sh(["video", "--preview", "1,6"], dir)
  assert.match(out, /预览图/)
  assert.ok(statSync(join(dir, "夺点联赛-6s.png")).size > 10_000)
  const full = sh(["video", "--out", "v.mp4", "--fps", "10", "--check", "2"], dir)
  assert.match(full, /浏览器解码检查：时长 [\d.]+ 秒，1920×1080/)
  assert.ok(statSync(join(dir, "v.mp4")).size > 100_000)
  assert.ok(existsSync(join(dir, "v-check-2s.png")))
})
