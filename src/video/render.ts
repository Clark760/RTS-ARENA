// 联赛视频：把联赛汇总 + 大模型写的脚本排成一串场景（片头署名 → 规则介绍 → 选手介绍 → 排行榜 → 精彩对局 → 片尾署名），
// 用本机的 Chrome / Edge 无头模式逐帧画出来、编成 MP4。回放场景每帧的局面在这边从回放算好再送进页面
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { basename, dirname, join, resolve } from "node:path"
import { applyFrame, ReplayModel, type State } from "../core/replay-model.ts"
import type { Replay } from "../core/types.ts"
import { findBrowser, launchBrowser } from "./browser.ts"
import { checkScript, codeFacts, factTags, gameScores, highlightPlayerWarnings, PLAYER_PAGE_CHARS, PLAYER_PAGE_MIN, readSeries, resolveBotFile, RULES_PAGE_CHARS, SCRIPT_LIMITS, scriptWarnings, type SeriesFile, type VideoScript } from "./brief.ts"
import { installVideoPage, type ReplayFrame, type SceneData } from "./page.ts"
import { excitement, gameFacts } from "../cli/highlights.ts"
import { fighterTest, groupBattles, isRout } from "../cli/battles.ts"
import { importRuleset, listRulesets } from "../cli/catalog.ts"
import { analyzeLeague, baseTypeOf, twoSides, winCurve, type LeagueAnalysis } from "./analysis.ts"

/** 联赛没挑中的局：现场从回放算看点（不算爆冷） */
export function gameReasons(replay: Replay, seatNames: string[]): string[] {
  const f = gameFacts(replay)
  const sideName = (side: number) => [...new Set(seatNames.filter((_, p) => (replay.players[p]?.team ?? p) === side))].join("+")
  return excitement(f, null, sideName).reasons
}

export const PALETTE = ["#4ea1ff", "#ff5d5d", "#5ee08a", "#f5c542", "#c77dff", "#4dd4d4", "#ff9f43", "#a3cb38"]
/** 每个选手在视频里的颜色（按参赛顺序），写在 PROMPT.md 里 */
export const PALETTE_NAMES = ["蓝", "红", "绿", "黄", "紫", "青", "橙", "草绿"]
/** 标准单位的中文名（事件文字用）；规则包自己的类型用原名 */
const TYPE_NAMES: Record<string, string> = { base: "主基地", barracks: "兵营", worker: "工人", soldier: "战士", archer: "弓手", goldmine: "金矿", tower: "箭塔", depot: "仓库" }
/** 类型的中文名：规则包写了 look.name 就用它，否则常见类型用上面的表，再不行显示类型名 */
function typeName(replay: Replay, k: string): string {
  return replay.types[k]?.look?.name ?? TYPE_NAMES[k] ?? k
}

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
  check?: number[] | "auto"
  /** 预览图和检查截图放在哪个目录（默认视频旁边的 preview/）；--out 指到别处时截图也不跟过去 */
  imagesDir?: string
  onProgress?: (done: number, total: number) => void
  /** 竖屏短版（1080×1920，D-179）：开场、两局精彩对局的大战、排名、片尾 */
  short?: boolean
}

interface Scene {
  /** 时间表里显示的名字 */
  label: string
  data: SceneData
  /** 回放场景：第 i 帧的局面 */
  frame?: (i: number) => ReplayFrame
}

