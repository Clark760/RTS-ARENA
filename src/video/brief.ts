// 联赛视频的"素材包"和"脚本"：
// - 素材包（video-brief）：给大模型看的材料——联赛成绩、每个选手的文件名和代码风格的客观指标、精彩对局，外加一份待填的脚本模板
// - 脚本（video --script）：大模型写的 JSON——视频标题、用户的原话、对原话的解读、每个选手的介绍、精彩对局的解说
// 平台署名（片头、片尾）由渲染器固定加上，脚本去不掉
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { finalScores } from "../cli/highlights.ts"
import type { Replay } from "../core/types.ts"
import { PKG_ROOT } from "../paths.ts"

/** 联赛汇总文件（*.series.json）里视频要用到的部分 */
export interface SeriesFile {
  format: string
  kind?: string
  /** summary 是规则包的一句话简介、dir 是规则包目录（D-145 起记下，视频的规则介绍用） */
  ruleset: { id: string; name: string; summary?: string; dir?: string }
  startedAt: string
  games: number
  /** 跑的时候加了 --no-replays 就是 false（D-175 起记），这种联赛做不了视频 */
  replays?: boolean
  size?: number
  teams?: string | null
  participants: { name: string; file: string }[]
  results: { index: number; seed: number; seats: number[]; names: string[]; teams: number[]; winners: number[]; reason: string; tick: number; replay: string; scores?: number[] }[]
  summary: null | {
    standings: { index: number; name: string; rank: number; games: number; wins: number; draws: number; losses: number; rate: number; rateCi?: number; elo: number }[]
    matrix: { w: number; d: number; l: number }[][]
    stats?: { bots: { name: string; games: number; income: number; produced: number; lostUnits: number; lostWorkers?: number; killedUnits: number; killedBuildings: number; ticks: number; winTicks: number; winGames: number; errors: number; fuelOuts: number; rejected: number; calls: number; fuel: number }[] }
    highlights?: { index: number; seed: number; replay: string; who: string; winner: string | null; tick: number; score: number; reasons: string[] }[]
  }
}

/** 一个 bot 文件的代码风格指标（只是事实，怎么解读交给写脚本的大模型） */
export interface CodeFacts {
  lines: number
  codeLines: number
  commentLines: number
  /** 注释行占非空行的比例 */
  commentRatio: number
  /** 注释里汉字占字母和汉字的比例 */
  chineseInComments: number
  /** 文件开头的注释（最多 15 行） */
  header: string[]
  functions: number
  interfacesAndTypes: number
  /** 顶层的 let（跨回合记状态的变量） */
  topLevelState: number
  /** 顶层的常量参数（大写名字 = 字面值），最多 12 个 */
  constants: string[]
  /** 一些写法特征出现的次数 */
  features: Record<string, number>
}

