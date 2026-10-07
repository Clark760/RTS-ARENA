// 联赛视频：把联赛汇总 + 大模型写的脚本排成一串场景（片头署名 → 标题和用户原话 → 选手介绍 → 排行榜 → 精彩对局 → 片尾署名），
// 用本机的 Chrome / Edge 无头模式逐帧画出来、编成 MP4。回放场景每帧的局面在这边从回放算好再送进页面
import { readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { applyFrame, ReplayModel, type State } from "../core/replay-model.ts"
import type { Replay } from "../core/types.ts"
import { findBrowser, launchBrowser } from "./browser.ts"
import { checkScript, codeFacts, readSeries, resolveBotFile, type SeriesFile, type VideoScript } from "./brief.ts"
import { installVideoPage, type ReplayFrame, type SceneData } from "./page.ts"
import { excitement, gameFacts } from "../cli/highlights.ts"

/** 联赛没挑中的局：现场从回放算看点（不算爆冷） */
function gameReasons(replay: Replay, seatNames: string[]): string[] {
  const f = gameFacts(replay)
  const sideName = (side: number) => [...new Set(seatNames.filter((_, p) => (replay.players[p]?.team ?? p) === side))].join("+")
  return excitement(f, null, sideName).reasons
}

const PALETTE = ["#4ea1ff", "#ff5d5d", "#5ee08a", "#f5c542", "#c77dff", "#4dd4d4", "#ff9f43", "#a3cb38"]
/** 标准单位的中文名（事件文字用）；规则包自己的类型用原名 */
const TYPE_NAMES: Record<string, string> = { base: "主基地", barracks: "兵营", worker: "工人", soldier: "战士", archer: "弓手", goldmine: "金矿", tower: "箭塔", depot: "仓库" }

export interface RenderOptions {
  seriesFile: string
  script: VideoScript
  out: string
  /** 浏览器路径（不给就找本机的 Chrome / Edge） */
  browser?: string
  fps?: number
  /** 只出这几秒的预览图（PNG），不出视频 */
  preview?: number[]
  /** 输出尺寸，默认 1920×1080（16:9） */
  width?: number
  height?: number
  /** 出完视频后，从成品里截这几秒的画面（PNG）检查 */
  check?: number[]
  onProgress?: (done: number, total: number) => void
}

interface Scene {
  data: SceneData
  /** 回放场景：第 i 帧的局面 */
  frame?: (i: number) => ReplayFrame
}

const sec = (fps: number, s: number) => Math.round(fps * s)

export function buildScenes(series: SeriesFile, script: VideoScript, seriesFile: string, fps: number): Scene[] {
  const sum = series.summary!
  const names = series.participants.map((p) => p.name)
  const color = (i: number) => PALETTE[i % PALETTE.length]
  const sp = (name: string) => script.players.find((p) => p.name === name)
  const display = (name: string) => sp(name)?.displayName || name
  /** 把文字里的联赛名字换成显示名 */
  const relabel = (s: string) => names.reduce((acc, n) => acc.split(n).join(display(n)), s)
  const scenes: Scene[] = []
  scenes.push({ data: { kind: "brandOpen", frames: sec(fps, 3.5), ruleset: series.ruleset.name } })
  const date = series.startedAt.slice(0, 10)
  scenes.push({
    data: {
      kind: "title",
      frames: sec(fps, script.userText ? 7.5 : 5),
      ruleset: series.ruleset.name,
      title: script.title || `${series.ruleset.name}联赛`,
      userText: script.userText || null,
      theme: script.theme || null,
      meta: `${names.length} 位选手 · ${series.results.length} 局 · ${date} · 规则包「${series.ruleset.name}」`,
    },
  })
  // 选手介绍：按脚本里的顺序
  for (const p of script.players) {
    const i = names.indexOf(p.name)
    const st = sum.standings.find((s) => s.index === i)
    const file = resolveBotFile(series.participants[i].file, seriesFile)
    const facts = file ? codeFacts(readFileSync(file, "utf8")) : null
    const factLines = facts
      ? [
          `${facts.lines} 行 · 注释占 ${Math.round(facts.commentRatio * 100)}%`,
          `${facts.functions} 个函数 · ${facts.interfacesAndTypes} 个类型 · ${facts.topLevelState} 个全局状态`,
          `attackMove ×${facts.features["cmd.attackMove"]} · attack ×${facts.features["cmd.attack"]}`,
        ]
      : ["（没找到代码文件）"]
    scenes.push({
      data: {
        kind: "player",
        frames: sec(fps, 4.5 + 1.2 * p.intro.length),
        color: color(i),
        displayName: p.displayName || p.name,
        name: p.name,
        byline: p.byline || null,
        tagline: p.tagline,
        intro: p.intro,
        // 文件开头的 12 个非空行（原样，注释和代码都有）
        codeHeader: file ? readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim() !== "").slice(0, 12).map((l) => l.replace(/\t/g, "  ")) : [],
        facts: factLines,
        record: st ? [`联赛 ${st.wins} 胜 ${st.draws} 平 ${st.losses} 负`, `得分率 ${Math.round(st.rate * 100)}% · 等级分 ${st.elo}`] : [],
        rank: st?.rank ?? names.length,
        total: names.length,
      },
    })
  }
  scenes.push({
    data: {
      kind: "standings",
      frames: sec(fps, 6),
      title: "联赛排名",
      rows: sum.standings.map((s) => ({ name: display(s.name), color: color(s.index), rank: s.rank, record: `${s.wins} 胜 ${s.draws} 平 ${s.losses} 负 · 等级分 ${s.elo}`, rate: s.rate, elo: s.elo })),
    },
  })
  // 精彩对局：脚本指定的，或者联赛挑的前 3 局
  const picks: { index: number; title?: string; commentary?: string }[] = script.highlights?.length
    ? script.highlights
    : (sum.highlights ?? []).slice(0, 3).map((h) => ({ index: h.index }))
  picks.forEach((pick, k) => {
    const g = series.results.find((r) => r.index === pick.index)!
    const hl = sum.highlights?.find((h) => h.index === pick.index)
    const replay = JSON.parse(readFileSync(join(dirname(resolve(seriesFile)), g.replay), "utf8")) as Replay
    // 每个座位是哪个参赛者
    const seatOf = g.names.map((n) => names.indexOf(n))
    const sides = [...new Set(g.teams)].map((t) => {
      const seats = g.teams.map((tt, p) => (tt === t ? p : -1)).filter((p) => p >= 0)
      return { name: [...new Set(seats.map((p) => display(g.names[p])))].join("+"), color: color(seatOf[seats[0]]) }
    })
    const winners = [...new Set(g.winners.map((p) => display(g.names[p])))]
    const result = winners.length ? `${winners.join("、")} 获胜（第 ${g.tick} tick）` : `平局（第 ${g.tick} tick）`
    const title = pick.title || sides.map((s) => s.name).join(" 对 ")
    const commentary = pick.commentary || null
    scenes.push({
      data: { kind: "hlTitle", frames: sec(fps, commentary ? 5.5 : 4.5), no: k + 1, title, sides, result: `第 ${g.index} 局 · ${result} · ${relabel(g.reason)}`, reasons: hl ? hl.reasons.map(relabel) : gameReasons(replay, g.names.map(display)), commentary },
    })
    scenes.push(replayScene(replay, k + 1, title, commentary, seatOf.map((i, p) => ({ name: display(g.names[p]), color: color(i) })), `${result.split("（")[0]}`, fps))
  })
  const credits = series.participants.map((p) => {
    const s = sp(p.name)
    return `${s?.displayName || p.name}${s?.byline ? ` · ${s.byline}` : ""}`
  })
  scenes.push({ data: { kind: "brandClose", frames: sec(fps, 6.5), outro: script.outro || null, credits: [...credits, "比赛、回放、精彩对局和这段视频都由平台自动生成"] } })
  return scenes
}