const sec = (fps: number, s: number) => Math.round(fps * s)
/** 片头片尾、选手页的节奏：时长和页内动画都比原来快这么多倍（D-146，用户要求快 1.3 倍左右；标题卡 D-149 退回原速） */
export const BRISK = 1.3
/** 平台拼出来的文字在名字前后留了空格（给英文名用的）；名字是中文时，汉字之间的空格去掉："98% 的 大肥鱼" → "98% 的大肥鱼" */
export const tidy = (s: string) => s.replace(/([一-鿿）」』]) (?=[一-鿿（「『])/g, "$1")
/** 按要读的字数定时长（大约每秒读 11 个字），限制在 min～max 秒 */
const readSecs = (chars: number, base: number, min: number, max: number) => Math.min(max, Math.max(min, base + chars / 11))
const len = (...xs: (string | null | undefined)[]) => xs.reduce((a, x) => a + [...(x ?? "")].length, 0)
/** 代码卡片上不值得占行的：空注释、分隔线 */
const BLANKISH = /^\s*(?:\/\/+|\/\*+|\*+\/?)?\s*[-=*#~_/]*\s*$/

/** 规则包的单位数值（老回放里没记攻击数据时，规则介绍的图例从这里补） */
type TypeSpecs = Record<string, { attack?: { damage: number; range: number; cooldown: number; vs?: Partial<Record<string, number>> } | null; gather?: unknown; builds?: string[]; look?: { name?: string } }>

/** 头像默认从形象图哪里裁：[脸中心 x, 脸中心 y, 边长]（按图宽、图高的比例），立绘一般是脸在上部居中 */
export const DEFAULT_AVATAR = [0.49, 0.115, 0.32]

/**
 * analysis 是这次联赛的分析（雷达图、胜率模型，见 analysis.ts）；不给（只核对脚本、算时间表时）就不画雷达图和胜率。
 * 选手有形象图（脚本的 portrait）时，页面里按选手的联赛名字取图（renderLeagueVideo 先把图送进页面）
 */
/** 冷开场放几秒（大战 2 倍速） */
const COLD_SECONDS = 7
/** 竖屏短版里每局精彩对局的大战最多放几秒 */
const SHORT_BATTLE_SECONDS = 12

export function buildScenes(
  series: SeriesFile,
  script: VideoScript,
  seriesFile: string,
  fps: number,
  specs?: TypeSpecs,
  analysis?: LeagueAnalysis | null,
  opts: { short?: boolean } = {},
): Scene[] {
  const sum = series.summary!
  const names = series.participants.map((p) => p.name)
  const color = (i: number) => PALETTE[i % PALETTE.length]
  const sp = (name: string) => script.players.find((p) => p.name === name)
  const display = (name: string) => sp(name)?.displayName || name
  /** 把文字里的联赛名字换成显示名 */
  const relabel = (s: string) => tidy(names.reduce((acc, n) => acc.split(n).join(display(n)), s))
  // 读回放；老回放里没记中文名（look.name）时用当前规则包里写的
  const loadReplay = (file: string) => {
    const r = JSON.parse(readFileSync(join(dirname(resolve(seriesFile)), file), "utf8")) as Replay
    for (const [k, t] of Object.entries(r.types)) {
      const name = specs?.[k]?.look?.name
      if (name && t.look && !t.look.name) t.look = { ...t.look, name }
    }
    return r
  }
  const scenes: Scene[] = []
  /** 选手有形象图就用联赛名字当图的名字（页面里按它取），头像按 avatar 裁 */
  const imageOf = (name: string) => (sp(name)?.portrait ? name : null)
  const avatarOf = (name: string) => (sp(name)?.avatar?.length === 3 ? sp(name)!.avatar! : DEFAULT_AVATAR)
  // 精彩对局：脚本指定的，或者联赛挑的前 3 局
  const picks: { index: number; title?: string; commentary?: string }[] = script.highlights?.length
    ? script.highlights
    : (sum.highlights ?? []).slice(0, 3).map((h) => ({ index: h.index }))
  /** 一局精彩对局要用的东西：回放、双方、结果、标题、解说、座位 */
  const hlData = (pick: { index: number; title?: string; commentary?: string }) => {
    const g = series.results.find((r) => r.index === pick.index)!
    const replay = loadReplay(g.replay)
    // 每个座位是哪个参赛者
    const seatOf = g.names.map((n) => names.indexOf(n))
    const sides = [...new Set(g.teams)].map((t) => {
      const seats = g.teams.map((tt, p) => (tt === t ? p : -1)).filter((p) => p >= 0)
      return { name: [...new Set(seats.map((p) => display(g.names[p])))].join("+"), color: color(seatOf[seats[0]]) }
    })
    const winners = [...new Set(g.winners.map((p) => display(g.names[p])))]
    const result = tidy(winners.length ? `${winners.join("、")} 获胜` : "平局")
    const title = pick.title || sides.map((s) => s.name).join(" 对 ")
    const commentary = pick.commentary || null
    const seats = seatOf.map((i, p) => ({ name: display(g.names[p]), color: color(i), avatar: imageOf(g.names[p]), crop: avatarOf(g.names[p]) }))
    return { g, replay, seatOf, sides, result, title, commentary, seats }
  }
  /** 一局里最大的那一仗按 2 倍速放 seconds 秒（冷开场、竖屏短版用）；没打过仗返回 null */
  const battleClip = (h: ReturnType<typeof hlData>, seconds: number, hook: { text: string; sub: string } | null, no: number) => {
    const w = biggestBattle(h.replay)
    if (!w) return null
    const rate = Math.max(1, h.replay.tickRate || 10)
    const t1 = Math.min(h.replay.result.tick, w[0] + Math.round(seconds * rate * BATTLE_SPEED))
    return replayScene(h.replay, no, h.title, h.commentary, h.seats, h.result, fps, analysis?.weights ?? null, { window: [w[0], t1], hook })
  }
  // 开场（D-179，用户：视频三秒跳出率高）：第一帧就是全体选手的立绘阵容和一句大字（不从黑屏淡入，也适合当封面），
  // 接着冷开场——开场那局最大的一仗按 2 倍速放 7 秒，然后才是片头署名
  const hookPick = script.hook?.index !== undefined ? { index: script.hook.index } : picks[0]
  const hook = hookPick ? hlData({ ...picks.find((x) => x.index === hookPick.index), index: hookPick.index }) : null
  const hookText = script.hook?.text || (hook ? `${hook.sides.map((x) => x.name).join(" 对 ")}，谁能赢？` : `${series.ruleset.name}联赛`)
  scenes.push({
    label: "开场阵容",
    data: {
      kind: "lineup",
      frames: sec(fps, 1.6),
      title: hookText,
      sub: `${series.ruleset.name}联赛 · ${names.length} 位选手 · ${series.results.length} 局`,
      players: script.players.map((p) => ({ name: display(p.name), color: color(names.indexOf(p.name)), portrait: imageOf(p.name) })),
    },
  })
  if (hook) {
    const at = biggestBattle(hook.replay)
    const clip = battleClip(hook, COLD_SECONDS, { text: hookText, sub: `第 ${hook.g.index} 局 · ${hook.sides.map((x) => x.name).join(" 对 ")} · 第 ${at?.[0] ?? 0} tick 起的大战` }, 0)
    if (clip) scenes.push({ label: `冷开场（第 ${hook.g.index} 局最大的一仗）`, ...clip })
  }
  scenes.push({ label: "片头署名", data: { kind: "brandOpen", frames: sec(fps, (opts.short ? 2 : 3.5) / BRISK), speed: BRISK, ruleset: series.ruleset.name } })
  // 竖屏短版（D-179，可选）：开场、片头之后，两局精彩对局各放最大的一仗，再是排名和片尾
  if (opts.short) {
    const rest = picks.filter((x) => x.index !== hook?.g.index).slice(0, 2)
    rest.forEach((pick, k) => {
      const h = hlData(pick)
      const clip = battleClip(h, SHORT_BATTLE_SECONDS, null, k + 1)
      if (clip) scenes.push({ label: `精彩对局 ${k + 1}（第 ${h.g.index} 局最大的一仗）`, ...clip })
    })
    scenes.push({
      label: "联赛排名",
      data: {
        kind: "standings",
        frames: sec(fps, 5),
        title: "联赛排名",
        rows: sum.standings.map((x) => ({ name: display(x.name), color: color(x.index), rank: x.rank, record: `${x.wins} 胜 ${x.draws} 平 ${x.losses} 负 · 等级分 ${x.elo}`, rate: x.rate, elo: x.elo, portrait: imageOf(x.name) })),
      },
    })
    const credits = script.players.map((x) => `${x.displayName || x.name}${x.byline ? ` · ${x.byline}` : ""}`)
    scenes.push({ label: "片尾署名", data: { kind: "brandClose", frames: sec(fps, 4), speed: BRISK, outro: script.outro || null, credits: [...credits, "比赛、回放、精彩对局和这段视频都由平台自动生成"] } })
    return scenes
  }
  // 片头之后直接是规则介绍（D-177：不再有标题页、不再展示用户的话）
  // 规则介绍：脚本写的几句（不写就用规则包的一句话简介），右边是第一局精彩对局的开局地图和单位图例
  const rulesLines = script.rules?.length ? script.rules : series.ruleset.summary ? [series.ruleset.summary] : []
  const mapIndex = script.highlights?.[0]?.index ?? sum.highlights?.[0]?.index ?? series.results[0]?.index
  const mapGame = series.results.find((r) => r.index === mapIndex)
  if (mapGame) {
    const replay = loadReplay(mapGame.replay)
    const seatOf = mapGame.names.map((n) => names.indexOf(n))
    scenes.push({ label: "规则介绍", data: rulesScene(replay, series.ruleset.name, rulesLines, `第 ${mapGame.index} 局的开局地图`, seatOf.map((i) => color(i)), fps, specs) })
  }
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
        // 按字数算：读字速度按每秒 11 字的 1.3 倍（约 14 字），4.6～13 秒（D-148；D-178 字数放到 180～260 字，最长从 6.9 秒放到 13 秒）
        frames: sec(fps, Math.min(13, Math.max(6 / BRISK, len(p.tagline, ...p.intro) / (11 * BRISK)))),
        speed: BRISK,
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
        // 背后的半透明半身像、右上的能力雷达图（D-177）
        portrait: imageOf(p.name),
        radar: analysis?.radar[p.name] ?? null,
      },
    })
  }
  scenes.push({
    label: "联赛排名",
    data: {
      kind: "standings",
      frames: sec(fps, 6),
      title: "联赛排名",
      rows: sum.standings.map((s) => ({ name: display(s.name), color: color(s.index), rank: s.rank, record: `${s.wins} 胜 ${s.draws} 平 ${s.losses} 负 · 等级分 ${s.elo}`, rate: s.rate, elo: s.elo, portrait: imageOf(s.name) })),
    },
  })
  // 全联赛之最（最快、最久、比分最接近）的标签，挑中这几局时排在看点最前面
  const tags = factTags(series, gameScores(series, seriesFile))
  picks.forEach((pick, k) => {
    const { g, replay, sides, result, title, commentary, seats } = hlData(pick)
    const hl = sum.highlights?.find((h) => h.index === pick.index)
    const reasons = [...(tags.get(g.index) ?? []), ...(hl ? hl.reasons.map(relabel) : gameReasons(replay, g.names.map(display)).map(tidy))].slice(0, 4)
    scenes.push({
      label: `精彩对局 ${k + 1} 标题卡（第 ${g.index} 局）`,
      // 标题卡要读的东西多（标题、对阵、结果、看点、解说），保持原来的速度（D-149：用户让标题卡退回原速）
      data: { kind: "hlTitle", frames: sec(fps, readSecs(len(commentary) + 0.4 * len(...reasons), 2.5, 4.5, 8)), no: k + 1, title, sides, result: `第 ${g.index} 局 · ${result} · 第 ${g.tick} tick · ${relabel(g.reason)}`, reasons, commentary },
    })
    scenes.push({ label: `精彩对局 ${k + 1} 回放`, ...replayScene(replay, k + 1, title, commentary, seats, result, fps, analysis?.weights ?? null) })
  })
  // 片尾名单按脚本里的出场顺序
  const credits = script.players.map((s) => `${s.displayName || s.name}${s.byline ? ` · ${s.byline}` : ""}`)
  scenes.push({ label: "总结、片尾署名和选手名单", data: { kind: "brandClose", frames: sec(fps, 6.5 / BRISK), speed: BRISK, outro: script.outro || null, credits: [...credits, "比赛、回放、精彩对局和这段视频都由平台自动生成"] } })
  return scenes
}

