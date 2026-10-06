// rts-arena view：用平台自带的已构建播放器（dist/viewer）看某个目录里的回放，不需要 Vite
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { extname, join, normalize, resolve, sep } from "node:path"
import { PKG_ROOT } from "../paths.ts"

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wasm": "application/wasm",
}

/** 起一个只监听本机的服务：/api/replays 列出回放，/replays/<文件名> 读回放，其余是播放器页面 */
export function serveViewer(replaysDir: string, port: number): void {
  const viewerDir = join(PKG_ROOT, "dist", "viewer")
  if (!existsSync(join(viewerDir, "index.html"))) {
    console.error("播放器还没构建：在平台目录里先跑 npm run build（开发时也可以直接 npm run viewer）")
    process.exit(1)
  }
  const replays = resolve(replaysDir)
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    const path = decodeURIComponent(url.pathname)
    if (path === "/api/replays") {
      const list = existsSync(replays)
        ? readdirSync(replays)
            .filter((n) => n.endsWith(".json"))
            .map((name) => {
              const st = statSync(join(replays, name))
              return { name, mtime: st.mtimeMs, size: st.size }
            })
            .sort((a, b) => b.mtime - a.mtime)
        : []
      res.setHeader("Content-Type", TYPES[".json"])
      res.end(JSON.stringify(list))
      return
    }
    if (path.startsWith("/replays/")) {
      const name = path.slice("/replays/".length)
      if (!/^[\w.-]+\.json$/.test(name) || !existsSync(join(replays, name))) return notFound(res)
      res.setHeader("Content-Type", TYPES[".json"])
      createReadStream(join(replays, name)).pipe(res)
      return
    }
    // 播放器的静态文件；不许跳出 viewerDir
    const file = normalize(join(viewerDir, path === "/" ? "index.html" : path))
    if (!file.startsWith(viewerDir + sep) || !existsSync(file) || !statSync(file).isFile()) return notFound(res)
    res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream")
    createReadStream(file).pipe(res)
  })
  server.on("error", (e: NodeJS.ErrnoException) => {
    console.error(e.code === "EADDRINUSE" ? `端口 ${port} 被占用了，换一个：rts-arena view --port ${port + 1}` : e.message)
    process.exit(1)
  })
  server.listen(port, "127.0.0.1", () => {
    console.log(`回放目录：${replays}`)
    console.log(`播放器：http://127.0.0.1:${port}/  （Ctrl+C 退出）`)
  })
}

function notFound(res: import("node:http").ServerResponse): void {
  res.statusCode = 404
  res.end("not found")
}
