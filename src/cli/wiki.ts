// 把仓库 doc/ 里给用户看的文档同步到 GitHub wiki 的本地克隆（D-160）：改链接、生成首页和侧栏。
// 文档以仓库为准，wiki 只是镜像：在 wiki 网页上改的会在下次同步时被覆盖。
// 用法：git clone https://github.com/Clark760/RTS-ARENA.wiki.git <目录>，然后 npm run wiki -- <目录>，再到目录里提交推送
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, posix } from "node:path"
import { PKG_ROOT } from "../paths.ts"

export const REPO = "https://github.com/Clark760/RTS-ARENA"
const GITEE = "https://gitee.com/mingomin/rts-arena"

/** 同步哪些文档：doc/ 里的文件名 → wiki 页面名（文件名去掉 .md；GitHub 把页面名里的 - 显示成空格） */
export const WIKI_PAGES = [
  { file: "入门教程.md", page: "入门教程", title: "入门教程", about: "装好、建 bot 目录、跑第一局、看回放和战报、交给大模型、开联赛（第一次用先看这篇）" },
  { file: "写-bot-指南.md", page: "写-bot-指南", title: "写 bot 指南", about: "bot 怎么运作、局面和命令、一个能用的例子、调试方法、常见的坑（自己写 bot 时看）" },
  { file: "规则包介绍.md", page: "规则包介绍", title: "规则包介绍", about: "自带的 10 个规则包各怎么玩、怎么赢、有哪些参考 bot，以及怎么挑一个上手" },
]

/**
 * 把 doc/ 里一份文档的链接改成 wiki 里能用的：链到另一份同步的文档换成 wiki 页面名，
 * 链到仓库里别的文件换成 GitHub 上的地址（README 换成仓库首页）。代码块里的不动
 */
export function toWiki(md: string): string {
  return md
    .split(/(```[\s\S]*?```)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(/\]\(([^)\s]+)\)/g, (m, href: string) => {
            if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return m
            const [path, hash] = href.split("#")
            const tail = hash ? `#${hash}` : ""
            const page = WIKI_PAGES.find((p) => p.file === path)
            if (page) return `](${page.page}${tail})`
            const file = posix.normalize(posix.join("doc", path))
            if (file === "README.md") return `](${REPO}${tail})`
            return `](${REPO}/blob/main/${file}${tail})`
          }),
    )
    .join("")
}

/** 在第一个一级标题下面加一句"本页从仓库同步" */
function withNote(md: string, file: string): string {
  const note = `> 本页从仓库的 [doc/${file}](${REPO}/blob/main/doc/${file}) 同步过来。要修改请改仓库里的文件，在这里改的会在下次同步时被覆盖。`
  return /^# .*\n/.test(md) ? md.replace(/^(# .*\n)/, `$1\n${note}\n`) : `${note}\n\n${md}`
}

export function wikiHome(): string {
  return [
    "# RTS Arena",
    "",
    "**大模型写 bot 的即时战略竞技平台。** 大模型（或人）用 TypeScript 写一个 bot 控制一方，在格子地图上采矿、造兵、打仗。平台负责跑比赛、出排行榜、放回放，还能把一场联赛做成视频。玩法由「规则包」决定，自带 10 种，也可以自己写。",
    "",
    `![一局回放：左边是地图，右边是双方的兵力、科技和战况](https://raw.githubusercontent.com/Clark760/RTS-ARENA/main/doc/images/replay.jpg)`,
    "",
    "## 从这里开始",
    "",
    ...WIKI_PAGES.map((p) => `- **[${p.title}](${p.page})**：${p.about}`),
    "",
    "## 更多",
    "",
    `- [仓库首页](${REPO})：安装、规则包一览、命令速查、联赛视频、写规则包`,
    `- [平台设计](${REPO}/blob/main/doc/设计.md)：平台的设计，以及每个决定的来由`,
    `- 代码在 [GitHub](${REPO}) 和 [gitee](${GITEE}) 同步更新。这个 wiki 的内容从仓库的 doc/ 同步过来，以仓库为准。`,
    "",
  ].join("\n")
}

export function wikiSidebar(): string {
  return ["**RTS Arena**", "", "- [首页](Home)", ...WIKI_PAGES.map((p) => `- [${p.title}](${p.page})`), `- [仓库](${REPO})`, ""].join("\n")
}

/** 把文档写进 wiki 克隆目录，返回写了哪些文件 */
export function syncWiki(dir: string): string[] {
  const out: [string, string][] = [
    ["Home.md", wikiHome()],
    ["_Sidebar.md", wikiSidebar()],
    ...WIKI_PAGES.map((p): [string, string] => [`${p.page}.md`, withNote(toWiki(readFileSync(join(PKG_ROOT, "doc", p.file), "utf8")), p.file)]),
  ]
  for (const [name, text] of out) writeFileSync(join(dir, name), text)
  return out.map(([name]) => name)
}

if (import.meta.main) {
  const dir = process.argv[2]
  if (!dir || !existsSync(join(dir, ".git"))) {
    console.error("用法：npm run wiki -- <GitHub wiki 的本地克隆目录>（先 git clone https://github.com/Clark760/RTS-ARENA.wiki.git）")
    process.exit(1)
  }
  for (const f of syncWiki(dir)) console.log(`写好 ${f}`)
  console.log("到 wiki 目录里看一下改动，再 git add -A、git commit、git push")
}