/** 单位、建筑的一句话数值（图例用）：造价、生命、攻击 */
function typeDetail(t: Replay["types"][string], spec?: TypeSpecs[string], nameOf: (type: string) => string = (x) => x): string {
  const parts: string[] = []
  const cost = Object.values(t.cost ?? {}).reduce((a: number, c) => a + (c ?? 0), 0)
  if (t.kind === "resource") return "可采集"
  if (cost) parts.push(`${cost} 金`)
  if (t.maxHp) parts.push(`${t.maxHp} 血`)
  const attack = t.attack ?? spec?.attack
  // 克制（D-166）：倍数大于 1 的写「克骑兵」，放在射程前面（图例排两栏、说明被截断时先留住它）
  const counters = Object.entries(attack?.vs ?? {}).filter(([, m]) => (m ?? 1) > 1)
  if (counters.length) parts.push(`克${counters.map(([k]) => nameOf(k)).join("、")}`)
  if (attack) parts.push(attack.range > 1 ? `射程 ${attack.range}` : "近战")
  // 能力按规则包里实际的写（歼灭的工人只采矿、不能建造）；老回放没记就看规则包，都没有就按"工人"笼统写采矿
  const gather = t.gather ?? (spec ? !!spec.gather : t.worker)
  const builds = t.builds ?? spec?.builds ?? []
  const can = [gather ? "采矿" : "", builds.length ? "建造" : ""].filter(Boolean)
  if (can.length) parts.push(can.join("、"))
  return parts.join(" · ")
}

