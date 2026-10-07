// rts-arena video-init：把一场联赛做视频要用的东西导出到一个目录（像 init 建 bot 目录那样）——
// 给大模型的说明 PROMPT.md、联赛数据、选手 bot 文件的副本、几局的战报、待填的脚本。
// 大模型只读这个目录里的文件、写好 script.json，在目录里运行 rts-arena video 就能出预览和视频
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { buildReport } from "../cli/report.ts"
import type { Replay } from "../core/types.ts"
import { readSeries, SCRIPT_LIMITS, videoBrief, type VideoBrief, type VideoScript } from "./brief.ts"

export const VIDEO_CONFIG = "arena-video.json"

/** 视频目录里记的东西：联赛汇总在哪（相对这个目录）、视频输出成什么文件 */
export interface VideoConfig {
  series: string
  out: string
}

export function readVideoConfig(dir: string): VideoConfig | null {
  const f = join(dir, VIDEO_CONFIG)
  if (!existsSync(f)) return null
  return JSON.parse(readFileSync(f, "utf8")) as VideoConfig
}

/** 要附战报的几局：联赛挑的精彩对局、每个选手赢得最快的一局、最长的一局（最多 12 局） */
function reportGames(brief: VideoBrief, series: ReturnType<typeof readSeries>): number[] {
  const picks = new Set<number>((brief.highlights ?? []).map((h) => h.index))
  for (const p of series.participants) {
    const mine = series.results.filter((r) => r.names.includes(p.name))
    const wins = mine.filter((r) => r.winners.some((w) => r.names[w] === p.name)).sort((a, b) => a.tick - b.tick)
    if (wins[0]) picks.add(wins[0].index)
  }
  const longest = [...series.results].sort((a, b) => b.tick - a.tick)[0]
  if (longest) picks.add(longest.index)
  return [...picks].sort((a, b) => a - b).slice(0, 12)
}

export function createVideoWorkspace(seriesFile: string, dir: string, userText?: string): { dir: string; files: string[] } {
  const series = readSeries(seriesFile)
  const brief = videoBrief(seriesFile)
  mkdirSync(join(dir, "bots"), { recursive: true })
  mkdirSync(join(dir, "reports"), { recursive: true })
  const files: string[] = []
  const write = (rel: string, content: string) => {
    writeFileSync(join(dir, rel), content)
    files.push(rel)
  }
  // 选手 bot 的副本（文件名不变）
  const botFile = new Map<string, string>()
  for (const p of brief.players) {
    if (!existsSync(p.file)) continue
    const rel = join("bots", p.fileName).split("\\").join("/")
    copyFileSync(p.file, join(dir, rel))
    botFile.set(p.name, rel)
    files.push(rel)
  }
  // 几局的战报
  const reported: number[] = []
  for (const index of reportGames(brief, series)) {
    const g = series.results.find((r) => r.index === index)!
    const replayFile = join(dirname(resolve(seriesFile)), g.replay)
    if (!existsSync(replayFile)) continue
    const replay = JSON.parse(readFileSync(replayFile, "utf8")) as Replay
    write(`reports/game-${index}.md`, `# 第 ${index} 局：${g.names.join(" 对 ")}\n\n${buildReport(replay)}`)
    reported.push(index)
  }
  const script: VideoScript = { ...brief.scriptTemplate, ...(userText ? { userText } : {}) }
  write("script.json", JSON.stringify(script, null, 2) + "\n")
  write("brief.json", JSON.stringify(brief, null, 2) + "\n")
  const config: VideoConfig = { series: relative(resolve(dir), resolve(seriesFile)).split("\\").join("/"), out: `${series.ruleset.name}联赛.mp4` }
  write(VIDEO_CONFIG, JSON.stringify(config, null, 2) + "\n")
  const replayPath = (replay: string) => relative(resolve(dir), join(dirname(resolve(seriesFile)), replay)).split("\\").join("/")
  write("PROMPT.md", videoPrompt(brief, series, botFile, reported, replayPath, userText))
  return { dir, files }
}

const pct = (x: number) => `${Math.round(x * 100)}%`

