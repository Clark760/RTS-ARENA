// 校验并执行 bot 的命令；不合法的命令变成 rejected 事件交还给 bot
import type { Command } from "../api/bot-api.ts"
import { canHit } from "./sim.ts"
import type { EntityState } from "./types.ts"
import type { World } from "./world.ts"

/** 每次调用最多处理多少条命令 */
export const MAX_COMMANDS = 2000
/** 生产队列上限 */
export const MAX_QUEUE = 5

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v)
}

/** 换命令；和当前命令完全相同时什么都不做（重复下命令不会打断进度或重新规划路线） */
function resetOrder(e: EntityState, order: EntityState["order"]): void {
  const cur = e.order as Record<string, unknown>
  const next = order as Record<string, unknown>
  if (Object.keys(next).every((k) => k === "returning" || cur[k] === next[k]) && cur.kind === next.kind) return
  e.order = order
  e.path.length = 0
  e.pathKey = ""
  e.stuck = 0
  e.want = -1
  e.gatherCd = 0
}

/** 执行玩家 p 的一批命令，返回被拒绝的 [命令, 原因] */
export function applyCommands(w: World, p: number, raw: unknown[]): [unknown, string][] {
  const rejected: [unknown, string][] = []
  const list = raw.length > MAX_COMMANDS ? raw.slice(0, MAX_COMMANDS) : raw
  for (const c of list) {
    const reason = applyOne(w, p, c)
    if (reason) {
      rejected.push([c, reason])
      w.pushEvent(p, { kind: "rejected", tick: w.tick, command: c as Command, reason })
    }
  }
  if (raw.length > MAX_COMMANDS) {
    const reason = `一次最多 ${MAX_COMMANDS} 条命令，后面 ${raw.length - MAX_COMMANDS} 条被丢弃`
    rejected.push([null, reason])
    w.pushEvent(p, { kind: "rejected", tick: w.tick, command: raw[MAX_COMMANDS] as Command, reason })
  }
  return rejected
}

function applyOne(w: World, p: number, c: unknown): string | null {
  if (c === null || typeof c !== "object") return "命令格式不对"
  const cmd = c as Record<string, unknown>
  const kind = cmd.kind
  const actorId = kind === "produce" || kind === "cancel" ? cmd.building : cmd.unit
  if (!isInt(actorId)) return "unit / building 必须是实体或整数 id"
  const e = w.ents.get(actorId)
  // 不存在和不是你的用同一句话，否则 bot 能拿 id 探测看不见的敌人是否还活着
  if (!e || e.owner !== p) return `你没有 #${actorId} 这个实体（可能已经死了）`

  switch (kind) {
    case "move": {
      if (e.def.moveTicks <= 0) return `#${e.id}（${e.type}）不能移动`
      const err = checkXY(w, cmd.x, cmd.y)
      if (err) return err
      resetOrder(e, { kind: "move", x: cmd.x as number, y: cmd.y as number })
      return null
    }
    case "attackMove": {
      if (e.def.moveTicks <= 0) return `#${e.id}（${e.type}）不能移动`
      if (!e.def.attack) return `#${e.id}（${e.type}）不能攻击，请用 move`
      const err = checkXY(w, cmd.x, cmd.y)
      if (err) return err
      resetOrder(e, { kind: "attackMove", x: cmd.x as number, y: cmd.y as number })
      return null
    }
    case "attack": {
      if (!e.def.attack) return `#${e.id}（${e.type}）不能攻击`
      if (!isInt(cmd.target)) return "target 必须是实体或整数 id"
      const t = w.ents.get(cmd.target)
      if (!t || !w.visibleTo(p, t)) return `看不到目标 #${cmd.target}`
      if (!canHit(e, t)) return `不能攻击 #${t.id}（${t.type}）：自己的、资源点或无敌`
      if (e.def.moveTicks <= 0 && w.dist(e, t) > e.def.attack.range) return `#${e.id} 不能移动，#${t.id} 在射程外`
      resetOrder(e, { kind: "attack", target: t.id })
      return null
    }
    case "gather": {
      if (!e.def.gather) return `#${e.id}（${e.type}）不能采集`
      if (!isInt(cmd.target)) return "target 必须是实体或整数 id"
      const t = w.ents.get(cmd.target)
      if (!t || !w.visibleTo(p, t)) return `看不到资源点 #${cmd.target}`
      if (t.def.kind !== "resource") return `#${t.id}（${t.type}）不是资源点`
      resetOrder(e, { kind: "gather", target: t.id, returning: false })
      return null
    }
    case "stop":
      resetOrder(e, { kind: "idle" })
      return null
    case "produce": {
      const type = cmd.type
      if (typeof type !== "string" || !w.types[type]) return `没有 "${String(type)}" 这种类型`
      if (!e.def.produces.includes(type)) return `#${e.id}（${e.type}）不能生产 ${type}`
      if (e.queue.length >= MAX_QUEUE) return `生产队列已满（最多 ${MAX_QUEUE} 个）`
      const def = w.types[type]
      const cap = w.rules.unitCap
      if (cap > 0 && def.kind === "unit" && w.unitCount(p) >= cap) return `单位数已到上限 ${cap}（含生产队列）`
      const res = w.players[p].resources
      for (const [r, n] of Object.entries(def.cost)) {
        if ((res[r] ?? 0) < (n ?? 0)) return `${r} 不够：需要 ${n}，现有 ${res[r] ?? 0}`
      }
      for (const [r, n] of Object.entries(def.cost)) res[r] -= n ?? 0
      e.queue.push({ type, ticksLeft: def.buildTicks })
      return null
    }
    case "cancel": {
      const q = e.queue.pop()
      if (!q) return `#${e.id} 的生产队列是空的`
      const res = w.players[p].resources
      for (const [r, n] of Object.entries(w.types[q.type].cost)) res[r] += n ?? 0
      return null
    }
    default:
      return `未知命令 "${String(kind)}"`
  }
}

function checkXY(w: World, x: unknown, y: unknown): string | null {
  if (!isInt(x) || !isInt(y)) return "x、y 必须是整数"
  if (!w.inBounds(x, y)) return `(${x}, ${y}) 在地图外（地图 ${w.width}×${w.height}）`
  return null
}
