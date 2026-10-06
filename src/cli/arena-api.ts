// 播放器页面用的本机接口：读回放、读日志、列出规则包和 bot、在后台跑比赛（调用命令行 run --json）。
// rts-arena view 和 Vite 开发服务器（npm run viewer）共用。只该监听 127.0.0.1。
import { spawn, type ChildProcess } from "node:child_process"
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import { basename, join, relative, resolve, sep } from "node:path"
import { BOT_EXPORT, discoverBots, uploadNameProblem } from "./bot-finder.ts"
import { leagueTables, teamSplits } from "./league.ts"
import { findRuleset, knownBots, listRulesets, loadRulesetRef, localBots, readWorkspaceIn, type RulesetRef } from "./catalog.ts"

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
/** 页面上传的 bot 文件最大多少字 */
const MAX_UPLOAD = 500_000
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

/** 对战页列表里要的规则包信息；自己写的规则包要在沙箱里加载才知道，按 index.ts 的修改时间缓存 */
const metaCache = new Map<string, { mtime: number; meta: { name: string; players: { min: number; max: number }; teams: boolean } }>()

async function rulesetMeta(src: RulesetRef) {
  const mtime = statSync(join(src.dir, "index.ts")).mtimeMs
  const hit = metaCache.get(src.dir)
  if (hit && hit.mtime === mtime) return hit.meta
  const r = await loadRulesetRef(src)
  const meta = { name: r.name, players: r.players, teams: r.teams === true }
  metaCache.set(src.dir, { mtime, meta })
  return meta
}

/** 读 bot 目录的 arena.json；坏了就当没有 */
function workspaceIn(dir: string) {
  try {
    return readWorkspaceIn(dir)
  } catch {
    return null
  }
}

