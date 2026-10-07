// 联赛视频的"素材包"和"脚本"：
// - 素材包（video-brief）：给大模型看的材料——联赛成绩、每个选手的文件名和代码风格的客观指标、精彩对局，外加一份待填的脚本模板
// - 脚本（video --script）：大模型写的 JSON——视频标题、用户的原话、对原话的解读、每个选手的介绍、精彩对局的解说
// 平台署名（片头、片尾）由渲染器固定加上，脚本去不掉
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

/** 联赛汇总文件（*.series.json）里视频要用到的部分 */
export interface SeriesFile {
  format: string
  kind?: string
  ruleset: { id: string; name: string }
  startedAt: string
  games: number
  size?: number
  teams?: string | null
  participants: { name: string; file: string }[]
  results: { index: number; seed: number; seats: number[]; names: string[]; teams: number[]; winners: number[]; reason: string; tick: number; replay: string }[]
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
  /** 视频标题（最多 24 字），不写就是 "<规则包> 联赛" */
  title?: string
  /** 用户的原话（开场原样展示，最多 120 字） */
  userText?: string
  /** 对用户原话的解读、整场联赛的一句话导语（最多 60 字） */
  theme?: string
  /** 每个选手：name 要和联赛里的名字一样 */
  players: {
    name: string
    /** 显示的名字（最多 28 字），比如 "Gemini 3.8 flash High" */
    displayName?: string
    /** 一行小字（最多 30 字），比如 "反重力"；也会出现在片尾的选手名单里 */
    byline?: string
    /** 一句话定位（最多 30 字） */
    tagline: string
    /** 介绍，1～4 句（建议 2～4 句），每句最多 50 字 */
    intro: string[]
  }[]
  /** 精彩对局的解说；不写就用联赛挑的精彩对局、不加解说 */
  highlights?: { index: number; title?: string; commentary?: string }[]
  /** 片尾署名页最上面的一句总结（最多 60 字，可以不写） */
  outro?: string
}

export const SCRIPT_LIMITS = { title: 24, userText: 120, theme: 60, displayName: 28, byline: 30, tagline: 30, introLine: 50, introLines: 4, hlTitle: 24, commentary: 80, outro: 60, highlights: 5 }

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
  str(o.title, "title", L.title)
  str(o.userText, "userText", L.userText)
  str(o.theme, "theme", L.theme)
  str(o.outro, "outro", L.outro)
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

export function readSeries(file: string): SeriesFile {
  const s = JSON.parse(readFileSync(file, "utf8")) as SeriesFile
  if (s.format !== "rts-arena-series" || s.kind !== "league") throw new Error(`${file} 不是联赛的汇总文件（*.series.json，kind 是 league）`)
  if (!s.summary) throw new Error(`${file} 的联赛还没打完（没有 summary）`)
  return s
}

/** 汇总里记的 bot 文件是相对跑联赛时的目录：先按当前目录找，再按汇总文件所在目录的上一层找 */
export function resolveBotFile(file: string, seriesFile: string): string | null {
  for (const base of [process.cwd(), dirname(dirname(resolve(seriesFile))), dirname(resolve(seriesFile))]) {
    const p = resolve(base, file)
    if (existsSync(p)) return p
  }
  return null
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
    title: `待填：视频标题（上面已经有一行「${s.ruleset.name}联赛」，不用重复）`,
    userText: "待填：用户的原话",
    theme: "待填：对原话的解读、整场联赛的一句话导语",
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
      "介绍要有依据：用户的原话、文件名、代码（开头的注释、写法特征、参数）和联赛成绩里看得到的才写，不编造没发生的事",
      "文件名常见的写法是 \"模型名-编程工具\"，比如 \"GPT6.1sol-codex\" 是 codex 里的 GPT 6.1 sol；拆不开就照原样用",
      "语气跟着用户的原话走（调侃就调侃，正式就正式），但不贬低任何一方；成绩差的写它的特点和输在哪",
      "每个选手 1～4 句介绍（建议 2～4 句），每句不超过 50 字；tagline 不超过 30 字；byline 会出现在片尾的选手名单里",
      "精彩对局最多 5 局，解说一句话（不超过 80 字），别重复标题卡上自动列出的看点（highlights 里的 reasons）；index 用联赛的局号",
      "平台署名（片头、片尾的 RTS Arena）由渲染器固定加上，不用写进脚本，也去不掉",
    ],
  }
}