/** 规则介绍的画面：文字 + 一局的开局地图 + 单位图例 */
function rulesScene(replay: Replay, ruleset: string, lines: string[], mapNote: string, seatColors: string[], fps: number, specs?: TypeSpecs): SceneData {
  const typeNames = Object.keys(replay.types)
  const ents: number[] = []
  for (const e of replay.initial.entities) {
    const t = replay.types[e.type]
    if (t) ents.push(e.x, e.y, t.w ?? 1, t.h ?? 1, e.owner, typeNames.indexOf(e.type))
  }
  const order = { building: 0, unit: 1, resource: 2 } as Record<string, number>
  // 最多 12 项（两栏 6 行）；放不下时先留单位和资源，建筑按定义的顺序从后往前删（科技规则包有 12 种）
  const cand = typeNames.map((k) => ({ k, t: replay.types[k] })).filter((x) => x.t.look?.label || x.t.kind === "resource")
  const keep = { unit: 0, resource: 1, building: 2 } as Record<string, number>
  const kept = new Set([...cand].sort((a, b) => (keep[a.t.kind] ?? 3) - (keep[b.t.kind] ?? 3)).slice(0, 12).map((x) => x.k))
  const legend = cand
    .filter((x) => kept.has(x.k))
    .sort((a, b) => (order[a.t.kind] ?? 3) - (order[b.t.kind] ?? 3))
    .map(({ k, t }) => ({ shape: t.look?.shape ?? "circle", label: t.look?.label ?? "", color: t.look?.color ?? null, kind: t.kind, name: typeName(replay, k), detail: typeDetail(t, specs?.[k], (x) => typeName(replay, x)) }))
  const chars = lines.reduce((a, l) => a + [...l].length, 0)
  return {
    kind: "rules",
    frames: sec(fps, readSecs(chars, 4, 6, 12)),
    ruleset,
    lines,
    mapNote,
    width: replay.map.width,
    height: replay.map.height,
    terrain: replay.map.terrain,
    colors: replay.map.colors,
    ents,
    markers: replay.initial.markers?.length ? replay.initial.markers : (replay.frames.find((f) => f.markers?.length)?.markers ?? []),
    types: typeNames.map((k) => ({ shape: replay.types[k].look?.shape ?? "circle", label: replay.types[k].look?.label ?? "", color: replay.types[k].look?.color ?? null, kind: replay.types[k].kind })),
    seatColors,
    legend,
    tickNote: `时间单位 tick：1 秒 = ${replay.tickRate} tick，一局最多 ${replay.maxTicks} tick`,
  }
}

/** 战斗前后多放几 tick：交火往往在第一个死亡之前就开始了 */
const BATTLE_LEAD = 40
const BATTLE_TAIL = 20
/** 没动静的地方一共最多放几秒（快进至少 4 倍速） */
const QUIET_SECONDS = 10
const QUIET_MIN_SPEED = 4
/** 大战按几倍速放（D-172，用户看了一倍速说太慢） */
const BATTLE_SPEED = 2
/** 其余有单位倒下的小冲突按几倍速放（D-174，用户：快进太快不知道发生了什么） */
const SKIRMISH_SPEED = 4
/** 两段交火中间只空了这么几 tick 就不快进了，免得快进一闪而过 */
const SKIRMISH_GAP = 40

/** 回放这一段怎么放：大战 2 倍速、小冲突 4 倍速、没动静快进 */
export type PaceMode = "battle" | "skirmish" | "quiet"

/**
 * 回放里的交火时段（D-172、D-174）：同一套切分里，死 BIG_BATTLE 个以上、又不是一边倒的是大战（和视频侧栏标「大战」的一样），
 * 其余有单位倒下的（哪怕只死一个、一边倒的屠杀）是小冲突。每段从第一个死亡前 BATTLE_LEAD tick 到最后一个死亡后
 * BATTLE_TAIL tick，挨着的合并；小冲突和大战重叠的部分算大战
 */
/** 回放里每个单位、建筑的死亡（不算资源和规则包移除的），和战报「战斗」一节同一套 */
function deathsOf(replay: Replay): { t: number; x: number; y: number; owner: number; fighter: boolean }[] {
  const s = new ReplayModel(replay).initialState()
  const fighter = fighterTest(replay.types)
  const deaths: { t: number; x: number; y: number; owner: number; fighter: boolean }[] = []
  for (const f of replay.frames) {
    const removed = new Set(f.removed ?? [])
    for (const id of f.die ?? []) {
      const e = s.ents.get(id)
      if (!e || removed.has(id) || replay.types[e.type]?.kind === "resource") continue
      deaths.push({ t: f.t, x: e.x, y: e.y, owner: e.owner, fighter: fighter(e.type) })
    }
    applyFrame(s, f)
  }
  return deaths
}

/**
 * 一局里最大的一仗（死得最多的那场，一边倒的屠杀排在后面）：从第一个死亡前 BATTLE_LEAD tick 开始到最后一个死亡后 BATTLE_TAIL tick。
 * 冷开场和竖屏短版用；整局没死过人返回 null
 */