export function createArenaApi(opts: ArenaApiOptions): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const replays = resolve(opts.replaysDir)
  const cwd = resolve(opts.cwd)
  /** 页面"从电脑选文件"上传的 bot 副本放这里（在回放目录里，bot 目录的 .gitignore 已经忽略了 replays/） */
  const uploads = join(replays, "uploaded-bots")
  let run: Run | null = null
  /** 平台自带的规则包，加上找到的 bot 目录里用到的自己写的规则包（id 是相对 cwd 的路径） */
  const rulesetRefs = () => {
    const found = discoverBots(cwd, uploads)
    return { found, refs: [...listRulesets().map((id) => findRuleset(id)!), ...found.rulesets] }
  }

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
      const workspace = workspaceIn(cwd)
      const { found, refs } = rulesetRefs()
      const rulesets = []
      const broken: string[] = []
      for (const src of refs) {
        try {
          rulesets.push({ id: src.ref, ...(await rulesetMeta(src)), bots: knownBots(src), external: !src.builtin })
        } catch (e) {
          broken.push(`${src.ref}：${(e as Error).message}`)
        }
      }
      send(res, 200, {
        rulesets,
        broken,
        workspace,
        // 这个 bot 目录用的规则包在 rulesets 里的 id
        here: found.here,
        localBots: localBots(cwd),
        botFiles: found.bots,
        running: run !== null && run.exitCode === null,
      })
      return true
    }

    // 上传 bot：存成 <回放目录>/uploaded-bots/<名字>.ts，名字就是比赛结果里显示的名字
    if (path === "/api/arena/upload" && req.method === "POST") {
      let body: { name?: unknown; content?: unknown; overwrite?: unknown }
      try {
        body = JSON.parse(await readBody(req, MAX_UPLOAD * 2))
      } catch {
        return send(res, 400, { error: `文件太大（最多 ${MAX_UPLOAD / 1000} K 字）或者请求不对` }), true
      }
      const { name, content, overwrite } = body
      if (typeof name !== "string") return send(res, 400, { error: "要给 bot 起个名字" }), true
      const stem = name.trim().replace(/\.ts$/, "")
      const bad = uploadNameProblem(stem)
      if (bad) return send(res, 400, { error: bad }), true
      if (typeof content !== "string" || content.length > MAX_UPLOAD) return send(res, 400, { error: `文件太大（最多 ${MAX_UPLOAD / 1000} K 字）` }), true
      if (!BOT_EXPORT.test(content)) return send(res, 400, { error: "这个文件里没有导出 onTick，不像 bot 文件" }), true
      const file = join(uploads, `${stem}.ts`)
      const rel = relative(cwd, file).split(sep).join("/")
      // 同名：内容一样直接用；不一样要明确说替换（同一个作者更新 bot 时就替换）
      if (existsSync(file) && readFileSync(file, "utf8") !== content && overwrite !== true)
        return send(res, 409, { error: `已经有一个叫 ${stem} 的 bot 了（内容不一样）`, exists: true, path: rel }), true
      mkdirSync(uploads, { recursive: true })
      writeFileSync(file, content)
      send(res, 200, { path: rel, name: stem })
      return true
    }

    // 给上传的副本改名（比赛结果里显示的名字跟着变；以前的回放里还是旧名字）
    if (path === "/api/arena/upload/rename" && req.method === "POST") {
      let body: { from?: unknown; name?: unknown }
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return send(res, 400, { error: "请求不是 JSON" }), true
      }
      if (typeof body.from !== "string" || typeof body.name !== "string") return send(res, 400, { error: "要给 from 和 name" }), true
      const from = resolve(cwd, body.from)
      if (!from.startsWith(uploads + sep) || !from.endsWith(".ts") || !existsSync(from)) return send(res, 400, { error: "只能给上传的 bot 改名" }), true
      const stem = body.name.trim().replace(/\.ts$/, "")
      const bad = uploadNameProblem(stem)
      if (bad) return send(res, 400, { error: bad }), true
      const to = join(uploads, `${stem}.ts`)
      if (to === from) return send(res, 200, { path: relative(cwd, to).split(sep).join("/"), name: stem }), true
      if (existsSync(to)) return send(res, 409, { error: `已经有一个叫 ${stem} 的 bot 了` }), true
      renameSync(from, to)
      send(res, 200, { path: relative(cwd, to).split(sep).join("/"), name: stem })
      return true
    }

    // 删除上传的副本（只能删 uploaded-bots 里的；正在跑的比赛用着的不能删）
    if (path === "/api/arena/upload/delete" && req.method === "POST") {
      let body: { path?: unknown }
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return send(res, 400, { error: "请求不是 JSON" }), true
      }
      if (typeof body.path !== "string") return send(res, 400, { error: "要给 path" }), true
      const file = resolve(cwd, body.path)
      if (!file.startsWith(uploads + sep) || !file.endsWith(".ts") || !existsSync(file)) return send(res, 400, { error: "只能删除上传的 bot" }), true
      if (run && run.exitCode === null && run.args.some((a) => resolve(cwd, a) === file))
        return send(res, 409, { error: "正在跑的比赛还要用它，等比赛结束或者先停止再删" }), true
      rmSync(file)
      send(res, 200, { ok: true })
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
      let body: { ruleset?: unknown; bots?: unknown; games?: unknown; seed?: unknown; teams?: unknown; mode?: unknown; perPair?: unknown; perTable?: unknown; size?: unknown; partners?: unknown }
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return send(res, 400, { error: "请求不是 JSON" }), true
      }
      const { ruleset, bots, games, seed, teams, mode, perPair, size } = body
      const perTable = body.perTable ?? perPair
      // 只认列表里有的规则包：平台自带的，和找到的 bot 目录里用到的
      const allowed = typeof ruleset === "string" && rulesetRefs().refs.some((r) => r.ref === ruleset)
      if (!allowed) return send(res, 400, { error: "规则包不对" }), true
      if (!Array.isArray(bots) || bots.length === 0 || bots.some((b) => typeof b !== "string" || b === "" || b.startsWith("-")))
        return send(res, 400, { error: "bot 列表不对" }), true
      if (seed !== undefined && seed !== null && !Number.isInteger(seed)) return send(res, 400, { error: "种子要是整数" }), true
      let args: string[]
      if (mode === "league") {
        // 联赛：各自为战（每局 size 个人），或者分队（teams 写 2v2 这样，partners 是 mixed 轮换搭档 / same 同一个 bot 组队）
        const list = bots as string[]
        if (list.length < 2 || list.length > 16) return send(res, 400, { error: "联赛要 2～16 个 bot" }), true
        if (new Set(list).size !== list.length) return send(res, 400, { error: "同一个 bot 选了两次" }), true
        let sizes: number[] | null = null
        if (teams !== undefined && teams !== null) {
          if (typeof teams !== "string" || !/^\d+(v\d+)+$/.test(teams)) return send(res, 400, { error: "分队要写成 2v2 这样" }), true
          sizes = teams.split("v").map(Number)
        }
        const k = sizes ? sizes.reduce((a, b) => a + b, 0) : size === undefined || size === null ? 2 : size
        if (!Number.isInteger(k) || (k as number) < 2) return send(res, 400, { error: "每局人数要是 2 以上的整数" }), true
        const partners = body.partners
        if (partners !== undefined && partners !== null && partners !== "mixed" && partners !== "same") return send(res, 400, { error: "搭档要是 mixed 或 same" }), true
        const lmode = !sizes ? "ffa" : partners === "same" ? "same" : partners === "mixed" || list.length >= (k as number) ? "mixed" : "same"
        const sides = sizes ? sizes.length : (k as number)
        const unit = lmode === "same" ? sides : (k as number)
        if (list.length < unit) return send(res, 400, { error: lmode === "mixed" ? `轮换搭档每局要 ${k} 个不同的 bot` : `每局 ${unit} 方，至少要 ${unit} 个 bot` }), true
        const tables = leagueTables(list.length, unit, 0).tables.length
        // 不给每桌局数：一轮（各自为战是座位轮换一圈；轮换搭档是每种分法都打、各队轮换位置）
        const cycle = lmode === "mixed" ? teamSplits([...Array(k as number).keys()], sizes!).length * (sizes!.every((x) => x === sizes![0]) ? sides : 1) : sides
        const per = perTable === undefined || perTable === null ? cycle : perTable
        if (!Number.isInteger(per) || (per as number) < 1 || (per as number) * tables > MAX_GAMES)
          return send(res, 400, { error: `每桌局数要是正整数，总局数（${tables} 桌 × 每桌局数）最多 ${MAX_GAMES}` }), true
        args = ["league", ruleset, ...list, ...(sizes ? ["--teams", teams as string, "--partners", lmode] : ["--size", String(k)]), "--per-table", String(per), "--out", replays, "--json"]
      } else {
        if (!Number.isInteger(games) || (games as number) < 1 || (games as number) > MAX_GAMES) return send(res, 400, { error: `局数要是 1~${MAX_GAMES} 的整数` }), true
        if (teams !== undefined && teams !== null && (typeof teams !== "string" || !/^\d+(v\d+)+$/.test(teams))) return send(res, 400, { error: "分队要写成 2v2 这样" }), true
        args = ["run", ruleset, ...(bots as string[]), "--games", String(games), "--out", replays, "--json"]
        if (typeof teams === "string") args.push("--teams", teams)
      }
      if (typeof seed === "number") args.push("--seed", String(seed))
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
            const ev = JSON.parse(line) as Record<string, unknown>
            // 联赛每局都发一次排名，只留最新的一份（不然长联赛会把事件数撑满，最后的汇总进不来）
            const old = ev.type === "standings" ? r.events.findIndex((x) => x.type === "standings") : -1
            if (old >= 0) r.events[old] = ev
            else if (r.events.length < MAX_EVENTS) r.events.push(ev)
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

function readBody(req: IncomingMessage, max = 100_000): Promise<string> {
  return new Promise((ok, fail) => {
    let s = ""
    req.setEncoding("utf8")
    req.on("data", (c: string) => {
      s += c
      if (s.length > max) {
        fail(new Error("请求太大"))
        req.destroy()
      }
    })
    req.on("end", () => ok(s))
    req.on("error", fail)
  })
}