/** 回放场景：整局按时间压缩成 10～20 秒，最后定格 1.5 秒显示结果 */
function replayScene(replay: Replay, no: number, title: string, commentary: string | null, seats: { name: string; color: string }[], result: string, fps: number): Scene {
  const T = replay.result.tick
  const playFrames = sec(fps, Math.min(20, Math.max(10, T / 160)))
  const hold = sec(fps, 1.5)
  const typeNames = Object.keys(replay.types)
  const types = typeNames.map((name) => {
    const t = replay.types[name]
    return { name, kind: t.kind, shape: t.look?.shape ?? "circle", label: t.look?.label ?? "", color: t.look?.color ?? null, worker: t.worker === true }
  })
  const events = replayEvents(replay, seats)
  const model = new ReplayModel(replay)
  let state: State = model.initialState()
  /** 每帧对应的 tick；按顺序推进局面（不回头） */
  const tickOf = (i: number) => (i >= playFrames ? T : Math.round((i * T) / (playFrames - 1)))
  const deaths: { x: number; y: number; frame: number }[] = []
  let lastTick = 0
  const frame = (i: number): ReplayFrame => {
    const t = tickOf(i)
    const shots: number[] = []
    for (let k = lastTick + 1; k <= t; k++) {
      const f = replay.frames[k - 1]
      const removed = new Set(f.removed ?? [])
      for (const id of f.die ?? []) {
        const e = state.ents.get(id)
        if (e && !removed.has(id) && replay.types[e.type]?.kind !== "resource") deaths.push({ x: e.x, y: e.y, frame: i })
      }
      // 攻击线只画这一帧最后几 tick 的
      if (t - k < 3) {
        const sh = f.shots ?? []
        for (let j = 0; j < sh.length; j += 2) {
          const a = state.ents.get(sh[j])
          const b = state.ents.get(sh[j + 1])
          if (a && b) shots.push(a.x, a.y, b.x, b.y, a.owner)
        }
      }
      applyFrame(state, f)
    }
    lastTick = t
    const ents: number[] = []
    for (const e of state.ents.values()) {
      const ty = replay.types[e.type]
      if (!ty) continue
      const hp = ty.kind === "resource" || !ty.maxHp ? 100 : Math.max(0, Math.min(100, Math.round((100 * e.hp) / ty.maxHp)))
      ents.push(e.x, e.y, ty.w, ty.h, e.owner, typeNames.indexOf(e.type), hp, e.bp ?? 100)
    }
    const counts = seats.map((_, p) => {
      let army = 0
      let workers = 0
      let buildings = 0
      for (const e of state.ents.values()) {
        if (e.owner !== p) continue
        const ty = replay.types[e.type]
        if (ty?.kind === "building") buildings++
        else if (ty?.kind === "unit") ty.worker ? workers++ : army++
      }
      return { army, workers, buildings, score: Math.round(state.players[p]?.score ?? 0), alive: state.players[p]?.alive ?? true }
    })
    const recent = deaths.filter((d) => i - d.frame < 8).flatMap((d) => [d.x, d.y, i - d.frame])
    return { t, ents, shots, deaths: recent, counts, events: events.filter((e) => e.t <= t).map((e) => e.text), progress: T ? t / T : 1, final: i >= playFrames }
  }
  return {
    data: { kind: "replay", frames: playFrames + hold, no, title, commentary, width: replay.map.width, height: replay.map.height, terrain: replay.map.terrain, colors: replay.map.colors, types, seats, result },
    frame,
  }
}

