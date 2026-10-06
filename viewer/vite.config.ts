// 开发服务器（npm run viewer）：页面接口和 rts-arena view 共用 src/cli/arena-api.ts，回放目录是仓库的 replays/
import { join } from "node:path"
import { defineConfig } from "vite"
import { createArenaApi } from "../src/cli/arena-api.ts"

const ROOT = join(import.meta.dirname, "..")

export default defineConfig({
  server: { port: 5180, host: "127.0.0.1" },
  build: { target: "es2022" },
  plugins: [
    {
      name: "arena-api",
      configureServer(server) {
        const api = createArenaApi({ replaysDir: join(ROOT, "replays"), cliPath: join(ROOT, "src", "cli", "arena.ts"), cwd: ROOT })
        server.middlewares.use((req, res, next) => {
          api(req, res).then((handled) => (handled ? undefined : next()), next)
        })
      },
    },
  ],
})