export function biggestBattle(replay: Replay): [number, number] | null {
  const team = (p: number) => replay.players[p]?.team ?? p
  const groups = groupBattles(deathsOf(replay))
  if (!groups.length) return null
  const best = [...groups].sort((a, b) => Number(isRout(a, team)) - Number(isRout(b, team)) || b.length - a.length)[0]
  const T = Math.max(1, replay.result.tick)
  return [Math.max(0, best[0].t - BATTLE_LEAD), Math.min(T, best[best.length - 1].t + BATTLE_TAIL)]
}

export function fightWindows(replay: Replay): { battles: [number, number][]; skirmishes: [number, number][] } {
  const T = Math.max(1, replay.result.tick)
  const team = (p: number) => replay.players[p]?.team ?? p
  const deaths = deathsOf(replay)
  const big = (b: (typeof deaths)[number][]) => b.length >= BIG_BATTLE && !isRout(b, team)
  const merged = (bs: (typeof deaths)[number][][]) => {
    const out: [number, number][] = []
    const wins = bs.map((b): [number, number] => [Math.max(0, b[0].t - BATTLE_LEAD), Math.min(T, b[b.length - 1].t + BATTLE_TAIL)]).sort((a, b) => a[0] - b[0])
    for (const w of wins) {
      const last = out[out.length - 1]
      if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1])
      else out.push([w[0], w[1]])
    }
    return out
  }
  const groups = groupBattles(deaths)
  return { battles: merged(groups.filter(big)), skirmishes: merged(groups.filter((b) => !big(b))) }
}

/**
 * 回放每帧对应的 tick（D-171、D-172、D-174，用户定）：大战按 BATTLE_SPEED 倍速放（1 秒 = BATTLE_SPEED × 规则包的 tickRate 个 tick），
 * 其余有单位倒下的小冲突按 SKIRMISH_SPEED 倍速，没动静的时间快进，加起来最多 QUIET_SECONDS 秒、至少 QUIET_MIN_SPEED 倍速。
 * 返回一共放多少帧
 */
export function pacing(replay: Replay, fps: number): { playFrames: number; tickOf: (i: number) => number; mode: (i: number) => PaceMode } {
  const T = Math.max(1, replay.result.tick)
  const rate = Math.max(1, replay.tickRate || 10)
  const { battles, skirmishes } = fightWindows(replay)
  // 每个 tick 归哪一类：0 没动静、1 小冲突、2 大战
  const cls = new Uint8Array(T)
  for (const [x, y] of skirmishes) cls.fill(1, x, y)
  for (const [x, y] of battles) cls.fill(2, x, y)
  for (let t = 0; t < T; ) {
    let e = t
    while (e < T && cls[e] === cls[t]) e++
    if (cls[t] === 0 && t > 0 && e < T && e - t < SKIRMISH_GAP) cls.fill(1, t, e)
    t = e
  }
  const quietTicks = cls.reduce((a, c) => a + (c === 0 ? 1 : 0), 0)
  const quietSpeed = Math.max(QUIET_MIN_SPEED, quietTicks / (rate * QUIET_SECONDS))
  const MODES: PaceMode[] = ["quiet", "skirmish", "battle"]
  const SPEEDS = [quietSpeed, SKIRMISH_SPEED, BATTLE_SPEED]
  // 一段一段：从哪个 tick 到哪个 tick、每 tick 几帧、怎么放
  const segs: { t0: number; t1: number; perTick: number; mode: PaceMode; f0: number }[] = []
  let f = 0
  for (let t = 0; t < T; ) {
    let e = t
    while (e < T && cls[e] === cls[t]) e++
    const perTick = fps / (rate * SPEEDS[cls[t]])
    segs.push({ t0: t, t1: e, perTick, mode: MODES[cls[t]], f0: f })
    f += (e - t) * perTick
    t = e
  }
  const playFrames = Math.max(2, Math.round(f))
  const segAt = (i: number) => {
    let k = 0
    while (k < segs.length - 1 && segs[k + 1].f0 <= i) k++
    return segs[k]
  }
  return {
    playFrames,
    tickOf: (i) => {
      if (i >= playFrames - 1) return T
      const g = segAt(i)
      return Math.min(T, Math.max(0, Math.floor(g.t0 + (i - g.f0) / g.perTick)))
    },
    mode: (i) => segAt(Math.min(i, playFrames - 1)).mode,
  }
}

