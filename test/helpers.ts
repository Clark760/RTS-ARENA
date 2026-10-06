// 测试用：不经过沙箱、直接在 Node 里跑的 bot
import type { Command, Commands, Entity, View } from "../src/api/bot-api.ts"
import type { BotCall, BotRunner } from "../src/core/types.ts"

const idOf = (u: Entity | number) => (typeof u === "number" ? u : u.id)

export function fnBot(onTick: (view: View, cmd: Commands) => void): BotRunner {
  return {
    start: (): BotCall => ({ commands: [], logs: [], fuel: 0, ms: 0 }),
    tick(viewJson: string): BotCall {
      const out: Command[] = []
      const cmd: Commands = {
        move: (u, x, y) => out.push({ kind: "move", unit: idOf(u), x, y }),
        attack: (u, t) => out.push({ kind: "attack", unit: idOf(u), target: idOf(t) }),
        attackMove: (u, x, y) => out.push({ kind: "attackMove", unit: idOf(u), x, y }),
        gather: (u, t) => out.push({ kind: "gather", unit: idOf(u), target: idOf(t) }),
        stop: (u) => out.push({ kind: "stop", unit: idOf(u) }),
        produce: (b, type) => out.push({ kind: "produce", building: idOf(b), type }),
        cancel: (b) => out.push({ kind: "cancel", building: idOf(b) }),
        build: (u, type, x, y) => out.push({ kind: "build", unit: idOf(u), type, x, y }),
      }
      onTick(JSON.parse(viewJson) as View, cmd)
      return { commands: out, logs: [], fuel: 0, ms: 0 }
    },
    dispose() {},
  }
}

export const idle = (): BotRunner => fnBot(() => {})
