// 对战页的 bot 下拉框：服务端找 bot 文件、按 bot 目录分组、标上用的规则包；上传副本
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { createArenaApi } from "../src/cli/arena-api.ts"
import { discoverBots } from "../src/cli/bot-finder.ts"

const ROOT = join(import.meta.dirname, "..")
const CLI = join(ROOT, "src", "cli", "arena.ts")
const TMP = mkdtempSync(join(tmpdir(), "rts-arena-finder-"))
after(() => rmSync(TMP, { recursive: true, force: true }))

const sh = (args: string[], cwd: string) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" })
  assert.equal(r.status, 0, r.stdout + r.stderr)
}

// start.bat 那样的布局：几个 bot 目录并排，一个用自己写的规则包
sh(["init", "annihilation", "my-bot"], TMP)
sh(["init", "annihilation", "my-bot2"], TMP)
sh(["new-rules", "gold"], TMP)
sh(["init", "./gold", "my-gold"], TMP)
mkdirSync(join(TMP, "my-bot", "v2"))
cpSync(join(ROOT, "bots", "annihilation", "rush.ts"), join(TMP, "my-bot", "v2", "bot.ts"))
cpSync(join(ROOT, "bots", "annihilation", "boom.ts"), join(TMP, "my-bot2", "boom.ts"))
writeFileSync(join(TMP, "my-bot", "helper.ts"), "export const notABot = 1\n")

test("找 bot：本目录和子文件夹、旁边的 bot 目录；不是 bot 的 .ts 不算；标上各自的规则包", () => {
  const { bots, rulesets, here } = discoverBots(join(TMP, "my-bot"), join(TMP, "my-bot", "replays", "uploaded-bots"))
  assert.equal(here, "annihilation")
  assert.deepEqual(
    bots.map((b) => [b.group, b.path, b.ruleset]),
    [
      ["这个 bot 目录", "bot.ts", "annihilation"],
      ["这个 bot 目录", "v2/bot.ts", "annihilation"],
      ["bot 目录 ../my-bot2", "../my-bot2/boom.ts", "annihilation"],
      ["bot 目录 ../my-bot2", "../my-bot2/bot.ts", "annihilation"],
      ["bot 目录 ../my-gold", "../my-gold/bot.ts", "../gold"],
    ],
  )
  // 规则包目录本身不当成 bot 来源（它的 bots/ 是"现成"的那一组）
  assert.deepEqual(
    rulesets.map((r) => r.ref),
    ["../gold"],
  )
})

test("找 bot：在上一层（不是 bot 目录）打开时，下面的各个 bot 目录都找得到", () => {
  const { bots, here } = discoverBots(TMP, join(TMP, "replays", "uploaded-bots"))
  assert.equal(here, null)
  assert.ok(bots.some((b) => b.path === "my-bot/v2/bot.ts" && b.group === "bot 目录 my-bot"))
  assert.ok(bots.some((b) => b.path === "my-gold/bot.ts" && b.ruleset === "./gold"))
  assert.ok(!bots.some((b) => b.path.startsWith("gold/")))
})

test("对战接口：列出找到的 bot；上传的 bot 存成副本，能直接开比赛；不是 bot 的文件被拒", async () => {
  const cwd = join(TMP, "my-bot")
  const api = createArenaApi({ replaysDir: join(cwd, "replays"), cliPath: CLI, cwd })
  const server = createServer(async (req, res) => {
    if (!(await api(req, res))) {
      res.statusCode = 404
      res.end()
    }
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", "X-Arena": "1" }, body: JSON.stringify(body) })
  try {
    const info = (await (await fetch(base + "/api/arena")).json()) as { here: string; botFiles: { path: string }[]; rulesets: { id: string }[] }
    assert.equal(info.here, "annihilation")
    assert.ok(info.botFiles.some((b) => b.path === "../my-bot2/boom.ts"))
    assert.ok(info.rulesets.some((r) => r.id === "../gold"))

    const code = "export function onTick(view: View, cmd: Commands): void {}\n"
    assert.equal((await post("/api/arena/upload", { name: "notes", content: "const x = 1" })).status, 400)
    // 名字：不能叫 bot，不能有路径和奇怪的字符
    assert.equal((await post("/api/arena/upload", { name: "bot", content: code })).status, 400)
    assert.equal((await post("/api/arena/upload", { name: "../evil", content: code })).status, 400)
    const up = await post("/api/arena/upload", { name: "张三", content: code })
    assert.equal(up.status, 200)
    const { path } = (await up.json()) as { path: string }
    assert.equal(path, "replays/uploaded-bots/张三.ts")
    const again = (await (await fetch(base + "/api/arena")).json()) as { botFiles: { path: string; group: string; label?: string; uploaded?: boolean }[] }
    assert.ok(again.botFiles.some((b) => b.path === path && b.group === "从电脑选的（副本）" && b.label === "张三" && b.uploaded))
    // 同名：内容一样直接用；不一样要说替换
    assert.equal((await post("/api/arena/upload", { name: "张三", content: code })).status, 200)
    const v2 = code + "// 新版\n"
    const conflict = await post("/api/arena/upload", { name: "张三", content: v2 })
    assert.equal(conflict.status, 409)
    assert.equal(((await conflict.json()) as { exists: boolean }).exists, true)
    assert.equal((await post("/api/arena/upload", { name: "张三", content: v2, overwrite: true })).status, 200)
    assert.equal(readFileSync(join(cwd, path), "utf8"), v2)
    // 改名：只能改上传的；新名字被占了不行
    await post("/api/arena/upload", { name: "李四", content: code })
    assert.equal((await post("/api/arena/upload/rename", { from: "bot.ts", name: "王五" })).status, 400)
    assert.equal((await post("/api/arena/upload/rename", { from: path, name: "李四" })).status, 409)
    const renamed = await post("/api/arena/upload/rename", { from: path, name: "王五" })
    assert.equal(renamed.status, 200)
    assert.equal(((await renamed.json()) as { path: string }).path, "replays/uploaded-bots/王五.ts")
    assert.ok(!existsSync(join(cwd, path)))
    const renamedPath = "replays/uploaded-bots/王五.ts"

    // 隔壁目录的规则包也能直接选来开比赛
    assert.equal((await post("/api/arena/run", { ruleset: "../gold", bots: ["../my-gold/bot.ts", renamedPath], games: 1, seed: 1 })).status, 200)
    let run: { running: boolean; exitCode: number; stderr: string }
    for (;;) {
      run = (await (await fetch(base + "/api/arena/run")).json()) as typeof run
      if (!run.running) break
      await new Promise((r) => setTimeout(r, 200))
    }
    assert.equal(run.exitCode, 0, run.stderr)
  } finally {
    server.close()
  }
})
