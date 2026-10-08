// 同步到 GitHub wiki：链接改成 wiki 页面或 GitHub 地址，代码块不动；首页、侧栏列出每一页
import assert from "node:assert/strict"
import { test } from "node:test"
import { REPO, toWiki, wikiHome, wikiSidebar, WIKI_PAGES } from "../src/cli/wiki.ts"

test("wiki：同步的文档互相链接换成页面名，链到仓库的换成 GitHub 地址，代码块不动", () => {
  const md = [
    "看 [写 bot 指南](写-bot-指南.md)，安装见 [README](../README.md#安装)，设计见 [设计](设计.md)，外链 [x](https://a.b/c) 不动。",
    "![回放](images/replay.jpg)，`players[].name` 不是链接。",
    "```ts",
    "const a = [1](写-bot-指南.md)",
    "```",
  ].join("\n")
  const out = toWiki(md)
  assert.match(out, /\[写 bot 指南\]\(写-bot-指南\)/)
  assert.ok(out.includes(`[README](${REPO}#安装)`))
  assert.ok(out.includes(`[设计](${REPO}/blob/main/doc/设计.md)`))
  assert.ok(out.includes("[x](https://a.b/c)"))
  assert.ok(out.includes("![回放](https://raw.githubusercontent.com/Clark760/RTS-ARENA/main/doc/images/replay.jpg)"), "图片用原始文件地址")
  assert.ok(out.includes("`players[].name` 不是链接"))
  assert.ok(out.includes("const a = [1](写-bot-指南.md)"), "代码块里的不改")
  for (const p of WIKI_PAGES) {
    assert.ok(wikiHome().includes(`](${p.page})`))
    assert.ok(wikiSidebar().includes(`](${p.page})`))
  }
})