/** 回放里的大事：第一次交火、失去建筑、大战（死 6 个以上）、出局 */
function replayEvents(replay: Replay, seats: { name: string }[]): { t: number; text: string }[] {
  const out: { t: number; text: string }[] = []
  const s = new ReplayModel(replay).initialState()
  const team = (p: number) => replay.players[p]?.team ?? p
  const name = (p: number) => (p >= 0 ? (seats[p]?.name ?? `P${p}`) : "中立")
  const tn = (type: string) => TYPE_NAMES[type] ?? type
  let contact = false
  let battle: { t0: number; t1: number; lost: number[] } | null = null
  const flush = () => {
    if (battle && battle.lost.reduce((a, b) => a + b, 0) >= 6)
      out.push({ t: battle.t1, text: `t${battle.t0} 大战：${battle.lost.map((n, p) => `${name(p)} 损失 ${n}`).join("，")}` })
    battle = null
  }
  const wasAlive = s.players.map((p) => p.alive)
  for (const f of replay.frames) {
    const sh = f.shots ?? []
    for (let j = 0; j < sh.length && !contact; j += 2) {
      const a = s.ents.get(sh[j])
      const b = s.ents.get(sh[j + 1])
      if (a && b && a.owner >= 0 && b.owner >= 0 && team(a.owner) !== team(b.owner)) {
        contact = true
        out.push({ t: f.t, text: `t${f.t} 第一次交火` })
      }
    }
    const removed = new Set(f.removed ?? [])
    for (const id of f.die ?? []) {
      const e = s.ents.get(id)
      if (!e || removed.has(id) || e.owner < 0) continue
      const ty = replay.types[e.type]
      if (ty?.kind === "building") out.push({ t: f.t, text: `t${f.t} ${name(e.owner)} 失去${tn(e.type)}${e.bp !== undefined ? "（没建好）" : ""}` })
      else if (ty?.kind === "unit") {
        if (battle && f.t - battle.t1 > 80) flush()
        battle ??= { t0: f.t, t1: f.t, lost: seats.map(() => 0) }
        battle.t1 = f.t
        battle.lost[e.owner] = (battle.lost[e.owner] ?? 0) + 1
      }
    }
    applyFrame(s, f)
    s.players.forEach((p, i) => {
      if (wasAlive[i] && !p.alive) out.push({ t: f.t, text: `t${f.t} ${name(i)} 出局` })
      wasAlive[i] = p.alive
    })
  }
  flush()
  return out.sort((a, b) => a.t - b.t)
}