/** 回放场景：大战按 2 倍速放、小冲突 4 倍速、没动静快进（D-172、D-174），最后定格 1.5 秒显示结果 */
function replayScene(
  replay: Replay,
  no: number,
  title: string,
  commentary: string | null,
  seats: { name: string; color: string; avatar?: string | null; crop?: number[] }[],
  result: string,
  fps: number,
  weights: number[] | null = null,
  /** window：只放这一段 tick（冷开场、竖屏短版，2 倍速，不定格结果）；hook：顶上换成开场的大字（D-179） */
  clip: { window?: [number, number]; hook?: { text: string; sub: string } | null } = {},
): Omit<Scene, "label"> {
  const T = replay.result.tick
  const W0 = clip.window
  const hold = W0 ? 0 : sec(fps, 1.5)
  const typeNames = Object.keys(replay.types)
  // 主基地（每家开局都有、生命最多的建筑）：选手有形象图时画成头像（D-177）
  const baseType = baseTypeOf(replay)
  const types = typeNames.map((name) => {
    const t = replay.types[name]
    return { name, kind: t.kind, shape: t.look?.shape ?? "circle", label: t.look?.label ?? "", color: t.look?.color ?? null, worker: t.worker === true, base: name === baseType }
  })
  // 实时胜率（D-177）：两方对打、有胜率模型时，每 WIN_STEP tick 一个点；两方各取第一个座位的名字和颜色
  const sides = twoSides(replay)
  const curve = weights && sides ? winCurve(replay, weights, WIN_STEP) : null
  const win =
    curve && sides
      ? {
          step: WIN_STEP,
          ticks: T,
          curve,
          sides: sides.map((t) => {
            const p = replay.players.findIndex((pl, i) => (pl.team ?? i) === t)
            return { name: seats[p]?.name ?? `P${p}`, color: seats[p]?.color ?? "#ccc" }
          }),
        }
      : null
  const eventsAt = replayEvents(replay, seats)
  const rate = Math.max(1, replay.tickRate || 10)
  const pace = W0
    ? {
        playFrames: Math.max(2, Math.round(((W0[1] - W0[0]) * fps) / (rate * BATTLE_SPEED))),
        tickOf: (i: number) => Math.min(W0[1], W0[0] + Math.floor((i * rate * BATTLE_SPEED) / fps)),
        mode: (): PaceMode => "battle",
      }
    : pacing(replay, fps)
  const playFrames = pace.playFrames
  const model = new ReplayModel(replay)
  let state: State = model.initialState()
  const tickOf = (i: number) => (i >= playFrames ? (W0 ? W0[1] : T) : pace.tickOf(i))
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
        // 只放一段时，开头一下推过去的那些死亡不画红圈
        if (e && !removed.has(id) && replay.types[e.type]?.kind !== "resource" && (!W0 || k > W0[0])) deaths.push({ x: e.x, y: e.y, frame: i })
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
      const max = e.st?.maxHp ?? ty.maxHp
      const hp = ty.kind === "resource" || !max ? 100 : Math.max(0, Math.min(100, Math.round((100 * e.hp) / max)))
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
    return {
      t,
      ents,
      shots,
      deaths: recent,
      counts,
      events: eventsAt(t),
      progress: T ? t / T : 1,
      final: i >= playFrames,
      pace: pace.mode(Math.min(i, playFrames - 1)),
      markers: state.markers,
      status: relabelSeats(state.status, seats, false),
    }
  }
  return {
    data: {
      kind: "replay",
      frames: playFrames + hold,
      no,
      title,
      commentary,
      width: replay.map.width,
      height: replay.map.height,
      terrain: replay.map.terrain,
      colors: replay.map.colors,
      types,
      seats,
      result,
      win,
      hook: clip.hook?.text ?? null,
      hookSub: clip.hook?.sub ?? null,
    },
    frame,
  }
}

/** 规则包写的文字里的 P0、P1……换成选手名字（汉字之间的空格去掉） */
/**
 * 把规则包文字里的 P0、P1 换成选手名。句子（事件）顺便去掉中文名前后的空格；
 * 状态栏不去（规则包常用空格隔开几项，比如"台址 P0 P1 空"，去掉就粘成一串）
 */
export function relabelSeats(s: string, seats: { name: string }[], sentence = true): string {
  const out = s.replace(/(?<![A-Za-z])P(\d+)/g, (m, d) => seats[Number(d)]?.name ?? m)
  return sentence ? tidy(out) : out
}

/** 胜率曲线每隔几 tick 一个点 */
const WIN_STEP = 20

/** 侧栏里算"大战"的门槛：一场死 6 个以上 */
const BIG_BATTLE = 6

/**
 * 回放里的大事：第一次交火、失去建筑、大战、出局。返回"到第 t tick 为止该显示哪些"。
 * 大战和战报"战斗"一节是同一套切分（battles.ts，死亡算法也一样：不算资源和规则包移除的），时间和损失数对得上；
 * 一开打就显示"交战中"，损失随时间往上加，打完显示起止时间；一边倒的（兵冲进矿区杀工人这类，见 battles.ts）打完标「一边倒」
 */
