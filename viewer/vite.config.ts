// 开发服务器顺带提供 replays/ 目录：/api/replays 列出回放，/replays/<文件名> 读取
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { defineConfig } from "vite"

const REPLAYS = join(import.meta.dirname, "..", "replays")

export default defineConfig({
  server: { port: 5180, host: "127.0.0.1" },
  build: { target: "es2022" },
  plugins: [
    {
      name: "arena-replays",
      configureServer(server) {
        server.middlewares.use("/api/replays", (_req, res) => {
          const list = existsSync(REPLAYS)
            ? readdirSync(REPLAYS)
                .filter((n) => n.endsWith(".json"))
                .map((name) => {
                  const st = statSync(join(REPLAYS, name))
                  return { name, mtime: st.mtimeMs, size: st.size }
                })
                .sort((a, b) => b.mtime - a.mtime)
            : []
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify(list))
        })
        server.middlewares.use("/replays", (req, res, next) => {
          const name = decodeURIComponent((req.url ?? "").replace(/^\//, "").split("?")[0])
          if (!/^[\w.-]+\.json$/.test(name) || !existsSync(join(REPLAYS, name))) return next()
          res.setHeader("Content-Type", "application/json")
          createReadStream(join(REPLAYS, name)).pipe(res)
        })
      },
    },
  ],
})
