// rts-arena video-init：把一场联赛做视频要用的东西导出到一个目录（像 init 建 bot 目录那样）——
// 给大模型的说明 PROMPT.md、联赛数据、选手 bot 文件的副本、几局的战报、待填的脚本。
// 大模型只读这个目录里的文件、写好 script.json，在目录里运行 rts-arena video 就能出预览和视频
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { findRuleset } from "../cli/catalog.ts"
import { gameFacts } from "../cli/highlights.ts"
import { gameSeatStats, type SeatGameStats } from "../cli/league-stats.ts"
import { buildReport } from "../cli/report.ts"
import type { Replay } from "../core/types.ts"
import { factTags, PLAYER_PAGE_CHARS, PLAYER_PAGE_MIN, readSeries, RULES_PAGE_CHARS, SCRIPT_LIMITS, videoBrief, type VideoBrief, type VideoScript } from "./brief.ts"
import { gameReasons, PALETTE_NAMES, tidy } from "./render.ts"

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

/** 每局另外记下的：最终比分（规则包的分数）、规则包写了几条事件（夺下控制点、商队被劫……） */
interface GameExtra {
  scores: number[]
  notes: number
  /** 挑这局当精彩对局时，标题卡上自动显示的看点（和视频里一样） */
  card: string[]
  /** 最大一仗死了几个（和战报「战斗」一节同一套切分） */
  biggest: number
}

export interface WorkspaceOptions {
  /** 用户的原话（预先填进 script.json） */
  userText?: string
  /** 用户补充的背景：外号对应哪个模型、以前的成绩……（联赛数据里没有的） */
  about?: string
}

export function createVideoWorkspace(seriesFile: string, dir: string, opts: WorkspaceOptions = {}): { dir: string; files: string[] } {
  const { userText, about } = opts
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
  // 每局的数据（全部对局表用）和几局的战报
  const toReport = new Set(reportGames(brief, series))
  const reported: number[] = []
  const stats = new Map<number, SeatGameStats[]>()
  const extra = new Map<number, GameExtra>()
  for (const g of series.results) {
    const replayFile = join(dirname(resolve(seriesFile)), g.replay)
    if (!existsSync(replayFile)) continue
    const replay = JSON.parse(readFileSync(replayFile, "utf8")) as Replay
    stats.set(g.index, gameSeatStats(replay))
    let players = replay.initial.players
    for (const f of replay.frames) if (f.players) players = f.players
    const hl = brief.highlights?.find((h) => h.index === g.index)
    extra.set(g.index, {
      scores: players.map((p) => Math.round(p.score)),
      notes: replay.frames.reduce((a, f) => a + (f.notes?.length ?? 0), 0),
      card: (hl ? hl.reasons : gameReasons(replay, g.names)).map(tidy),
      biggest: gameFacts(replay).biggestBattle,
    })
    if (!toReport.has(g.index)) continue
    write(`reports/game-${g.index}.md`, `# 第 ${g.index} 局：${g.names.join(" 对 ")}\n\n（P0、P1……是座位，顺序和标题里的名字一样）\n\n${buildReport(replay)}`)
    reported.push(g.index)
  }
  // 全联赛之最的标签排在看点最前面（和渲染时一样），最多 4 条
  const tags = factTags(series, new Map([...extra].map(([i, x]) => [i, x.scores])))
  for (const [i, x] of extra) x.card = [...(tags.get(i) ?? []), ...x.card].slice(0, 4)
  // 规则说明：规则介绍那一段照它写（联赛汇总里记了规则包目录就用它，没记就按名字找平台自带的）
  const rulesDir = series.ruleset.dir && existsSync(join(series.ruleset.dir, "RULES.md")) ? series.ruleset.dir : findRuleset(series.ruleset.id)?.dir
  const hasRules = !!rulesDir && existsSync(join(rulesDir, "RULES.md"))
  if (hasRules) {
    copyFileSync(join(rulesDir!, "RULES.md"), join(dir, "RULES.md"))
    files.push("RULES.md")
  }
  const script: VideoScript = { ...brief.scriptTemplate, ...(userText ? { userText } : {}) }
  write("script.json", JSON.stringify(script, null, 2) + "\n")
  write("brief.json", JSON.stringify(brief, null, 2) + "\n")
  const config: VideoConfig = { series: relative(resolve(dir), resolve(seriesFile)).split("\\").join("/"), out: `${series.ruleset.name}联赛.mp4` }
  write(VIDEO_CONFIG, JSON.stringify(config, null, 2) + "\n")
  const replayPath = (replay: string) => relative(resolve(dir), join(dirname(resolve(seriesFile)), replay)).split("\\").join("/")
  write("PROMPT.md", videoPrompt(brief, series, botFile, reported, stats, extra, replayPath, userText, about, hasRules))
  return { dir, files }
}