export function codeFacts(src: string): CodeFacts {
  const lines = src.replace(/\r\n/g, "\n").split("\n")
  const nonBlank = lines.filter((l) => l.trim() !== "")
  let inBlock = false
  let commentLines = 0
  const commentText: string[] = []
  for (const l of nonBlank) {
    const t = l.trim()
    if (inBlock) {
      commentLines++
      commentText.push(t)
      if (t.includes("*/")) inBlock = false
    } else if (t.startsWith("//")) {
      commentLines++
      commentText.push(t)
    } else if (t.startsWith("/*")) {
      commentLines++
      commentText.push(t)
      inBlock = !t.includes("*/")
    } else {
      const i = t.indexOf("//")
      if (i > 0) commentText.push(t.slice(i))
    }
  }
  const header: string[] = []
  for (const l of lines) {
    const t = l.trim()
    if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) header.push(t.replace(/^\/\/\s?|^\/\*+\s?|^\*\/?\s?/, ""))
    else if (t === "" && header.length > 0) break
    else if (t !== "") break
    if (header.length >= 15) break
  }
  const comments = commentText.join("\n")
  const cjk = (comments.match(/[一-鿿]/g) ?? []).length
  const latin = (comments.match(/[A-Za-z]/g) ?? []).length
  const count = (re: RegExp) => (src.match(re) ?? []).length
  const constants = [...src.matchAll(/^const ([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=\s*([^\n;]{1,40})/gm)].slice(0, 12).map((m) => `${m[1]} = ${m[2].trim()}`)
  return {
    lines: lines.length,
    codeLines: nonBlank.length - commentLines,
    commentLines,
    commentRatio: nonBlank.length ? Number((commentLines / nonBlank.length).toFixed(2)) : 0,
    chineseInComments: cjk + latin ? Number((cjk / (cjk + latin)).toFixed(2)) : 0,
    header,
    functions: count(/\bfunction\s+\w+/g) + count(/\b(?:const|let)\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>/g),
    interfacesAndTypes: count(/^\s*(?:export\s+)?(?:interface|type)\s+\w+/gm),
    topLevelState: count(/^let\s+\w+/gm),
    constants,
    features: {
      "cmd.attackMove": count(/cmd\.attackMove\(/g),
      "cmd.attack": count(/cmd\.attack\(/g),
      "cmd.build": count(/cmd\.build\(/g),
      "console.log": count(/console\.log\(/g),
      类型化数组: count(/\b(?:Int8|Uint8|Int16|Uint16|Int32|Uint32|Float32|Float64)Array\b/g),
      自己寻路: count(/\b(?:bfs|BFS|astar|aStar|A\*|dijkstra|flowField|queue\.shift|path)\b/g),
      状态机模式: count(/\bmode\s*[=:]/g),
      实测或调参注释: count(/实测|调参|调出来|回放数据/g),
      注释里的感叹号: (comments.match(/[！!]/g) ?? []).length,
      注释里的中英对照标题: (comments.match(/[一-鿿]{2,}（[A-Za-z][^）]*）/g) ?? []).length,
      版本号: count(/\bv\d+(?:\.\d+)*\b|VERSION/g),
    },
  }
}

/** 素材包 */
export interface VideoBrief {
  ruleset: { id: string; name: string }
  league: { games: number; startedAt: string; size: number; teams: string | null; seriesFile: string }
  players: {
    name: string
    file: string
    fileName: string
    /** 文件名按 "-" 拆开的几段（常见写法是 "模型名-编程工具"，只是提示，怎么理解由写脚本的大模型判断） */
    fileNameParts: string[]
    standing: { rank: number; rate: number; wins: number; draws: number; losses: number; elo: number } | null
    /** 对其他每个选手的 胜-平-负 */
    headToHead: Record<string, string>
    /** 每局平均：采集、造单位、损失、击杀 */
    perGame: Record<string, number> | null
    trouble: { errors: number; fuelOuts: number; rejected: number }
    code: CodeFacts | null
  }[]
  highlights: NonNullable<SeriesFile["summary"]>["highlights"]
  /** 待填的脚本（把 "待填" 都换掉，写好后用 rts-arena video <汇总> --script <脚本> 渲染） */
  scriptTemplate: VideoScript
  rules: string[]
}

export interface VideoScript {
  /** 规则介绍：写给没玩过的观众，1～4 句、每句最多 45 字（不写就用规则包的一句话简介） */
  rules?: string[]
  /** 每个选手：name 要和联赛里的名字一样 */
  players: {
    name: string
    /** 显示的名字（最多 28 字），比如 "ModelX 2.0" 或者用户给的外号 */
    displayName?: string
    /** 一行小字（最多 40 字），比如编程工具 "ToolY"，显示名用了外号时可以写 "<模型名> · <编程工具>"；也会出现在片尾的选手名单里；不知道就不写 */
    byline?: string
    /** 一句话定位（最多 30 字） */
    tagline: string
    /** 介绍，1～5 句（建议 4～5 句），每句最多 65 字 */
    intro: string[]
    /** 选手形象图（PNG / JPG，相对视频目录）：选手页背后放半透明的半身像，精彩对局里主基地换成从它裁的头像（D-177） */
    portrait?: string
    /** 头像从形象图哪里裁：[脸中心 x, 脸中心 y, 边长]，都按图的宽度算比例（y 按高度）；不写是 [0.49, 0.115, 0.32]（图上部居中） */
    avatar?: number[]
  }[]
  /** 精彩对局的解说；不写就用联赛挑的精彩对局、不加解说 */
  highlights?: { index: number; title?: string; commentary?: string }[]
  /** 片尾署名页最上面的一句总结（最多 60 字，可以不写） */
  outro?: string
}

/**
 * 选手页的文字量：4～5 句、180～260 字（D-178，用户：字可以加多一点、字号小一点；原来是 D-152 的 3～4 句、120～170 字）。
 * tagline 加 intro 超过上限、少于下限都提醒
 */
export const PLAYER_PAGE_CHARS = 260
export const PLAYER_PAGE_MIN = 160

/** 规则页最长 12 秒，大约读得完 130 字 */
export const RULES_PAGE_CHARS = 130

export const SCRIPT_LIMITS = { rulesLine: 45, rulesLines: 4, displayName: 28, byline: 40, tagline: 30, introLine: 65, introLines: 5, hlTitle: 24, commentary: 80, outro: 60, highlights: 10 }

/** 检查脚本，返回所有问题（空数组是没问题） */
export function checkScript(s: unknown, series: SeriesFile): string[] {
  const errs: string[] = []
  const L = SCRIPT_LIMITS
  if (s === null || typeof s !== "object" || Array.isArray(s)) return ["脚本要是一个 JSON 对象"]
  const o = s as Record<string, unknown>
  const str = (v: unknown, name: string, max: number, required = false) => {
    if (v === undefined && !required) return
    if (typeof v !== "string" || (required && v.trim() === "")) errs.push(`${name} 要是字符串${required ? "（不能为空）" : ""}`)
    else if (v.includes("待填")) errs.push(`${name} 还是"待填"${required ? "" : "（不要的话整个字段删掉）"}`)
    else if ([...v].length > max) errs.push(`${name} 最多 ${max} 字（现在 ${[...v].length} 字，标点和空格也算）：${v.slice(0, 20)}…`)
  }
  str(o.outro, "outro", L.outro)
  if (o.rules !== undefined) {
    if (!Array.isArray(o.rules) || o.rules.length < 1 || o.rules.length > L.rulesLines) errs.push(`rules 要是 1～${L.rulesLines} 句的数组`)
    else o.rules.forEach((line, j) => str(line, `rules[${j}]`, L.rulesLine, true))
  }
  const names = series.participants.map((p) => p.name)
  if (!Array.isArray(o.players)) errs.push("players 要是数组，每个选手一项")
  else {
    const seen = new Set<string>()
    for (const [i, p] of (o.players as Record<string, unknown>[]).entries()) {
      const where = `players[${i}]`
      if (!p || typeof p !== "object") {
        errs.push(`${where} 要是对象`)
        continue
      }
      if (typeof p.name !== "string" || !names.includes(p.name)) errs.push(`${where}.name 要是联赛里的名字之一：${names.join("、")}`)
      else seen.add(p.name)
      str(p.displayName, `${where}.displayName`, L.displayName)
      str(p.byline, `${where}.byline`, L.byline)
      str(p.tagline, `${where}.tagline`, L.tagline, true)
      if (!Array.isArray(p.intro) || p.intro.length < 1 || p.intro.length > L.introLines) errs.push(`${where}.intro 要是 1～${L.introLines} 句的数组`)
      else p.intro.forEach((line, j) => str(line, `${where}.intro[${j}]`, L.introLine, true))
      if (p.portrait !== undefined && (typeof p.portrait !== "string" || !p.portrait.trim())) errs.push(`${where}.portrait 要是图片文件的路径`)
      if (p.avatar !== undefined && !(Array.isArray(p.avatar) && p.avatar.length === 3 && p.avatar.every((v) => typeof v === "number" && v >= 0 && v <= 1)))
        errs.push(`${where}.avatar 要写成 [脸中心 x, 脸中心 y, 边长] 三个 0～1 的数（按图的宽、高算比例）`)
    }
    for (const n of names) if (!seen.has(n)) errs.push(`players 里少了选手 ${n}`)
  }
  if (o.highlights !== undefined) {
    if (!Array.isArray(o.highlights) || o.highlights.length > L.highlights) errs.push(`highlights 要是最多 ${L.highlights} 项的数组`)
    else
      for (const [i, h] of (o.highlights as Record<string, unknown>[]).entries()) {
        if (!h || typeof h !== "object" || !series.results.some((r) => r.index === h.index)) errs.push(`highlights[${i}].index 要是联赛里的局号（1～${series.results.length}）`)
        str(h?.title, `highlights[${i}].title`, L.hlTitle)
        str(h?.commentary, `highlights[${i}].commentary`, L.commentary)
      }
  }
  return errs
}

/**
 * 不影响出视频、但最好改的地方：粗体字段（title、tagline、精彩对局的 title 和 commentary、outro）里的"一"，粗体下就是一道横线，像破折号。
 * 规则介绍里提到别的规则包（otherRulesets 是别的规则包的名字）：观众不一定玩过那个规则包（D-155）。
 * 脚本格式不对时返回空（格式问题交给 checkScript）
 */
/**
 * 精彩对局的标题、解说提到了不在这局的选手（D-171：烽火台视频有一局标题写成「哈基米没输给 GPT 的那局」，那局其实是大肥鱼对哈基米，
 * 标题是从别的视频的脚本里留下来的）。按联赛名字和脚本里的显示名找；提到的名字同时也是这局某个选手名字的一部分时不算
 */
export function highlightPlayerWarnings(s: unknown, series: SeriesFile): string[] {
  if (!s || typeof s !== "object") return []
  const o = s as VideoScript
  if (!Array.isArray(o.highlights)) return []
  const shown = new Map<string, string[]>()
  for (const p of series.participants) {
    const sp = Array.isArray(o.players) ? o.players.find((x) => x?.name === p.name) : undefined
    // 全名、显示名，再加常用的简称：显示名的第一个词（「GPT 6.1 sol」→ GPT）、名字开头连续的大写字母（GPTbot → GPT）
    const short = [sp?.displayName?.trim().split(/\s+/)[0], /^[A-Z]{2,}/.exec(p.name)?.[0], /^[A-Z]{2,}/.exec(sp?.displayName ?? "")?.[0]]
    shown.set(p.name, [...new Set([p.name, sp?.displayName, ...short])].filter((x): x is string => typeof x === "string" && x.trim().length >= 2))
  }
  const out: string[] = []
  o.highlights.forEach((h, i) => {
    const g = series.results.find((r) => r.index === h?.index)
    if (!g) return
    const inGame = [...new Set(g.names)].flatMap((n) => shown.get(n) ?? [n])
    for (const [field, text] of [["title", h.title], ["commentary", h.commentary]] as const) {
      if (typeof text !== "string") continue
      for (const p of series.participants) {
        if (g.names.includes(p.name)) continue
        const hit = (shown.get(p.name) ?? []).find((x) => text.includes(x) && !inGame.some((y) => y.includes(x)))
        if (hit)
          out.push(
            `highlights[${i}].${field} 提到了「${hit}」，可第 ${g.index} 局是 ${[...new Set(g.names)].map((n) => shown.get(n)?.[1] ?? n).join(" 对 ")}，没有它：每局的标题和解说要照这一局写（别从别的视频的脚本里抄）`,
          )
      }
    }
  })
  return out
}

export function scriptWarnings(s: unknown, otherRulesets: string[] = []): string[] {
  if (!s || typeof s !== "object") return []
  const o = s as VideoScript
  const bold: [string, unknown][] = [["outro", o.outro]]
  if (Array.isArray(o.players)) o.players.forEach((p, i) => bold.push([`players[${i}].tagline`, p?.tagline]))
  if (Array.isArray(o.highlights))
    o.highlights.forEach((h, i) => {
      bold.push([`highlights[${i}].title`, h?.title])
      bold.push([`highlights[${i}].commentary`, h?.commentary])
    })
  const out = bold
    .filter((x): x is [string, string] => typeof x[1] === "string" && x[1].includes("一"))
    .map(([where, v]) => `${where} 是粗体，里面的"一"看起来像破折号："${v}"——数量写成阿拉伯数字，或者换个说法`)
  // 不再有标题页、不再展示用户的话（D-177）：老脚本里的这几个字段用不上了
  const gone = (["title", "userText", "theme"] as const).filter((k) => (o as unknown as Record<string, unknown>)[k] !== undefined)
  if (gone.length) out.push(`${gone.join("、")} 不再使用（视频没有标题页了，片头之后直接是规则介绍），删掉就行`)
  // 规则页最长 12 秒
  if (Array.isArray(o.rules)) {
    const n = o.rules.reduce((a: number, x) => a + (typeof x === "string" ? [...x].length : 0), 0)
    if (n > RULES_PAGE_CHARS) out.push(`rules 共 ${n} 字，规则页最长 12 秒，大约只读得完 ${RULES_PAGE_CHARS} 字：删一句或者写短些`)
    o.rules.forEach((x, i) => {
      const hit = typeof x === "string" ? otherRulesets.filter((name) => name && x.includes(name)) : []
      if (hit.length)
        out.push(
          `rules[${i}] 提到了别的规则包「${hit.join("、")}」：观众不一定玩过它，别写"和${hit[0]}一样""在${hit[0]}的基础上"，把要用到的规则直接简要讲出来（只是普通用词的话可以不管）`,
        )
    })
  }
  // 选手页：tagline 加 intro 太长读不完，太少页面显得空
  if (Array.isArray(o.players))
    o.players.forEach((p, i) => {
      const n = [p?.tagline, ...(Array.isArray(p?.intro) ? p.intro : [])].reduce((a: number, x) => a + (typeof x === "string" ? [...x].length : 0), 0)
      if (n > PLAYER_PAGE_CHARS) out.push(`players[${i}]（${p?.name}）的 tagline 加 intro 共 ${n} 字，选手页最长 13 秒，大约只读得完 ${PLAYER_PAGE_CHARS} 字：删一句或者写短些`)
      else if (n < PLAYER_PAGE_MIN) out.push(`players[${i}]（${p?.name}）的 tagline 加 intro 只有 ${n} 字，选手页显得空：写到 4～5 句、180～${PLAYER_PAGE_CHARS} 字（对照代码、参赛报告和战绩再写几句）`)
    })
  return out
}

/** 每局的最终比分：联赛汇总里记了就用（D-144 起），没记就读回放算 */
export function gameScores(series: SeriesFile, seriesFile: string): Map<number, number[]> {
  const out = new Map<number, number[]>()
  for (const r of series.results) {
    if (r.scores) {
      out.set(r.index, r.scores)
      continue
    }
    const f = join(dirname(resolve(seriesFile)), r.replay)
    if (existsSync(f)) out.set(r.index, finalScores(JSON.parse(readFileSync(f, "utf8")) as Replay))
  }
  return out
}

/**
 * 联赛速查里的几条"全联赛之最"，挑中这几局时显示在标题卡上，排在看点最前面
 * （写脚本的人在 PROMPT.md 的全部对局表里也看得到）：结束得最快的胜局、打得最久的、比分最接近的胜局
 */
export function factTags(series: SeriesFile, scores: Map<number, number[]>): Map<number, string[]> {
  const tags = new Map<number, string[]>()
  const add = (i: number, t: string) => tags.set(i, [...(tags.get(i) ?? []), t])
  const decided = series.results.filter((r) => r.winners.length > 0)
  const fast = [...decided].sort((a, b) => a.tick - b.tick || a.index - b.index)[0]
  if (fast) add(fast.index, `全联赛结束得最快的胜局（${fast.tick} tick）`)
  const slow = [...series.results].sort((a, b) => b.tick - a.tick || a.index - b.index)[0]
  if (slow && slow !== fast) add(slow.index, `全联赛打得最久的局（${slow.tick} tick）`)
  let best: { index: number; gap: number } | null = null
  for (const r of decided) {
    const sc = scores.get(r.index)
    if (!sc || sc.every((v) => v === 0)) continue
    const ws = Math.max(...r.winners.map((p) => sc[p]))
    const ls = Math.max(...sc.filter((_, p) => !r.winners.includes(p)))
    if (ws - ls >= 0 && (!best || ws - ls < best.gap)) best = { index: r.index, gap: ws - ls }
  }
  if (best) add(best.index, `全联赛比分最接近的胜局（只差 ${best.gap} 分）`)
  return tags
}

export function readSeries(file: string): SeriesFile {
  const s = JSON.parse(readFileSync(file, "utf8")) as SeriesFile
  if (s.format !== "rts-arena-series" || s.kind !== "league") throw new Error(`${file} 不是联赛的汇总文件（*.series.json，kind 是 league）`)
  if (!s.summary) throw new Error(`${file} 的联赛还没打完（没有 summary）`)
  if (s.replays === false) throw new Error(`${file} 的联赛没存回放（跑的时候加了 --no-replays），做不了视频：去掉 --no-replays 再跑一次`)
  return s
}

/**
 * 汇总里记的 bot 文件是相对跑联赛时的目录：先按当前目录找，再按汇总文件所在目录的上一层、平台目录（自带的参考 bot）找，
 * 都没有就用当前目录 bots/ 里的同名文件（在 video-init 建的视频目录里渲染时，那里有选手代码的副本）
 */
export function resolveBotFile(file: string, seriesFile: string): string | null {
  for (const base of [process.cwd(), dirname(dirname(resolve(seriesFile))), dirname(resolve(seriesFile)), PKG_ROOT]) {
    const p = resolve(base, file)
    if (existsSync(p)) return p
  }
  const copy = resolve("bots", basename(file.split("\\").join("/")))
  return existsSync(copy) ? copy : null
}

export function videoBrief(seriesFile: string): VideoBrief {
  const s = readSeries(seriesFile)
  const sum = s.summary!
  const players = s.participants.map((p, i) => {
    const st = sum.standings.find((x) => x.index === i) ?? null
    const b = sum.stats?.bots[i]
    const file = resolveBotFile(p.file, seriesFile)
    const fileName = basename(p.file)
    const h2h: Record<string, string> = {}
    s.participants.forEach((q, j) => {
      if (j === i) return
      const c = sum.matrix[i]?.[j]
      if (c) h2h[q.name] = `${c.w}-${c.d}-${c.l}`
    })
    const avg = (x: number) => (b && b.games ? Number((x / b.games).toFixed(1)) : 0)
    return {
      name: p.name,
      file: file ?? p.file,
      fileName,
      fileNameParts: fileName.replace(/\.ts$/, "").split("-"),
      standing: st && { rank: st.rank, rate: st.rate, wins: st.wins, draws: st.draws, losses: st.losses, elo: st.elo },
      headToHead: h2h,
      perGame: b ? { 采集: avg(b.income), 造单位: avg(b.produced), 损失单位: avg(b.lostUnits), 损失工人: avg(b.lostWorkers ?? 0), 击杀单位: avg(b.killedUnits), 拆建筑: avg(b.killedBuildings), 每局时长: avg(b.ticks) } : null,
      trouble: { errors: b?.errors ?? 0, fuelOuts: b?.fuelOuts ?? 0, rejected: b?.rejected ?? 0 },
      code: file ? codeFacts(readFileSync(file, "utf8")) : null,
    }
  })
  const scriptTemplate: VideoScript = {
    rules: ["待填：怎么赢（照 RULES.md 写给没玩过的观众）", "待填：最关键的机制或特别的单位"],
    players: players.map((p) => ({ name: p.name, displayName: "待填", byline: "待填", tagline: "待填", intro: ["待填", "待填"] })),
    highlights: (sum.highlights ?? []).slice(0, 3).map((h) => ({ index: h.index, title: "待填（可删）", commentary: "待填（可删）" })),
    outro: "待填：一句话总结",
  }
  return {
    ruleset: s.ruleset,
    league: { games: s.games, startedAt: s.startedAt, size: s.size ?? 2, teams: s.teams ?? null, seriesFile: resolve(seriesFile) },
    players,
    highlights: sum.highlights ?? [],
    scriptTemplate,
    rules: [
      "介绍要有依据：文件名、代码（开头的注释、写法特征、参数）和联赛成绩里看得到的才写，不编造没发生的事",
      "文件名常见的写法是 \"模型名-编程工具\"，比如 \"ModelX2.0-ToolY\" 是 ToolY 里的 ModelX 2.0（只是格式的例子）；拆不开、只是外号时就照原样用，不要猜是哪家模型；不知道作者就不写 byline",
      "语气轻松、像赛事解说，但不贬低任何一方；成绩差的写它的特点和输在哪",
      "每个选手 1～5 句介绍（建议 4～5 句，tagline 加 intro 一共 180～260 字），每句不超过 65 字；tagline 不超过 30 字；byline 会出现在片尾的选手名单里",
      "精彩对局最多 10 局（用户说了要几局就挑几局），每局的标题和解说照这一局写，解说一句话（不超过 80 字），别重复标题卡上自动列出的看点（highlights 里的 reasons）；index 用联赛的局号",
      "平台署名（片头、片尾的 RTS Arena）由渲染器固定加上，不用写进脚本，也去不掉",
    ],
  }
}