function replayEvents(replay: Replay, seats: { name: string }[]): (t: number) => string[] {
  const freeUnit = (type: string) => {
    const t = replay.types[type]
    return t?.kind === "unit" && !t.worker && !Object.values(t.cost ?? {}).some((c) => (c ?? 0) > 0)
  }
  const fixed: { t: number; text: string }[] = []
  const deaths: { t: number; x: number; y: number; owner: number; fighter: boolean }[] = []
  const fighter = fighterTest(replay.types)
  const s = new ReplayModel(replay).initialState()
  const team = (p: number) => replay.players[p]?.team ?? p
  const name = (p: number) => (p >= 0 ? (seats[p]?.name ?? `P${p}`) : "中立")
  const tn = (type: string) => typeName(replay, type)
  let contact = false
  const wasAlive = s.players.map((p) => p.alive)
  for (const f of replay.frames) {
    const sh = f.shots ?? []
    for (let j = 0; j < sh.length && !contact; j += 2) {
      const a = s.ents.get(sh[j])
      const b = s.ents.get(sh[j + 1])
      // 侦察兵这类白送的单位（不花钱、不是工人）戳一下不算第一次交火（和战报一样）
      if (a && b && a.owner >= 0 && b.owner >= 0 && team(a.owner) !== team(b.owner) && !freeUnit(a.type) && !freeUnit(b.type)) {
        contact = true
        fixed.push({ t: f.t, text: `t${f.t} 第一次交火` })
      }
    }
    const removed = new Set(f.removed ?? [])
    // 规则包写的事件（夺下控制点、商队被劫……）
    for (const nt of f.notes ?? []) fixed.push({ t: f.t, text: `t${f.t} ${relabelSeats(nt.text, seats)}` })
    for (const id of f.die ?? []) {
      const e = s.ents.get(id)
      if (!e || removed.has(id)) continue
      const ty = replay.types[e.type]
      if (ty?.kind === "resource") continue
      deaths.push({ t: f.t, x: e.x, y: e.y, owner: e.owner, fighter: fighter(e.type) })
      if (ty?.kind === "building" && e.owner >= 0) fixed.push({ t: f.t, text: `t${f.t} ${name(e.owner)} 失去${tn(e.type)}${e.bp !== undefined ? "（没建好）" : ""}` })
    }
    applyFrame(s, f)
    s.players.forEach((p, i) => {
      if (wasAlive[i] && !p.alive) fixed.push({ t: f.t, text: `t${f.t} ${name(i)} 出局` })
      wasAlive[i] = p.alive
    })
  }
  // 门槛：死 6 个以上；这局最大的一仗都不到 6 个（夺点这类小规模交战）时，降到和战报一样的 3 个
  const all = groupBattles(deaths)
  const threshold = Math.max(3, Math.min(BIG_BATTLE, Math.max(0, ...all.map((b) => b.length))))
  const battles = all.filter((b) => b.length >= threshold).map((b) => Object.assign(b, { rout: isRout(b, team) }))
  return (t) => {
    const items = fixed.filter((e) => e.t <= t)
    for (const b of battles) {
      if (b[0].t > t) continue
      const t1 = b[b.length - 1].t
      const owners = [...new Set(b.map((d) => d.owner))].sort((x, y) => x - y)
      const loss = owners.map((p) => `${name(p)} 损失 ${b.filter((d) => d.owner === p && d.t <= t).length}`).join("，")
      items.push({ t: b[0].t, text: t >= t1 ? `t${b[0].t}～${t1} ${b.rout ? "一边倒" : b.length >= BIG_BATTLE ? "大战" : "交战"}：${loss}` : `t${b[0].t} 起交战中：${loss}` })
    }
    return items.sort((x, y) => x.t - y.t).map((e) => tidy(e.text))
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
      at(f + n - sec(fps, 1.5) - 1) // 最后定格之前的那一帧：终局的局面，不被"获胜"的横幅挡住
    } else at(f + Math.round(n * 0.7))
    f += n
  }
  return out
}

/**
 * 只核对脚本、不出图（video --lint）：格式错误、提醒、每个字段的字数和上限、时间表。
 * 写脚本时反复用它，字数对了再出预览图
 */
export function lintScript(seriesFile: string, script: VideoScript, fps = 30, otherRulesets: string[] = [], short = false): { errors: string[]; warnings: string[]; counts: string[]; timeline: TimelineItem[] } {
  const series = readSeries(seriesFile)
  const errors = checkScript(script, series)
  const warnings = [...scriptWarnings(script, otherRulesets), ...highlightPlayerWarnings(script, readSeries(seriesFile)), ...portraitWarnings(script)]
  const L = SCRIPT_LIMITS
  const n = (s?: string) => [...(s ?? "")].length
  const counts: string[] = []
  const row = (k: string, v: unknown, max: number) => {
    if (typeof v === "string") counts.push(`${k}：${n(v)} / ${max}${n(v) > max ? "  ← 超了" : ""}`)
  }
  row("hook.text", script.hook?.text, L.hook)
  if (Array.isArray(script.rules)) {
    script.rules.forEach((l, i) => row(`rules[${i}]`, l, L.rulesLine))
    const total = script.rules.reduce((a, l) => a + n(l), 0)
    counts.push(`rules 合计：${total} / ${RULES_PAGE_CHARS}${total > RULES_PAGE_CHARS ? "  ← 超了" : ""}`)
  }
  if (Array.isArray(script.players))
    script.players.forEach((p, i) => {
      row(`players[${i}]（${p.name}）.tagline`, p.tagline, L.tagline)
      if (Array.isArray(p.intro)) p.intro.forEach((l, j) => row(`players[${i}].intro[${j}]`, l, L.introLine))
      const total = n(p.tagline) + (Array.isArray(p.intro) ? p.intro.reduce((a, l) => a + n(l), 0) : 0)
      counts.push(`players[${i}]（${p.name}）tagline 加 intro：${total} / ${PLAYER_PAGE_CHARS}${total > PLAYER_PAGE_CHARS ? "  ← 超了" : total < PLAYER_PAGE_MIN ? `  ← 偏少（写到 180 字以上）` : ""}`)
    })
  if (Array.isArray(script.highlights))
    script.highlights.forEach((h, i) => {
      row(`highlights[${i}]（第 ${h.index} 局）.title`, h.title, L.hlTitle)
      row(`highlights[${i}]（第 ${h.index} 局）.commentary`, h.commentary, L.commentary)
    })
  row("outro", script.outro, L.outro)
  const timeline = errors.length ? [] : timelineOf(buildScenes(series, script, seriesFile, fps, undefined, null, { short }), fps)
  return { errors, warnings, counts, timeline }
}

/** 写了形象图、文件却找不到的选手（路径相对视频目录） */
function portraitWarnings(script: VideoScript): string[] {
  if (!Array.isArray(script.players)) return []
  return script.players
    .filter((p) => typeof p?.portrait === "string" && !existsSync(resolve(p.portrait)))
    .map((p) => `${p.name} 的形象图 ${p.portrait} 找不到（路径相对视频目录）：这个选手的页面不放半身像、精彩对局里的主基地照常画`)
}

export interface RenderResult {
  file: string | null
  seconds: number
  frames: number
  bytes: number
  images: string[]
  probe: { duration: number; width: number; height: number } | null
  timeline: TimelineItem[]
  /** 预览总览图（几张以上的预览才有） */
  sheet?: string
  /** 封面（开场阵容那一帧） */
  cover?: string
}