function videoPrompt(
  brief: VideoBrief,
  series: ReturnType<typeof readSeries>,
  botFile: Map<string, string>,
  reported: number[],
  replayPath: (replay: string) => string,
  userText?: string,
): string {
  const L = SCRIPT_LIMITS
  const out: string[] = []
  out.push(`# 联赛视频脚本说明（「${brief.ruleset.name}」联赛，${brief.players.length} 位选手，${brief.league.games} 局）`)
  out.push("")
  out.push("> 由 `rts-arena video-init` 生成。你要给这场联赛写一份视频脚本 `script.json`，然后在这个目录里运行命令出视频。需要的东西都在这个目录里：这份说明、选手的代码 `bots/`、几局的战报 `reports/`、同样内容的 JSON 数据 `brief.json`，不用去别处找。")
  out.push("")
  out.push("## 视频是什么样的")
  out.push("")
  out.push("1. 片头：RTS Arena 平台署名（自动加，脚本里不用写，也去不掉）")
  out.push("2. 标题、用户的原话（`userText`）、你对原话的解读（`theme`）")
  out.push("3. 每个选手一页：你写的显示名、一行小字、一句话定位和 2～4 句介绍；右边自动配上代码文件的前 12 行、代码指标和战绩")
  out.push("4. 联赛排名（自动）")
  out.push("5. 精彩对局：每局一张标题卡（看点自动列出，加上你的标题和一句话解说），接着是整局压缩成 10～20 秒的回放")
  out.push("6. 你写的一句总结（`outro`），然后是片尾平台署名和选手名单（自动）")
  out.push("")
  out.push("## 怎么写")
  out.push("")
  out.push(`- **用户的原话**：${userText ? `是"${userText}"，已经填进 \`script.json\` 的 \`userText\`。` : "用户会告诉你，原样填进 `userText`。"}弄懂它在说什么（调侃谁、有什么梗、站在哪边），在 \`theme\` 里用一句话点出来；整个视频的语气跟着它走。`)
  out.push("- **选手的文件名**：常见写法是 `模型名-编程工具.ts`，比如 `GPT6.1sol-codex.ts` 是在 codex 里用 GPT 6.1 sol 写的。据此写 `displayName`（模型名，加空格好读）和 `byline`（编程工具之类）。拆不开就照原样用，不要瞎猜。")
  out.push("- **代码风格**：打开 `bots/` 里每个选手的代码读一遍（至少开头的注释和主要的决策逻辑），结合下面的代码指标，写出这个选手是什么样的作者：精打细算还是大开大合、工程化还是文案化、靠调参还是靠架构、它自称的绝招和联赛里的实际表现对不对得上。")
  out.push("- **介绍要有依据**：用户原话、文件名、代码、下面的成绩和 `reports/` 的战报里看得到的才写，数字照抄，不编造没发生的事。成绩差的写它的特点和输在哪，可以跟着原话调侃，但别贬低。")
  out.push(`- **精彩对局**：挑 2～3 局（最多 ${L.highlights} 局），按想讲的故事排顺序。下面"精彩对局"里是联赛自动挑的，也可以从"全部对局"里挑别的；解说里说的事要在战报里查得到（\`reports/\` 里有这几局：${reported.map((i) => `第 ${i} 局`).join("、")}；其他局在这个目录里运行 \`rts-arena report <回放文件>\` 看，回放文件名在"全部对局"表里）。`)
  out.push(`- **字数上限**：title ${L.title} 字、userText ${L.userText}、theme ${L.theme}、displayName ${L.displayName}、byline ${L.byline}、tagline ${L.tagline}、intro 每句 ${L.introLine} 字最多 ${L.introLines} 句、精彩对局 title ${L.hlTitle}、commentary ${L.commentary}、outro ${L.outro}。超了命令会报出来。`)
  out.push("- 平台署名（片头片尾）是自动加的；介绍和解说里不要冒充平台的口吻。")
  out.push("")
  out.push("## 脚本格式（script.json）")
  out.push("")
  out.push("```json")
  out.push(
    JSON.stringify(
      {
        title: "视频标题",
        userText: "用户的原话",
        theme: "对原话的解读、一句话导语",
        players: [{ name: "联赛里的名字（必须和下面一样）", displayName: "显示名", byline: "一行小字", tagline: "一句话定位", intro: ["介绍 2～4 句"] }],
        highlights: [{ index: 1, title: "这局的标题", commentary: "一句话解说" }],
        outro: "一句总结",
      },
      null,
      2,
    ),
  )
  out.push("```")
  out.push("")
  out.push("所有选手都要写，`players` 的顺序就是出场顺序；`highlights` 不写就用联赛挑的前 3 局、不带解说。`script.json` 里已经有一份待填的模板，把\"待填\"都换掉。")
  out.push("")
  out.push("## 出视频（在这个目录里运行）")
  out.push("")
  out.push("```bash")
  out.push("rts-arena video --preview 2,10,20,40,80   # 只画这几秒的画面（PNG），先看排版、字有没有挤出去")
  out.push("rts-arena video --check 5,60               # 出视频，并从成品里截这几秒的图检查")
  out.push("```")
  out.push("")
  out.push(`不写参数时用这个目录的 \`script.json\`，视频输出成 \`${series.ruleset.name}联赛.mp4\`（\`--out\` 可以改），1920×1080。脚本格式不对时命令会列出所有问题，照着改。预览图要逐张打开看。`)
  out.push("")
  out.push("## 联赛数据")
  out.push("")
  out.push("### 排名")
  out.push("")
  out.push("| 名次 | 联赛里的名字 | 胜 | 平 | 负 | 得分率 | 等级分 |")
  out.push("|---|---|---|---|---|---|---|")
  for (const p of [...brief.players].sort((a, b) => (a.standing?.rank ?? 99) - (b.standing?.rank ?? 99)))
    out.push(`| ${p.standing?.rank ?? "-"} | ${p.name} | ${p.standing?.wins ?? 0} | ${p.standing?.draws ?? 0} | ${p.standing?.losses ?? 0} | ${pct(p.standing?.rate ?? 0)} | ${p.standing?.elo ?? "-"} |`)
  out.push("")
  out.push("### 选手")
  for (const p of brief.players) {
    out.push("")
    out.push(`#### ${p.name}`)
    out.push("")
    out.push(`- 代码：\`${botFile.get(p.name) ?? "（没找到文件）"}\`；文件名拆开：${p.fileNameParts.map((x) => `"${x}"`).join(" / ")}`)
    out.push(`- 对每个对手（胜-平-负）：${Object.entries(p.headToHead).map(([k, v]) => `${k} ${v}`).join("；")}`)
    if (p.perGame) out.push(`- 每局平均：${Object.entries(p.perGame).map(([k, v]) => `${k} ${v}`).join("，")}`)
    out.push(`- 出错：报错 ${p.trouble.errors}、燃料耗尽 ${p.trouble.fuelOuts}、被拒命令 ${p.trouble.rejected}`)
    const c = p.code
    if (c) {
      out.push(`- 代码指标：${c.lines} 行（代码 ${c.codeLines}、注释 ${c.commentLines}，注释占 ${pct(c.commentRatio)}，注释里汉字占 ${pct(c.chineseInComments)}）；${c.functions} 个函数、${c.interfacesAndTypes} 个类型、${c.topLevelState} 个顶层状态变量`)
      out.push(`- 写法特征：${Object.entries(c.features).map(([k, v]) => `${k} ${v}`).join("，")}`)
      if (c.constants.length) out.push(`- 常量参数：${c.constants.map((x) => `\`${x}\``).join("，")}`)
      if (c.header.length) {
        out.push("- 文件开头的注释：")
        out.push("")
        out.push("  ```")
        for (const l of c.header) out.push(`  ${l}`)
        out.push("  ```")
      }
    }
  }
  out.push("")
  out.push("### 精彩对局（联赛按逆转、优势换手、大战、险胜、爆冷自动挑的）")
  out.push("")
  if (!brief.highlights?.length) out.push("没有（大多是一边倒）。可以从全部对局里挑。")
  for (const h of brief.highlights ?? []) out.push(`- 第 ${h.index} 局 ${h.who}，${h.winner ? `${h.winner} 赢` : "平局"}（第 ${h.tick} tick，精彩度 ${h.score}）：${h.reasons.join("；")}`)
  out.push("")
  out.push("### 全部对局")
  out.push("")
  out.push("| 局 | 对阵（座位顺序） | 结果 | tick | 结束原因 | 战报 / 回放 |")
  out.push("|---|---|---|---|---|---|")
  for (const r of series.results) {
    const winners = [...new Set(r.winners.map((w) => r.names[w]))]
    out.push(`| ${r.index} | ${r.names.join(" 对 ")} | ${winners.length ? `${winners.join("、")} 赢` : "平局"} | ${r.tick} | ${r.reason} | ${reported.includes(r.index) ? `reports/game-${r.index}.md` : `\`${replayPath(r.replay)}\``} |`)
  }
  out.push("")
  return out.join("\n")
}