export async function renderLeagueVideo(o: RenderOptions): Promise<{ file: string | null; seconds: number; frames: number; bytes: number; images: string[]; probe: { duration: number; width: number; height: number } | null }> {
  const series = readSeries(o.seriesFile)
  const errs = checkScript(o.script, series)
  if (errs.length) throw new Error(`脚本有问题：\n- ${errs.join("\n- ")}`)
  const fps = o.fps ?? 30
  const scenes = buildScenes(series, o.script, o.seriesFile, fps)
  const total = scenes.reduce((a, s) => a + s.data.frames, 0)
  const exe = findBrowser(o.browser)
  if (!exe) throw new Error("找不到 Chrome 或 Edge：视频要用本机的浏览器渲染。装一个，或者用 --browser <路径> / 环境变量 RTS_ARENA_BROWSER 指定")
  const browser = await launchBrowser(exe)
  const images: string[] = []
  const stem = o.out.replace(/\.mp4$/i, "")
  try {
    const muxerFile = createRequire(import.meta.url).resolve("mp4-muxer")
    await browser.evaluate(readFileSync(muxerFile, "utf8") + ";true")
    await browser.evaluate(`(${installVideoPage.toString()})();true`)
    const width = o.width ?? 1920
    const height = o.height ?? 1080
    await browser.evaluate(`__size(${width}, ${height})`)
    const ok = await browser.evaluate<boolean>(`typeof VideoEncoder === "function"`)
    if (!ok) throw new Error("这个浏览器不支持 WebCodecs（VideoEncoder），换一个新一点的 Chrome / Edge")
    // 场景的起始帧
    const starts: number[] = []
    scenes.reduce((a, s) => (starts.push(a), a + s.data.frames), 0)
    if (o.preview?.length) {
      for (const t of o.preview) {
        const f = Math.max(0, Math.min(total - 1, Math.round(t * fps)))
        const k = starts.findLastIndex((st) => st <= f)
        const sc = scenes[k]
        await browser.evaluate(`__scene(${JSON.stringify(sc.data)})`)
        const local = f - starts[k]
        // 回放场景要从头推到这一帧
        let rf: ReplayFrame | null = null
        if (sc.frame) for (let i = 0; i <= local; i++) rf = sc.frame(i)
        const png = await browser.evaluate<string>(`__png(${local}, ${JSON.stringify(rf)})`)
        const file = `${stem}-${t}s.png`
        writeFileSync(file, Buffer.from(png, "base64"))
        images.push(file)
        if (sc.frame) scenes.splice(k, 1, ...buildScenes(series, o.script, o.seriesFile, fps).slice(k, k + 1)) // 回放的局面只能往前推，用过就重建
      }
      return { file: null, seconds: total / fps, frames: total, bytes: 0, images, probe: null }
    }
    // 码率按像素数算：1080p 约 8 Mbps
    await browser.evaluate(`__init(${JSON.stringify({ fps, bitrate: Math.round((width * height * fps) / 7.8) })})`)
    let done = 0
    for (const sc of scenes) {
      await browser.evaluate(`__scene(${JSON.stringify(sc.data)})`)
      const n = sc.data.frames
      for (let i = 0; i < n; i += 10) {
        const batch: [number, ReplayFrame | null][] = []
        for (let j = i; j < Math.min(n, i + 10); j++) batch.push([j, sc.frame ? sc.frame(j) : null])
        await browser.evaluate(`__frames(${JSON.stringify(batch)})`)
        done += batch.length
        o.onProgress?.(done, total)
      }
    }
    const size = await browser.evaluate<number>("__finish()")
    const parts: Buffer[] = []
    for (let k = 0; k * 3_000_000 < size; k++) parts.push(Buffer.from(await browser.evaluate<string>(`__chunk(${k})`), "base64"))
    const bytes = Buffer.concat(parts)
    writeFileSync(o.out, bytes)
    // 用浏览器把成品解一遍：时长、尺寸对不对，顺便截几张图
    const probe = await browser.evaluate<{ duration: number; width: number; height: number; shots: string[] }>(`__probe(${JSON.stringify(o.check ?? [])})`)
    probe.shots.forEach((b64, k) => {
      const file = `${stem}-check-${o.check![k]}s.png`
      writeFileSync(file, Buffer.from(b64, "base64"))
      images.push(file)
    })
    return { file: o.out, seconds: total / fps, frames: total, bytes: bytes.length, images, probe: { duration: probe.duration, width: probe.width, height: probe.height } }
  } finally {
    await browser.close()
  }
}
