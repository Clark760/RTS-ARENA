// 播放器服务的对战接口：开一场、等它跑完、汇总和文件都在
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createArenaApi } from "../src/cli/arena-api.ts"

const ROOT = join(import.meta.dirname, "..")

test("对战接口：开 2 局、看进度、汇总和回放日志都写出来", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rts-arena-api-"))
  const api = createArenaApi({ replaysDir: dir, cliPath: join(ROOT, "src", "cli", "arena.ts"), cwd: ROOT })
  const server = createServer(async (req, res) => {
    if (!(await api(req, res))) {
      res.statusCode = 404
      res.end()
    }
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (path: string, body: unknown, headers: Record<string, string> = { "X-Arena": "1" }) =>
    fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) })
  try {
    const info = (await (await fetch(base + "/api/arena")).json()) as { rulesets: { id: string; bots: string[] }[] }
    assert.ok(info.rulesets.some((r) => r.id === "koth" && r.bots.includes("baseline")))

    // 没有 X-Arena 请求头的写操作被拒（防别的网站借浏览器调用）
    assert.equal((await post("/api/arena/run", {}, {})).status, 403)
    assert.equal((await post("/api/arena/run", { ruleset: "koth", bots: ["baseline"], games: 0 })).status, 400)

    assert.equal((await post("/api/arena/run", { ruleset: "koth", bots: ["baseline", "idle"], games: 2, seed: 1 })).status, 200)
    let run: { running: boolean; exitCode: number; events: { type: string }[] }
    for (;;) {
      run = (await (await fetch(base + "/api/arena/run")).json()) as typeof run
      if (!run.running) break
      await new Promise((r) => setTimeout(r, 200))
    }
    assert.equal(run.exitCode, 0)
    assert.deepEqual(
      run.events.map((e) => e.type),
      ["start", "game", "game", "summary"],
    )
    const files = readdirSync(dir)
    assert.equal(files.filter((f) => f.endsWith(".series.json")).length, 1)
    assert.equal(files.filter((f) => f.endsWith(".log")).length, 4)
    const replays = (await (await fetch(base + "/api/replays")).json()) as { name: string }[]
    assert.equal(replays.length, 2, "回放列表里不该混进 .series.json")
    const series = (await (await fetch(base + "/api/arena/series")).json()) as { summary: { participants: { wins: number }[] } }[]
    assert.equal(series[0].summary.participants[0].wins, 2)
    const log = files.find((f) => f.endsWith(".log"))!
    assert.match(await (await fetch(`${base}/logs/${log}`)).text(), /对局日志/)
    assert.equal((await fetch(`${base}/logs/..%2Fpackage.json`)).status, 404)
  } finally {
    server.close()
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

test("对战接口：bot 目录用自己写的规则包，列表里有它，也能开比赛", async () => {
  const root = mkdtempSync(join(tmpdir(), "rts-arena-api-rules-"))
  const cli = join(ROOT, "src", "cli", "arena.ts")
  const sh = (args: string[], cwd: string) => {
    const r = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" })
    assert.equal(r.status, 0, r.stdout + r.stderr)
  }
  sh(["new-rules", "gold"], root)
  sh(["init", "./gold", "me"], root)
  const cwd = join(root, "me")
  const api = createArenaApi({ replaysDir: join(cwd, "replays"), cliPath: cli, cwd })
  const server = createServer(async (req, res) => {
    if (!(await api(req, res))) {
      res.statusCode = 404
      res.end()
    }
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const info = (await (await fetch(base + "/api/arena")).json()) as { rulesets: { id: string; name: string; external?: boolean; bots: string[] }[] }
    const mine = info.rulesets.find((r) => r.id === "../gold")
    assert.ok(mine?.external, JSON.stringify(info.rulesets.map((r) => r.id)))
    assert.deepEqual(mine.bots, ["baseline", "greedy", "rush", "idle"])
    // 不是自带的、也不是 arena.json 里写的规则包路径，不给跑
    const post = (body: unknown) => fetch(base + "/api/arena/run", { method: "POST", headers: { "Content-Type": "application/json", "X-Arena": "1" }, body: JSON.stringify(body) })
    assert.equal((await post({ ruleset: "../../somewhere", bots: ["bot.ts", "baseline"], games: 1 })).status, 400)
    assert.equal((await post({ ruleset: "../gold", bots: ["bot.ts", "baseline"], games: 1, seed: 3 })).status, 200)
    let run: { running: boolean; exitCode: number; events: { type: string }[]; stderr: string }
    for (;;) {
      run = (await (await fetch(base + "/api/arena/run")).json()) as typeof run
      if (!run.running) break
      await new Promise((r) => setTimeout(r, 200))
    }
    assert.equal(run.exitCode, 0, run.stderr)
    assert.deepEqual(
      run.events.map((e) => e.type),
      ["start", "game", "summary"],
    )
  } finally {
    server.close()
    rmSync(root, { recursive: true, force: true })
  }
})
