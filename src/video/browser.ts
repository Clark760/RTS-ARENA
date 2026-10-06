// 视频渲染用的无头浏览器：用本机装好的 Chrome / Edge（不下载浏览器），通过调试协议（CDP）控制。
// 页面从本机的 http://127.0.0.1 打开（WebCodecs 只在安全上下文里能用，about:blank 不行）
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** 常见的安装位置；也可以用环境变量 RTS_ARENA_BROWSER 或 --browser 指定 */
const CANDIDATES = [
  process.env.RTS_ARENA_BROWSER,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
]

export function findBrowser(explicit?: string): string | null {
  for (const p of [explicit, ...CANDIDATES]) if (p && existsSync(p)) return p
  return null
}

export interface Browser {
  /** 在页面里执行一段表达式（可以是 Promise），返回 JSON 化的结果 */
  evaluate<T = unknown>(expression: string): Promise<T>
  close(): Promise<void>
}

export async function launchBrowser(executable: string): Promise<Browser> {
  // 一个空白页面：只为了让页面是 http://127.0.0.1（安全上下文）
  const server: Server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8")
    res.end('<!doctype html><meta charset="utf-8"><title>rts-arena video</title><body style="margin:0;background:#000"></body>')
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  const profile = mkdtempSync(join(tmpdir(), "rts-arena-video-"))
  const proc: ChildProcess = spawn(executable, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--mute-audio", url], {
    stdio: "ignore",
  })
  const cleanup = () => {
    proc.kill()
    server.close()
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      // 浏览器还没完全退出时目录可能删不掉，留给系统清理
    }
  }
  try {
    let port = ""
    for (let i = 0; i < 150 && !port; i++) {
      await new Promise((r) => setTimeout(r, 100))
      const f = join(profile, "DevToolsActivePort")
      if (existsSync(f)) port = readFileSync(f, "utf8").split("\n")[0].trim()
    }
    if (!port) throw new Error(`浏览器没有启动调试端口（${executable}）`)
    let wsUrl = ""
    for (let i = 0; i < 50 && !wsUrl; i++) {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[]
      wsUrl = list.find((t) => t.type === "page" && t.url.startsWith(url))?.webSocketDebuggerUrl ?? ""
      if (!wsUrl) await new Promise((r) => setTimeout(r, 100))
    }
    if (!wsUrl) throw new Error("找不到浏览器页面")
    const ws = new WebSocket(wsUrl)
    await new Promise<void>((ok, bad) => {
      ws.addEventListener("open", () => ok())
      ws.addEventListener("error", () => bad(new Error("连不上浏览器的调试端口")))
    })
    let next = 0
    const pending = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>()
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } }
      if (m.id !== undefined) {
        pending.get(m.id)?.(m)
        pending.delete(m.id)
      }
    })
    const send = (method: string, params: Record<string, unknown>) =>
      new Promise<{ result?: unknown; error?: { message: string } }>((ok) => {
        const id = ++next
        pending.set(id, ok)
        ws.send(JSON.stringify({ id, method, params }))
      })
    const evalRaw = async (expression: string) => {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
      return (r.result as { result?: { value?: unknown } } | undefined)?.result?.value
    }
    // 连上的时候页面可能还停在空白页：等它真的打开了本机地址（安全上下文）再用
    for (let i = 0; i < 100; i++) {
      if ((await evalRaw(`location.href.startsWith(${JSON.stringify(url)}) && document.readyState === "complete" && isSecureContext`)) === true) break
      await new Promise((r) => setTimeout(r, 100))
    }
    return {
      async evaluate<T>(expression: string): Promise<T> {
        const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
        if (r.error) throw new Error(`浏览器出错：${r.error.message}`)
        const res = r.result as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } }
        if (res.exceptionDetails) throw new Error(`页面脚本出错：${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`)
        return res.result?.value as T
      },
      async close() {
        ws.close()
        cleanup()
      },
    }
  } catch (e) {
    cleanup()
    throw e
  }
}