const pct = (x: number) => `${Math.round(x * 100)}%`

function videoPrompt(
  brief: VideoBrief,
  series: ReturnType<typeof readSeries>,
  botFile: Map<string, string>,
  reported: number[],
  stats: Map<number, SeatGameStats[]>,
  extra: Map<number, GameExtra>,
  replayPath: (replay: string) => string,
  userText?: string,
  about?: string,
  hasRules = false,
): string {
  const L = SCRIPT_LIMITS
  const rs = brief.ruleset.name
  const out: string[] = []
  out.push(`# 联赛视频脚本说明（「${rs}」联赛，${brief.players.length} 位选手，${brief.league.games} 局）`)
  out.push("")
  out.push("> 由 `rts-arena video-init` 生成。你要给这场联赛写一份视频脚本 `script.json`，然后在这个目录里运行命令出视频。需要的东西都在这个目录里：这份说明、规则说明 `RULES.md`、选手的代码 `bots/`、几局的战报 `reports/`，不用去别处找（`brief.json` 是给程序用的同样数据，不用读）。")
  out.push("")
  out.push("## 视频是什么样的")
  out.push("")
  out.push("脚本只管文字，排版、配色、动画、回放都是平台做的。没有配音。按顺序：")
  out.push("")
  out.push("1. **片头**：RTS Arena 平台署名（自动加，脚本里不用写，也去不掉）。")
  out.push(`2. **标题页**：最上面一行小字「${rs}联赛」，下面是你的 \`title\`（所以标题里不用再写规则包和"联赛"），然后是框起来的用户原话 \`userText\`，最后是你的解读 \`theme\`。`)
  out.push(`3. **规则介绍**：左边是你写的 \`rules\`（1～${L.rulesLines} 句，逐句出现），右边自动配上第一局精彩对局的开局地图（控制点这类标记也画出来）和单位图例（形状、字、名字、造价、生命、近战还是射程几格）。\`rules\` 不写就只显示规则包的一句话简介${series.ruleset.summary ? `："${series.ruleset.summary}"` : ""}。`)
  out.push("4. **每个选手一页**，按 `players` 的顺序：左边是 `displayName`、`byline`（小字）、`tagline`（一句话定位，醒目）、`intro`（逐句出现）；右边自动配上代码文件的开头 12 行（跳过空行和空注释）、代码指标、联赛战绩。")
  out.push("5. **联赛排名**（自动）。")
  out.push("6. **精彩对局**，按 `highlights` 的顺序，每局两段：")
  out.push("   - 标题卡：你的 `title`、对阵双方、结果（谁赢、第几 tick、怎么结束的）、**自动列出的看点**（就是下面「全部对局」表里这局的「标题卡看点」，最多 4 条：全联赛最快 / 最久 / 比分最接近这类标签排在前面，联赛挑的精彩对局接着是「精彩对局」一节冒号后面那几条，别的局是平台从回放算的），最后是你的 `commentary`。**`commentary` 别重复看点里已经有的话**，讲看点没讲的：这局的来龙去脉、关键的一下、和选手风格的关系。")
  out.push("   - 回放：整局压缩成 10～20 秒，**打起来的时候慢放、没动静的时候快进**。顶上一行是你的 `title` 和 `commentary`；地图上画着规则包的标记（控制点、台址这类区域，按归属上色）；右边侧栏是双方实时的兵数、工人数、建筑数、分数（分数的意思看规则包：歼灭是击杀价值、夺点是控制分），规则包的状态栏（比分、目标），和\"战况\"：第一次交火、规则包写的事件（比如\"哈基米夺下控制点\"，战报的关键事件里带\"（规则包）\"的那些）、失去建筑、大战、出局，放不下时只留最新的几条。大战和战报\"战斗\"一节是同一套切分，侧栏只列死 6 个以上的（这局最大的一仗都不到 6 个时，列死 3 个以上的、叫「交战」，和战报一样），开打就显示\"交战中\"、损失随时间往上加，打完显示起止时间；只有一方在死人、有一方没死兵（兵冲进矿区杀工人、撞上箭塔）或者死得少的一方不到对方 1/4 的，打完标「一边倒」，不算大战。")
  out.push("7. **片尾**：最上面是你的 `outro`（可以不写），然后是平台署名，最后是选手名单（按 `players` 的顺序），每人一行 \"`displayName` · `byline`\"。**`byline` 会出现在片尾的正式名单里**，写编程工具、出品方这类正经信息，玩笑放在 `tagline` 和介绍里。")
  out.push("")
  out.push(`每段多长是按字数算的：选手页 4.6～7 秒（字多的长些）；标题页、规则页、标题卡按每秒约 11 字算，标题卡 4.5～8 秒、规则页最长 12 秒。每个选手的 \`tagline\` 加 \`intro\` 一共写 120～${PLAYER_PAGE_CHARS} 字正好（3～4 句、每句 30～40 字）：选手页的字比别的页密，少于 ${PLAYER_PAGE_MIN} 字页面显得空、超过 ${PLAYER_PAGE_CHARS} 字读不完，命令都会提醒。每次运行 \`rts-arena video\` 都会列出每段从第几秒到第几秒。`)
  out.push("")
  out.push("## 怎么写")
  out.push("")
  out.push(`- **用户的原话**：${userText ? `是"${userText}"，已经填进 \`script.json\` 的 \`userText\`，要展示的话不要改字。` : "用户会告诉你，原样填进 `userText`。"}原话里夹着给你的要求（比如"请把某某称作某某"）时，照要求做，但这句要求从 \`userText\` 里删掉，开场只展示要说给观众听的那几句。弄懂它在说什么（调侃谁、有什么梗、站在哪边），在 \`theme\` 里用一句话点出来；整个视频的语气跟着它走。外号也可以当 \`displayName\`，本名和编程工具写进 \`byline\`（比如"<模型名> · <编程工具>"，尖括号里换成用户说的）。`)
  if (about) out.push(`- **用户补充的背景**：${about}\n  这是用户告诉你的、联赛数据以外的事（比如外号对应哪个模型、用的什么编程工具、上一届的成绩），可以照用；和下面的数据对不上时以数据为准。`)
  out.push("- **选手的文件名**：常见写法是 `模型名-编程工具.ts`，比如 `ModelX2.0-ToolY.ts` 是在 ToolY 里用 ModelX 2.0 写的（这只是格式的例子）。据此写 `displayName`（模型名，加空格好读）和 `byline`（编程工具之类）。文件名只是外号、看不出是哪个模型时，看上面「用户补充的背景」；也没有就照原样用，不要瞎猜——说明里的例子只是格式，不代表这场的选手。不知道作者、编程工具时就删掉 `byline`（片尾只列名字），别拿文件名、代码里的自称凑。")
  out.push(`- **规则介绍**（\`rules\`）：写给没玩过这个规则包的观众，${hasRules ? "照这个目录里的 \`RULES.md\` 写（它是写给 bot 作者的：\`view.objectives\` 这类接口和命令不用管）。**别写\"和某某规则包一样\"\"在某某的基础上\"**：观众不一定玩过那个规则包，RULES.md 里这么说的地方，把要用到的规则（开局有什么、怎么赢、关键机制）直接简要讲出来，再讲这个规则包特别的地方" : "（这次没找到规则说明，照下面的数据和战报写）"}：怎么赢、最关键的机制、特别的单位或建筑，数字照抄、不编。图例已经列出各单位的造价和数值，规则页最下面会自动注明"1 秒 = 多少 tick"，这些不用重复。左栏一行大约 20 个字，每句 30 字以内断行好看。1～${L.rulesLines} 句，每句 ${L.rulesLine} 字以内，加起来 ${RULES_PAGE_CHARS} 字以内（规则页最长 12 秒）。`)
  out.push("- **代码风格**：打开 `bots/` 里每个选手的代码读一遍（至少开头的注释和主要的决策逻辑），结合下面的代码指标，写出这个选手是什么样的作者：精打细算还是大开大合、工程化还是文案化、靠调参还是靠架构、它自称的绝招和联赛里的实际表现对不对得上。")
  out.push("- **注释可能和代码对不上**：文件开头的注释是作者写的，可能是旧版本的、也可能是自吹（比如注释说「一个工人都不补」，参数却是补到 5 个）。写打法时以代码里的参数和战报为准，注释里的只能说「自称」「注释里写着」。")
  out.push("- **介绍要有依据**：用户原话、文件名、代码、下面的成绩和 `reports/` 的战报里看得到的才写，数字照抄，不编造没发生的事。成绩差的写它的特点和输在哪，可以跟着原话调侃，但别贬低。")
  out.push("- **不知道的事别写成事实**：平台不知道每个 bot 是怎么写出来的、改了几轮。代码里的版本号（v3、v6 之类）和自称的绝招都是作者自己写的，只能说\"自称\"\"注释里写着\"。")
  out.push(`- **精彩对局**：挑 3～5 局（最多 ${L.highlights} 局），按想讲的故事排顺序。下面"精彩对局"里是联赛自动挑的，也可以从"全部对局"里挑别的（表里有每局双方的采集、损失、击杀，找"最快""最险""最惨烈"的局用得上）。解说里说的事要在战报里查得到：\`reports/\` 里有这几局：${reported.map((i) => `第 ${i} 局`).join("、")}；其他局在这个目录里运行 \`rts-arena report <回放文件>\` 看，回放文件名在"全部对局"表里。战报里的 P0、P1 是座位，顺序和对阵里的名字一样。`)
  out.push(`- **字数上限**（按字符算：汉字、字母、数字、空格、标点都算 1 个）：title ${L.title}、userText ${L.userText}、theme ${L.theme}、displayName ${L.displayName}、byline ${L.byline}、tagline ${L.tagline}、intro 1～${L.introLines} 句（建议 3～4 句）每句 ${L.introLine}、精彩对局 title ${L.hlTitle}、commentary ${L.commentary}、outro ${L.outro}。超了命令会报出来。`)
  out.push("- **粗体字段别写\"一\"**：`title`、`tagline`、精彩对局的 `title` 和 `commentary`、`outro` 是粗体，\"一\"在粗体下就是一道横线，像破折号（\"唯一一胜\"看成\"唯——胜\"，\"只输一局\"看成\"只输—局\"）。数量写阿拉伯数字（\"只输 1 局\"），别的换个说法（\"一波\"→\"突袭\"，\"一边倒\"→\"倒向对面\"）；`intro`、`theme` 是常规字重，不受影响。")
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
        rules: ["规则介绍 1～4 句：怎么赢、关键机制"],
        players: [{ name: "联赛里的名字（必须和下面一样）", displayName: "显示名", byline: "一行小字（也上片尾名单）", tagline: "一句话定位", intro: ["介绍 1～4 句"] }],
        highlights: [{ index: 1, title: "这局的标题", commentary: "一句话解说（别重复自动看点）" }],
        outro: "一句总结（可以不写）",
      },
      null,
      2,
    ),
  )
  out.push("```")
  out.push("")
  out.push("`highlights` 里的 `index` 是联赛的**局号**（「全部对局」表的第一列），不是第几个。所有选手都要写，`players` 的顺序就是出场顺序；`title`、`rules`、`displayName`、`byline`、`highlights` 里的 `title` 和 `commentary`、`outro` 都可以不写。`highlights` 不写就用联赛挑的前 3 局、不带解说。`script.json` 里已经有一份待填的模板，把\"待填\"都换掉（不要的字段直接删）。")
  out.push("")
  out.push("## 出视频（在这个目录里运行）")
  out.push("")
  out.push("```bash")
  out.push("rts-arena video --lint                # 只核对脚本：格式、每段字数和上限、时间表（不出图，几秒钟），字数对了再出预览")
  out.push("rts-arena video --preview auto        # 每段各出一张预览图（放在 preview/ 里，另有一张总览拼图），先看排版、字有没有挤出去")
  out.push("rts-arena video --preview 12.5,40     # 只看这几秒（秒数从上一条命令列出的时间表里找）")
  out.push("rts-arena video --check auto          # 出视频，并从成品里每段截一张图检查（也放在 preview/ 里；也可以写秒数：--check 5,60）")
  out.push("```")
  out.push("")
  out.push(`不写参数时用这个目录的 \`script.json\`，视频输出成 \`${rs}联赛.mp4\`（\`--out\` 可以改），1920×1080。脚本格式不对时命令会列出所有问题，照着改。预览图要逐张打开看。`)
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
  out.push("")
  out.push("代码指标是数出来的：")
  out.push("")
  out.push("- 函数：`function 名字` 和 `const 名字 = (...) =>` 的个数；类型：`interface` 和 `type` 的个数；顶层变量：文件顶层的 `let`（跨回合记状态用的）")
  out.push("- 写法特征里：`cmd.xxx` 是调用这个命令的地方有几处；\"自己寻路\"是 bfs、astar、path、flowField 之类的词出现几次；\"状态机模式\"是 `mode =` / `mode:` 出现几次；\"实测或调参注释\"是\"实测、调参、调出来、回放数据\"出现几次；\"版本号\"是 v3、v1.2、VERSION 这类出现几次")
  out.push("")
  brief.players.forEach((p, i) => {
    out.push(`#### ${p.name}`)
    out.push("")
    out.push(`- 代码：\`${botFile.get(p.name) ?? "（没找到文件）"}\`；文件名拆开：${p.fileNameParts.map((x) => `"${x}"`).join(" / ")}`)
    out.push(`- 视频里的颜色：${PALETTE_NAMES[i % PALETTE_NAMES.length]}色（选手页、排名、回放里都是这个颜色）`)
    out.push(`- 对每个对手（胜-平-负）：${Object.entries(p.headToHead).map(([k, v]) => `${k} ${v}`).join("；")}`)
    if (p.perGame) out.push(`- 每局平均：${Object.entries(p.perGame).map(([k, v]) => `${k} ${v}`).join("，")}`)
    out.push(`- 出错：报错 ${p.trouble.errors}、燃料耗尽 ${p.trouble.fuelOuts}、被拒命令 ${p.trouble.rejected}`)
    const c = p.code
    if (c) {
      out.push(`- 代码指标：${c.lines} 行（代码 ${c.codeLines}、注释 ${c.commentLines}，注释占 ${pct(c.commentRatio)}，注释里汉字占 ${pct(c.chineseInComments)}）；${c.functions} 个函数、${c.interfacesAndTypes} 个类型、${c.topLevelState} 个顶层变量`)
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
    out.push("")
  })
  out.push("### 联赛速查（平台从全部对局算好的，挑对局、写解说时直接用，不用自己去下面的表里排序）")
  out.push("")
  out.push(...quickFacts(series, brief, extra).map(tidy))
  out.push("")
  out.push("### 精彩对局（联赛按逆转、优势换手、两边都伤得重、大战、险胜、爆冷自动挑的；一边倒的不算）")
  out.push("")
  out.push("冒号后面的几条就是标题卡上自动显示的看点，解说不用重复。")
  out.push("")
  if (!brief.highlights?.length) out.push("没有（大多是一边倒）。可以从全部对局里挑。")
  for (const h of brief.highlights ?? []) out.push(`- 第 ${h.index} 局 ${h.who}，${h.winner ? `${h.winner} 赢` : "平局"}（第 ${h.tick} tick，精彩度 ${h.score}）：${h.reasons.join("；")}`)
  out.push("")
  out.push("### 全部对局")
  out.push("")
  out.push("「标题卡看点」是挑这局当精彩对局时标题卡上自动显示的（最多 4 条），解说别重复它们。每局数据按对阵的顺序，每人一组：采集 / 损失单位（其中工人）/ 击杀单位 / 拆建筑；规则包有分数时后面是最终比分，有规则包事件时是事件条数（详情在战报的关键事件里，带\"（规则包）\"的那些）。")
  out.push("")
  out.push("| 局 | 对阵（座位顺序） | 结果 | tick | 结束原因 | 每局数据 | 标题卡看点 | 战报 / 回放 |")
  out.push("|---|---|---|---|---|---|---|---|")
  for (const r of series.results) {
    const winners = [...new Set(r.winners.map((w) => r.names[w]))]
    const st = stats.get(r.index)
    const ex = extra.get(r.index)
    const data =
      (st ? st.map((x) => `${Math.round(x.income)} / ${x.lostUnits}（${x.lostWorkers}）/ ${x.killedUnits} / ${x.killedBuildings}`).join("；") : "-") +
      (ex && ex.scores.some((v) => v !== 0) ? `；比分 ${ex.scores.join(" : ")}` : "") +
      (ex?.notes ? `；规则包事件 ${ex.notes} 条` : "")
    out.push(`| ${r.index} | ${r.names.join(" 对 ")} | ${winners.length ? `${winners.join("、")} 赢` : "平局"} | ${r.tick} | ${r.reason} | ${data} | ${ex?.card.length ? ex.card.join("；") : "-"} | ${reported.includes(r.index) ? `reports/game-${r.index}.md` : `\`${replayPath(r.replay)}\``} |`)
  }
  out.push("")
  return out.join("\n")
}

/**
 * 联赛速查：从全部对局算好的事实——最快 / 最久的局、每个选手赢了谁输给谁（败局全输给同一个人这种）、爆冷、克制环、比分最接近的局、
 * 规则包事件最多的局（夺点里就是控制点反复易手）。写视频时这些都是要自己去对局表里排序才看得出来的
 */
function quickFacts(series: ReturnType<typeof readSeries>, brief: VideoBrief, extra: Map<number, GameExtra>): string[] {
  const out: string[] = []
  const R = series.results
  const rankOf = new Map(brief.players.map((p) => [p.name, p.standing?.rank ?? 99]))
  const winnersOf = (r: (typeof R)[number]) => [...new Set(r.winners.map((w) => r.names[w]))]
  const losersOf = (r: (typeof R)[number]) => [...new Set(r.names.filter((_, p) => !r.winners.includes(p)))]
  const vs = (r: (typeof R)[number]) => r.names.join(" 对 ")
  const list = (idx: number[]) => (idx.length <= 6 ? `（${idx.map((i) => `第 ${i} 局`).join("、")}）` : "")
  const decided = R.filter((r) => r.winners.length > 0)
  const fast = [...decided].sort((a, b) => a.tick - b.tick).slice(0, 3)
  if (fast.length) out.push(`- 结束得最快的胜局：${fast.map((r) => `第 ${r.index} 局 ${winnersOf(r).join("、")} 赢（${vs(r)}，${r.tick} tick）`).join("；")}`)
  const slow = [...R].sort((a, b) => b.tick - a.tick).slice(0, 3)
  if (slow.length) out.push(`- 打得最久的：${slow.map((r) => `第 ${r.index} 局（${vs(r)}，${r.tick} tick，${winnersOf(r).length ? `${winnersOf(r).join("、")} 赢` : "平局"}）`).join("；")}`)
  for (const p of brief.players) {
    const mine = R.filter((r) => r.names.includes(p.name))
    const wins = mine.filter((r) => winnersOf(r).includes(p.name))
    const losses = mine.filter((r) => r.winners.length > 0 && !winnersOf(r).includes(p.name))
    const group = (games: typeof R, who: (r: (typeof R)[number]) => string[]) => {
      const m = new Map<string, number[]>()
      for (const r of games) for (const n of who(r)) if (n !== p.name) m.set(n, [...(m.get(n) ?? []), r.index])
      return [...m].sort((a, b) => b[1].length - a[1].length)
    }
    const beat = group(wins, losersOf)
    const lostTo = group(losses, winnersOf)
    const fastest = [...wins].sort((a, b) => a.tick - b.tick)[0]
    const parts: string[] = []
    parts.push(
      wins.length === 0
        ? "1 局没赢"
        : `赢 ${wins.length} 局：${beat.map(([n, idx]) => `赢 ${n} ${idx.length} 局${list(idx)}`).join("，")}${beat.length === 1 && wins.length >= 2 && rankOf.size > 2 ? `——胜局全是赢 ${beat[0][0]} 的` : ""}；最快的是第 ${fastest.index} 局（${fastest.tick} tick）`,
    )
    parts.push(
      losses.length === 0
        ? "1 局没输"
        : `输 ${losses.length} 局：${lostTo.map(([n, idx]) => `输给 ${n} ${idx.length} 局${list(idx)}`).join("，")}${lostTo.length === 1 && losses.length >= 2 && rankOf.size > 2 ? `——败局全输给 ${lostTo[0][0]}` : ""}`,
    )
    out.push(`- ${p.name}（第 ${rankOf.get(p.name)} 名）：${parts.join("；")}`)
  }
  // 爆冷：名次靠后的赢了名次靠前的
  const upsets = decided
    .map((r) => {
      const w = Math.max(...winnersOf(r).map((n) => rankOf.get(n) ?? 99))
      const l = Math.min(...losersOf(r).map((n) => rankOf.get(n) ?? 99))
      return { r, gap: w - l }
    })
    .filter((x) => x.gap > 0)
    .sort((a, b) => b.gap - a.gap || a.r.index - b.r.index)
  if (!upsets.length) out.push("- 爆冷：没有（每局都是名次靠前的赢）")
  else
    out.push(
      `- 爆冷（名次靠后的赢了名次靠前的，共 ${upsets.length} 局）：${upsets
        .slice(0, 10)
        .map((x) => `第 ${x.r.index} 局 ${winnersOf(x.r).join("、")}（第 ${winnersOf(x.r).map((n) => rankOf.get(n)).join("、")} 名）赢 ${losersOf(x.r).join("、")}`)
        .join("；")}${upsets.length > 10 ? "……" : ""}`,
    )
  // 克制环：两两对阵赢多输少连成一圈
  const names = series.participants.map((p) => p.name)
  const m = series.summary?.matrix ?? []
  const beats = (i: number, j: number) => (m[i]?.[j] ? m[i][j].w > m[i][j].l : false)
  const cycles: string[] = []
  for (let i = 0; i < names.length; i++)
    for (let j = 0; j < names.length; j++)
      for (let k = 0; k < names.length; k++) {
        if (i >= j || i >= k || j === k) continue
        if (beats(i, j) && beats(j, k) && beats(k, i)) {
          const h = (a: number, b: number) => `${m[a][b].w}-${m[a][b].d}-${m[a][b].l}`
          cycles.push(`${names[i]} 克 ${names[j]}（${h(i, j)}）、${names[j]} 克 ${names[k]}（${h(j, k)}）、${names[k]} 克 ${names[i]}（${h(k, i)}）`)
        }
      }
  out.push(cycles.length ? `- 克制环（两两对阵赢多输少连成一圈）：${cycles.slice(0, 3).join("；")}` : "- 克制环：没有（两两对阵赢多输少的方向没有连成一圈）")
  // 逆转：标题卡看点里有"逆转"的局（落后过还赢了）
  const comebacks = R.filter((r) => extra.get(r.index)?.card.some((c) => c.startsWith("逆转")))
  out.push(
    comebacks.length
      ? `- 逆转（落后过还赢了，共 ${comebacks.length} 局）：${comebacks
          .slice(0, 10)
          .map((r) => `第 ${r.index} 局 ${winnersOf(r).join("、")} 赢（${extra.get(r.index)!.card.find((c) => c.startsWith("逆转"))!.replace(/^逆转：/, "")}）`)
          .join("；")}${comebacks.length > 10 ? "……（其余的在「全部对局」表的标题卡看点里）" : ""}`
      : "- 逆转：没有（赢的一方都没落后过太多）",
  )
  // 死人最多的一仗
  const bloody = R.map((r) => ({ r, n: extra.get(r.index)?.biggest ?? 0 }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.r.index - b.r.index)
  if (bloody.length) out.push(`- 死人最多的一仗：${bloody.slice(0, 3).map((x) => `第 ${x.r.index} 局（${vs(x.r)}，最大一仗死了 ${x.n} 个）`).join("；")}`)
  // 比分最接近的局（规则包有分数时）
  const close = decided
    .map((r) => {
      const sc = extra.get(r.index)?.scores
      if (!sc || sc.every((v) => v === 0)) return null
      const ws = Math.max(...r.winners.map((p) => sc[p]))
      const ls = Math.max(...sc.filter((_, p) => !r.winners.includes(p)))
      return { r, sc, gap: ws - ls }
    })
    .filter((x): x is { r: (typeof R)[number]; sc: number[]; gap: number } => x !== null && x.gap >= 0)
    .sort((a, b) => a.gap - b.gap)
  if (!close.length) out.push("- 比分最接近的胜局：这个规则包没有分数（或者分数都是 0）")
  else out.push(`- 比分最接近的胜局：${close.slice(0, 3).map((x) => `第 ${x.r.index} 局 ${vs(x.r)} ${x.sc.join(" : ")}（${winnersOf(x.r).join("、")} 赢）`).join("；")}`)
  // 规则包事件最多的局
  const busy = R.map((r) => ({ r, n: extra.get(r.index)?.notes ?? 0 }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
  if (!busy.length) out.push("- 规则包事件最多的局：没有（这个规则包不写事件）")
  else out.push(`- 规则包事件最多的局（夺点是控制点反复易手这类；详情看战报带"（规则包）"的事件，没附战报的用 rts-arena report 看）：${busy.slice(0, 3).map((x) => `第 ${x.r.index} 局（${vs(x.r)}，${x.n} 条）`).join("；")}`)
  return out
}
