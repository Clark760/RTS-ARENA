// 播放器页面用的本机接口：读回放、读日志、列出规则包和 bot、在后台跑比赛（调用命令行 run --json）。
// rts-arena view 和 Vite 开发服务器（npm run viewer）共用。只该监听 127.0.0.1。
import { spawn, type ChildProcess } from "node:child_process"
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import { join, resolve } from "node:path"
import { importRuleset, knownBots, listRulesets, localBots, readWorkspaceIn } from "./catalog.ts"

export interface ArenaApiOptions {
  /** 回放和日志目录 */
  replaysDir: string
  /** 命令行入口（跑比赛时用 node 执行它） */
  cliPath: string
  /** 跑比赛的工作目录（bot 路径相对它解析，一般就是 bot 目录） */
  cwd: string
}

const JSON_TYPE = "application/json; charset=utf-8"
const MAX_GAMES = 1000
/** 一次比赛最多保留多少条事件（每局一条，够用） */
const MAX_EVENTS = MAX_GAMES + 10

interface Run {
  child: ChildProcess
  args: string[]
  events: Record<string, unknown>[]
  stderr: string
  exitCode: number | null
  cancelled: boolean
}

export function createArenaApi(opts: ArenaApiOptions): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const replays = resolve(opts.replaysDir)
  const cwd = resolve(opts.cwd)
  let run: Run | null = null

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status
    res.setHeader("Content-Type", JSON_TYPE)
    res.end(JSON.stringify(body))
  }

  const fileIn = (name: string, ext: RegExp) => (/^[\w.-]+$/.test(name) && ext.test(name) && existsSync(join(replays, name)) ? join(replays, name) : null)

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    const path = decodeURIComponent(url.pathname)

    // ---------- 读回放、日志 ----------
    if (path === "/api/replays" && req.method === "GET") {
      const list = existsSync(replays)
        ? readdirSync(replays)
            .filter((n) => n.endsWith(".json") && !n.endsWith(".series.json"))
            .map((name) => {
              const st = statSync(join(replays, name))
              return { name, mtime: st.mtimeMs, size: st.size }
            })
            .sort((a, b) => b.mtime - a.mtime)
        : []
      send(res, 200, list)
      return true
    }
    if (path.startsWith("/replays/") && req.method === "GET") {
      const file = fileIn(path.slice("/replays/".length), /\.json$/)
      if (!file) return false
      res.setHeader("Content-Type", JSON_TYPE)
      createReadStream(file).pipe(res)
      return true
    }
    if (path.startsWith("/logs/") && req.method === "GET") {
      const file = fileIn(path.slice("/logs/".length), /\.log$/)
      if (!file) return false
      res.setHeader("Content-Type", "text/plain; charset=utf-8")
      createReadStream(file).pipe(res)
      return true
    }

    // ---------- 对战页 ----------
    if (!path.startsWith("/api/arena")) return false
    // 只接受本页面发来的请求：带自定义请求头的跨站请求会被浏览器先做预检，这里不答应预检，别的网站就调不了
    if (req.method !== "GET" && req.headers["x-arena"] !== "1") {
      send(res, 403, { error: "缺少 X-Arena 请求头" })
      return true
    }

    if (path === "/api/arena" && req.method === "GET") {
      const rulesets = []
      for (const id of listRulesets()) {
        const r = await importRuleset(id)
        rulesets.push({ id, name: r.name, players: r.players, teams: r.teams === true, bots: knownBots(id) })
      }
      let workspace = null
      try {
        workspace = readWorkspaceIn(cwd)
      } catch {
        // arena.json 坏了就当没有
      }
      send(res, 200, { rulesets, workspace, localBots: localBots(cwd), running: run !== null && run.exitCode === null })
      return true
    }

    if (path === "/api/arena/series" && req.method === "GET") {
      const list = existsSync(replays)
        ? readdirSync(replays)
            .filter((n) => n.endsWith(".series.json"))
            .map((name) => ({ name, mtime: statSync(join(replays, name)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 50)
            .flatMap(({ name }) => {
              try {
                return [{ name, ...(JSON.parse(readFileSync(join(replays, name), "utf8")) as object) }]
              } catch {
                return [] // 正在写的文件可能读到一半
              }
            })
        : []
      send(res, 200, list)
      return true
    }

    if (path === "/api/arena/run" && req.method === "GET") {
      if (!run) return send(res, 200, { running: false }), true
      send(res, 200, { running: run.exitCode === null, exitCode: run.exitCode, cancelled: run.cancelled, args: run.args, events: run.events, stderr: run.stderr.slice(-4000) })
      return true
    }

    if (path === "/api/arena/run" && req.method === "POST") {
      if (run && run.exitCode === null) return send(res, 409, { error: "已经有一场比赛在跑，等它结束或先停止" }), true
      let body: { ruleset?: unknown; bots?: unknown; games?: unknown; seed?: unknown; teams?: unknown }
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return send(res, 400, { error: "请求不是 JSON" }), true
      }
      const { ruleset, bots, games, seed, teams } = body
      if (typeof ruleset !== "string" || !listRulesets().includes(ruleset)) return send(res, 400, { error: "规则包不对" }), true
      if (!Array.isArray(bots) || bots.length === 0 || bots.some((b) => typeof b !== "string" || b === "" || b.startsWith("-")))
        return send(res, 400, { error: "bot 列表不对" }), true
      if (!Number.isInteger(games) || (games as number) < 1 || (games as number) > MAX_GAMES) return send(res, 400, { error: `局数要是 1~${MAX_GAMES} 的整数` }), true
      if (seed !== undefined && seed !== null && !Number.isInteger(seed)) return send(res, 400, { error: "种子要是整数" }), true
      if (teams !== undefined && teams !== null && (typeof teams !== "string" || !/^\d+(v\d+)+$/.test(teams))) return send(res, 400, { error: "分队要写成 2v2 这样" }), true
      const args = ["run", ruleset, ...(bots as string[]), "--games", String(games), "--out", replays, "--json"]
      if (typeof seed === "number") args.push("--seed", String(seed))
      if (typeof teams === "string") args.push("--teams", teams)
      // 不经过 shell，参数原样传给命令行，不会被注入
      const child = spawn(process.execPath, [opts.cliPath, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] })
      const r: Run = { child, args, events: [], stderr: "", exitCode: null, cancelled: false }
      run = r
      let buf = ""
      child.stdout!.setEncoding("utf8")
      child.stdout!.on("data", (chunk: string) => {
        buf += chunk
        let i: number
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (!line) continue
          try {
            if (r.events.length < MAX_EVENTS) r.events.push(JSON.parse(line))
          } catch {
            r.stderr += line + "\n"
          }
        }
      })
      child.stderr!.setEncoding("utf8")
      child.stderr!.on("data", (chunk: string) => {
        r.stderr = (r.stderr + chunk).slice(-20000)
      })
      child.on("close", (code) => {
        r.exitCode = code ?? -1
      })
      send(res, 200, { ok: true, args })
      return true
    }

    if (path === "/api/arena/cancel" && req.method === "POST") {
      if (run && run.exitCode === null) {
        run.cancelled = true
        run.child.kill()
      }
      send(res, 200, { ok: true })
      return true
    }

    send(res, 404, { error: "没有这个接口" })
    return true
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let s = ""
    req.setEncoding("utf8")
    req.on("data", (c: string) => {
      s += c
      if (s.length > 100_000) {
        fail(new Error("请求太大"))
        req.destroy()
      }
    })
    req.on("end", () => ok(s))
    req.on("error", fail)
  })
}
