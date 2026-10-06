// rts-arena view：用平台自带的已构建播放器（dist/viewer）看某个目录里的回放，也能在"对战"页跑比赛；不需要 Vite
import { createReadStream, existsSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { extname, join, normalize, resolve, sep } from "node:path"
import { PKG_ROOT } from "../paths.ts"
import { createArenaApi } from "./arena-api.ts"

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wasm": "application/wasm",
}

/** 起一个只监听本机的服务：接口见 arena-api.ts，其余是播放器页面 */
export function serveViewer(replaysDir: string, port: number, cliPath: string): void {
  const viewerDir = join(PKG_ROOT, "dist", "viewer")
  if (!existsSync(join(viewerDir, "index.html"))) {
    console.error("播放器还没构建：在平台目录里先跑 npm run build（开发时也可以直接 npm run viewer）")
    process.exit(1)
  }
  const replays = resolve(replaysDir)
  const api = createArenaApi({ replaysDir: replays, cliPath, cwd: process.cwd() })
  const server = createServer(async (req, res) => {
    try {
      if (await api(req, res)) return
    } catch (e) {
      res.statusCode = 500
      res.end(String((e as Error).message))
      return
    }
    // 播放器的静态文件；不许跳出 viewerDir
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname)
    const file = normalize(join(viewerDir, path === "/" ? "index.html" : path))
    if (!file.startsWith(viewerDir + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404
      res.end("not found")
      return
    }
    res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream")
    createReadStream(file).pipe(res)
  })
  server.on("error", (e: NodeJS.ErrnoException) => {
    console.error(e.code === "EADDRINUSE" ? `端口 ${port} 被占用了，换一个：rts-arena view --port ${port + 1}` : e.message)
    process.exit(1)
  })
  server.listen(port, "127.0.0.1", () => {
    console.log(`回放目录：${replays}`)
    console.log(`播放器：http://127.0.0.1:${port}/  （"对战"页可以选规则包和 bot 跑比赛；Ctrl+C 退出）`)
  })
}
