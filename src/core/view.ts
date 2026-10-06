// 按玩家视野裁剪出 bot 看到的局面
import type { Entity, Order, View } from "../api/bot-api.ts"
import type { World } from "./world.ts"

function copyOrder(o: Order): Order {
  return { ...o }
}

export function buildView(w: World, p: number): View {
  const entities: Entity[] = []
  for (const e of w.ents.values()) {
    if (!w.visibleTo(p, e)) continue
    const v: Entity = { id: e.id, type: e.type, owner: e.owner, x: e.x, y: e.y, w: e.w, h: e.h, hp: e.hp, maxHp: e.def.maxHp }
    if (e.def.kind === "resource") v.amount = e.amount
    if (e.owner === p) {
      v.order = copyOrder(e.order)
      if (e.carrying) v.carrying = { ...e.carrying }
      if (e.def.produces.length > 0) v.queue = e.queue.map((q) => ({ ...q }))
      if (e.def.attack) v.cooldown = e.attackCd
    }
    entities.push(v)
  }
  entities.sort((a, b) => a.id - b.id)
  const player = w.players[p]
  const events = player.pending
  player.pending = []
  return {
    tick: w.tick,
    me: p,
    resources: { ...player.resources },
    players: w.playerInfos(),
    entities,
    objectives: w.rules.objectives(w, p),
    events,
  }
}
