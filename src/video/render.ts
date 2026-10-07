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
import { groupBattles } from "../cli/battles.ts"

/** 联赛没挑中的局：现场从回放算看点（不算爆冷） */
function gameReasons(replay: Replay, seatNames: string[]): string[] {
  const f = gameFacts(replay)
  const sideName = (side: number) => [...new Set(seatNames.filter((_, p) => (replay.players[p]?.team ?? p) === side))].join("+")
  return excitement(f, null, sideName).reasons
}

export const PALETTE = ["#4ea1ff", "#ff5d5d", "#5ee08a", "#f5c542", "#c77dff", "#4dd4d4", "#ff9f43", "#a3cb38"]
/** 每个选手在视频里的颜色（按参赛顺序），写在 PROMPT.md 里 */
export const PALETTE_NAMES = ["蓝", "红", "绿", "黄", "紫", "青", "橙", "草绿"]
/** 标准单位的中文名（事件文字用）；规则包自己的类型用原名 */
const TYPE_NAMES: Record<string, string> = { base: "主基地", barracks: "兵营", worker: "工人", soldier: "战士", archer: "弓手", goldmine: "金矿", tower: "箭塔", depot: "仓库" }

export interface RenderOptions {
  seriesFile: string
  script: VideoScript
  out: string
  /** 浏览器路径（不给就找本机的 Chrome / Edge） */
  browser?: string
  fps?: number
  /** 只出这几秒的预览图（PNG），不出视频；"auto" 是每段各出一张（回放段两张） */
  preview?: number[] | "auto"
  /** 输出尺寸，默认 1920×1080（16:9） */
  width?: number
  height?: number
  /** 出完视频后，从成品里截这几秒的画面（PNG）检查 */
  check?: number[]
  onProgress?: (done: number, total: number) => void
}

interface Scene {
  /** 时间表里显示的名字 */
  label: string
  data: SceneData
  /** 回放场景：第 i 帧的局面 */
  frame?: (i: number) => ReplayFrame
}