/** 删掉上一次出的预览图（或成品截图），免得越堆越多；只删这个命令自己起的文件名 */
function cleanOld(stem: string, kind: "preview" | "check"): void {
  const dir = dirname(resolve(stem))
  const base = basename(stem).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = kind === "preview" ? new RegExp(`^${base}-([\\d.]+s|总览)\\.png$`) : new RegExp(`^${base}-check-[\\d.]+s\\.png$`)
  for (const f of readdirSync(dir)) if (re.test(f)) unlinkSync(join(dir, f))
}

export async function renderLeagueVideo(o: RenderOptions): Promise<RenderResult> {
  const series = readSeries(o.seriesFile)
  const errs = checkScript(o.script, series)
  if (errs.length) throw new Error(`脚本有问题：\n- ${errs.join("\n- ")}`)
  const fps = o.fps ?? 30
  // 平台自带的规则包：读一下单位数值（老回放里没记攻击数据）
  let specs: TypeSpecs | undefined
  try {
    if (listRulesets().includes(series.ruleset.id)) {
      const r = await importRuleset(series.ruleset.id)
      specs = r.types as TypeSpecs
      series.ruleset.summary ??= r.summary
    }
  } catch {
    specs = undefined
  }
  // 雷达图、胜率模型要读完全部回放（第一次几十秒，之后用缓存）
  const analysis = analyzeLeague(series, o.seriesFile)
  const scenes = buildScenes(series, o.script, o.seriesFile, fps, specs, analysis, { short: o.short })
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
    const width = o.width ?? (o.short ? 1080 : 1920)
    const height = o.height ?? (o.short ? 1920 : 1080)
    await browser.evaluate(`__size(${width}, ${height})`)
    // 选手的形象图（按联赛名字）：选手页的半身像、精彩对局里的头像都从它来
    for (const p of o.script.players) {
      if (!p.portrait || !existsSync(resolve(p.portrait))) continue
      const b64 = readFileSync(resolve(p.portrait)).toString("base64")
      await browser.evaluate(`__image(${JSON.stringify(p.name)}, ${JSON.stringify(b64)}, ${JSON.stringify(p.avatar?.length === 3 ? p.avatar : DEFAULT_AVATAR)})`)
    }
    const ok = await browser.evaluate<boolean>(`typeof VideoEncoder === "function"`)
    if (!ok) throw new Error("这个浏览器不支持 WebCodecs（VideoEncoder），换一个新一点的 Chrome / Edge")
    // 场景的起始帧
    const starts: number[] = []
    scenes.reduce((a, s) => (starts.push(a), a + s.data.frames), 0)
    const preview = o.preview === "auto" ? autoPreview(scenes, fps) : o.preview
    const check = o.check === "auto" ? autoPreview(scenes, fps) : (o.check ?? [])
    // 预览图、检查截图放进 preview/ 子目录，不和视频目录里的说明、代码混在一起
    const pstem = join(o.imagesDir ?? join(dirname(stem), "preview"), basename(stem))
    if (preview?.length) {
      mkdirSync(dirname(pstem), { recursive: true })
      cleanOld(pstem, "preview")
      const withSheet = preview.length > 1
      if (withSheet) await browser.evaluate(`__sheetBegin(${preview.length}, 4)`)
      for (const [n, t] of preview.entries()) {
        const f = Math.max(0, Math.min(total - 1, Math.round(t * fps)))
        const k = starts.findLastIndex((st) => st <= f)
        const sc = scenes[k]
        await browser.evaluate(`__scene(${JSON.stringify(sc.data)})`)
        const local = f - starts[k]
        // 回放场景要从头推到这一帧（刚死的红圈要知道是哪一帧死的）
        let rf: ReplayFrame | null = null
        if (sc.frame) for (let i = 0; i <= local; i++) rf = sc.frame(i)
        const png = await browser.evaluate<string>(`__png(${local}, ${JSON.stringify(rf)})`)
        const file = `${pstem}-${t}s.png`
        writeFileSync(file, Buffer.from(png, "base64"))
        images.push(file)
        if (withSheet) await browser.evaluate(`__sheetAdd(${n}, ${JSON.stringify(`${t} 秒 · ${sc.label}`)})`)
      }
      let sheet: string | undefined
      if (withSheet) {
        sheet = `${pstem}-总览.png`
        writeFileSync(sheet, Buffer.from(await browser.evaluate<string>("__sheetPng()"), "base64"))
      }
      return { file: null, seconds: total / fps, frames: total, bytes: 0, images, probe: null, timeline, sheet }
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
    const probe = await browser.evaluate<{ duration: number; width: number; height: number; shots: string[] }>(`__probe(${JSON.stringify(check)})`)
    if (check.length) mkdirSync(dirname(pstem), { recursive: true })
    cleanOld(pstem, "check")
    probe.shots.forEach((b64, k) => {
      const file = `${pstem}-check-${check[k]}s.png`
      writeFileSync(file, Buffer.from(b64, "base64"))
      images.push(file)
    })
    // 封面（D-179）：开场阵容那一帧（立绘、大字），直接拿去当视频封面
    let cover: string | undefined
    const lineupScene = scenes.find((x) => x.data.kind === "lineup")
    if (lineupScene) {
      await browser.evaluate(`__scene(${JSON.stringify(lineupScene.data)})`)
      cover = `${stem}-封面.png`
      writeFileSync(cover, Buffer.from(await browser.evaluate<string>(`__png(${lineupScene.data.frames - 1}, null)`), "base64"))
    }
    return { file: o.out, seconds: total / fps, frames: total, bytes: bytes.length, images, probe: { duration: probe.duration, width: probe.width, height: probe.height }, timeline, cover }
  } finally {
    await browser.close()
  }
}