const sec = (fps: number, s: number) => Math.round(fps * s)
/** 按要读的字数定时长（大约每秒读 11 个字），限制在 min～max 秒 */
const readSecs = (chars: number, base: number, min: number, max: number) => Math.min(max, Math.max(min, base + chars / 11))
const len = (...xs: (string | null | undefined)[]) => xs.reduce((a, x) => a + [...(x ?? "")].length, 0)
/** 代码卡片上不值得占行的：空注释、分隔线 */
const BLANKISH = /^\s*(?:\/\/+|\/\*+|\*+\/?)?\s*[-=*#~_/]*\s*$/

export function buildScenes(series: SeriesFile, script: VideoScript, seriesFile: string, fps: number): Scene[] {
  const sum = series.summary!
  const names = series.participants.map((p) => p.name)
  const color = (i: number) => PALETTE[i % PALETTE.length]
  const sp = (name: string) => script.players.find((p) => p.name === name)
  const display = (name: string) => sp(name)?.displayName || name
  /** 把文字里的联赛名字换成显示名 */
  const relabel = (s: string) => names.reduce((acc, n) => acc.split(n).join(display(n)), s)
  const scenes: Scene[] = []
  scenes.push({ label: "片头署名", data: { kind: "brandOpen", frames: sec(fps, 3.5), ruleset: series.ruleset.name } })
  const date = series.startedAt.slice(0, 10)
  scenes.push({
    label: "标题、用户原话和解读",
    data: {
      kind: "title",
      frames: sec(fps, readSecs(len(script.userText, script.theme), 3, 5, 12)),
      ruleset: series.ruleset.name,
      // 标题上面那行小字：脚本写了标题就是"<规则包>联赛"，没写（标题就是"<规则包>联赛"）就不重复
      eyebrow: script.title ? `${series.ruleset.name}联赛` : "RTS Arena 联赛视频",
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
          `${facts.functions} 个函数 · ${facts.interfacesAndTypes} 个类型 · ${facts.topLevelState} 个顶层变量`,
          `attackMove ×${facts.features["cmd.attackMove"]} · attack ×${facts.features["cmd.attack"]}`,
        ]
      : ["（没找到代码文件）"]
    scenes.push({
      label: `选手 ${p.displayName || p.name}`,
      data: {
        kind: "player",
        frames: sec(fps, readSecs(len(p.tagline, ...p.intro), 2.5, 7, 14)),
        color: color(i),
        displayName: p.displayName || p.name,
        name: p.name,
        byline: p.byline || null,
        tagline: p.tagline,
        intro: p.intro,
        // 文件开头的 12 行（原样，注释和代码都有；跳过空行、空注释和分隔线）
        codeHeader: file ? readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n").filter((l) => !BLANKISH.test(l)).slice(0, 12).map((l) => l.replace(/\t/g, "  ")) : [],
        facts: factLines,
        record: st ? [`联赛 ${st.wins} 胜 ${st.draws} 平 ${st.losses} 负`, `得分率 ${Math.round(st.rate * 100)}% · 等级分 ${st.elo}`] : [],
        rank: st?.rank ?? names.length,
        total: names.length,
      },
    })
  }
  scenes.push({
    label: "联赛排名",
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
    const result = winners.length ? `${winners.join("、")} 获胜` : "平局"
    const title = pick.title || sides.map((s) => s.name).join(" 对 ")
    const commentary = pick.commentary || null
    const reasons = (hl ? hl.reasons.map(relabel) : gameReasons(replay, g.names.map(display))).slice(0, 4)
    scenes.push({
      label: `精彩对局 ${k + 1} 标题卡（第 ${g.index} 局）`,
      data: { kind: "hlTitle", frames: sec(fps, readSecs(len(commentary) + 0.4 * len(...reasons), 2.5, 4.5, 8)), no: k + 1, title, sides, result: `第 ${g.index} 局 · ${result} · 第 ${g.tick} tick · ${relabel(g.reason)}`, reasons, commentary },
    })
    scenes.push({ label: `精彩对局 ${k + 1} 回放`, ...replayScene(replay, k + 1, title, commentary, seatOf.map((i, p) => ({ name: display(g.names[p]), color: color(i) })), result, fps) })
  })
  const credits = series.participants.map((p) => {
    const s = sp(p.name)
    return `${s?.displayName || p.name}${s?.byline ? ` · ${s.byline}` : ""}`
  })
  scenes.push({ label: "总结、片尾署名和选手名单", data: { kind: "brandClose", frames: sec(fps, 6.5), outro: script.outro || null, credits: [...credits, "比赛、回放、精彩对局和这段视频都由平台自动生成"] } })
  return scenes
}

/**
 * 回放每帧对应的 tick：打得热闹的时候慢放，没什么动静的时候快进（最多差 4 倍）。
 * 按每一小段的攻击和死亡数算"热闹程度"，前后平滑一下免得忽快忽慢
 */
export function pacing(replay: Replay, playFrames: number): { tickOf: (i: number) => number; fast: (i: number) => boolean } {
  const T = Math.max(1, replay.result.tick)
  const B = Math.max(5, Math.round(T / 400))
  const nb = Math.ceil(T / B)
  const act = new Array<number>(nb).fill(0)
  replay.frames.forEach((f, k) => {
    if (k >= T) return
    act[Math.floor(k / B)] += (f.shots?.length ?? 0) / 2 + 4 * (f.die?.length ?? 0)
  })
  const R = 3
  const smooth = act.map((_, b) => {
    let s = 0
    let n = 0
    for (let j = Math.max(0, b - R); j <= Math.min(nb - 1, b + R); j++) (s += act[j]), n++
    return s / n
  })
  const busy = smooth.filter((x) => x > 0).sort((a, b) => a - b)
  const ref = busy.length ? busy[Math.floor(busy.length * 0.6)] : 0
  const weight = smooth.map((x) => (ref > 0 ? 1 + 3 * Math.min(1, x / ref) : 1))
  const cum = [0]
  weight.forEach((wt, b) => cum.push(cum[b] + wt * (Math.min(T, (b + 1) * B) - b * B)))
  const total = cum[nb]
  const varies = Math.max(...weight) >= 2 * Math.min(...weight)
  const bucketAt = (i: number) => {
    const u = (Math.min(i, playFrames - 1) / Math.max(1, playFrames - 1)) * total
    let b = 0
    while (b < nb - 1 && cum[b + 1] <= u) b++
    return { b, u }
  }
  return {
    tickOf: (i) => {
      if (i >= playFrames - 1) return T
      const { b, u } = bucketAt(i)
      return Math.min(T, Math.round(b * B + (u - cum[b]) / weight[b]))
    },
    fast: (i) => varies && weight[bucketAt(i).b] < 1.6,
  }
}

/** 回放场景：整局压缩成 10～20 秒（打起来慢放、没动静快进），最后定格 1.5 秒显示结果 */
function replayScene(replay: Replay, no: number, title: string, commentary: string | null, seats: { name: string; color: string }[], result: string, fps: number): Omit<Scene, "label"> {
  const T = replay.result.tick
  const playFrames = sec(fps, Math.min(20, Math.max(10, T / 160)))
  const hold = sec(fps, 1.5)
  const typeNames = Object.keys(replay.types)
  const types = typeNames.map((name) => {
    const t = replay.types[name]
    return { name, kind: t.kind, shape: t.look?.shape ?? "circle", label: t.look?.label ?? "", color: t.look?.color ?? null, worker: t.worker === true }
  })
  const eventsAt = replayEvents(replay, seats)
  const pace = pacing(replay, playFrames)
  const model = new ReplayModel(replay)
  let state: State = model.initialState()
  const tickOf = (i: number) => (i >= playFrames ? T : pace.tickOf(i))
  let deaths: { x: number; y: number; frame: number }[] = []
  let lastTick = 0
  let lastFrame = -1
  /** 第 i 帧的局面：局面只能往前推，往回要的话从头再来（预览时会这样） */
  const frame = (i: number): ReplayFrame => {
    if (i <= lastFrame) {
      state = model.initialState()
      deaths = []
      lastTick = 0
    }
    lastFrame = i
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
    return { t, ents, shots, deaths: recent, counts, events: eventsAt(t), progress: T ? t / T : 1, final: i >= playFrames, fast: i < playFrames && pace.fast(i) }
  }
  return {
    data: { kind: "replay", frames: playFrames + hold, no, title, commentary, width: replay.map.width, height: replay.map.height, terrain: replay.map.terrain, colors: replay.map.colors, types, seats, result },
    frame,
  }
}

/** 侧栏里算"大战"的门槛：一场死 6 个以上 */
const BIG_BATTLE = 6

/**
 * 回放里的大事：第一次交火、失去建筑、大战、出局。返回"到第 t tick 为止该显示哪些"。
 * 大战和战报"战斗"一节是同一套切分（battles.ts，死亡算法也一样：不算资源和规则包移除的），时间和损失数对得上；
 * 一开打就显示"交战中"，损失随时间往上加，打完显示起止时间
 */
function replayEvents(replay: Replay, seats: { name: string }[]): (t: number) => string[] {
  const fixed: { t: number; text: string }[] = []
  const deaths: { t: number; x: number; y: number; owner: number }[] = []
  const s = new ReplayModel(replay).initialState()
  const team = (p: number) => replay.players[p]?.team ?? p
  const name = (p: number) => (p >= 0 ? (seats[p]?.name ?? `P${p}`) : "中立")
  const tn = (type: string) => TYPE_NAMES[type] ?? type
  let contact = false
  const wasAlive = s.players.map((p) => p.alive)
  for (const f of replay.frames) {
    const sh = f.shots ?? []
    for (let j = 0; j < sh.length && !contact; j += 2) {
      const a = s.ents.get(sh[j])
      const b = s.ents.get(sh[j + 1])
      if (a && b && a.owner >= 0 && b.owner >= 0 && team(a.owner) !== team(b.owner)) {
        contact = true
        fixed.push({ t: f.t, text: `t${f.t} 第一次交火` })
      }
    }
    const removed = new Set(f.removed ?? [])
    for (const id of f.die ?? []) {
      const e = s.ents.get(id)
      if (!e || removed.has(id)) continue
      const ty = replay.types[e.type]
      if (ty?.kind === "resource") continue
      deaths.push({ t: f.t, x: e.x, y: e.y, owner: e.owner })
      if (ty?.kind === "building" && e.owner >= 0) fixed.push({ t: f.t, text: `t${f.t} ${name(e.owner)} 失去${tn(e.type)}${e.bp !== undefined ? "（没建好）" : ""}` })
    }
    applyFrame(s, f)
    s.players.forEach((p, i) => {
      if (wasAlive[i] && !p.alive) fixed.push({ t: f.t, text: `t${f.t} ${name(i)} 出局` })
      wasAlive[i] = p.alive
    })
  }
  const battles = groupBattles(deaths).filter((b) => b.length >= BIG_BATTLE)
  return (t) => {
    const items = fixed.filter((e) => e.t <= t)
    for (const b of battles) {
      if (b[0].t > t) continue
      const t1 = b[b.length - 1].t
      const owners = [...new Set(b.map((d) => d.owner))].sort((x, y) => x - y)
      const loss = owners.map((p) => `${name(p)} 损失 ${b.filter((d) => d.owner === p && d.t <= t).length}`).join("，")
      items.push({ t: b[0].t, text: t >= t1 ? `t${b[0].t}～${t1} 大战：${loss}` : `t${b[0].t} 起交战中：${loss}` })
    }
    return items.sort((x, y) => x.t - y.t).map((e) => e.text)
  }
}

/** 时间表：每段从第几秒到第几秒、是什么 */
export interface TimelineItem {
  from: number
  to: number
  label: string
}

export function timelineOf(scenes: Scene[], fps: number): TimelineItem[] {
  let f = 0
  return scenes.map((s) => {
    const from = f / fps
    f += s.data.frames
    return { from, to: f / fps, label: s.label }
  })
}

export function timelineText(items: TimelineItem[]): string {
  return items.map((x) => `  ${x.from.toFixed(1).padStart(5)}～${x.to.toFixed(1).padEnd(5)} 秒  ${x.label}`).join("\n")
}

/** --preview auto：每段取一个动画出完、还没淡出的时刻；回放段取中间和最后定格 */
function autoPreview(scenes: Scene[], fps: number): number[] {
  const out: number[] = []
  let f = 0
  const at = (frame: number) => out.push(Math.round((frame / fps) * 10) / 10)
  for (const s of scenes) {
    const n = s.data.frames
    if (s.frame) {
      at(f + Math.round((n - sec(fps, 1.5)) / 2))
      at(f + n - sec(fps, 0.7))
    } else at(f + Math.round(n * 0.7))
    f += n
  }
  return out
}

export interface RenderResult {
  file: string | null
  seconds: number
  frames: number
  bytes: number
  images: string[]
  probe: { duration: number; width: number; height: number } | null
  timeline: TimelineItem[]
}

export async function renderLeagueVideo(o: RenderOptions): Promise<RenderResult> {
  const series = readSeries(o.seriesFile)
  const errs = checkScript(o.script, series)
  if (errs.length) throw new Error(`脚本有问题：\n- ${errs.join("\n- ")}`)
  const fps = o.fps ?? 30
  const scenes = buildScenes(series, o.script, o.seriesFile, fps)
  const total = scenes.reduce((a, s) => a + s.data.frames, 0)
  const timeline = timelineOf(scenes, fps)
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
    const preview = o.preview === "auto" ? autoPreview(scenes, fps) : o.preview
    if (preview?.length) {
      for (const t of preview) {
        const f = Math.max(0, Math.min(total - 1, Math.round(t * fps)))
        const k = starts.findLastIndex((st) => st <= f)
        const sc = scenes[k]
        await browser.evaluate(`__scene(${JSON.stringify(sc.data)})`)
        const local = f - starts[k]
        // 回放场景要从头推到这一帧（刚死的红圈要知道是哪一帧死的）
        let rf: ReplayFrame | null = null
        if (sc.frame) for (let i = 0; i <= local; i++) rf = sc.frame(i)
        const png = await browser.evaluate<string>(`__png(${local}, ${JSON.stringify(rf)})`)
        const file = `${stem}-${t}s.png`
        writeFileSync(file, Buffer.from(png, "base64"))
        images.push(file)
      }
      return { file: null, seconds: total / fps, frames: total, bytes: 0, images, probe: null, timeline }
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
    return { file: o.out, seconds: total / fps, frames: total, bytes: bytes.length, images, probe: { duration: probe.duration, width: probe.width, height: probe.height }, timeline }
  } finally {
    await browser.close()
  }
}
