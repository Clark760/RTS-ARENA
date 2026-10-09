// 按玩家视野裁剪出 bot 看到的局面
import type { Entity, Order, View } from "../api/bot-api.ts"
import { statDiff, type World } from "./world.ts"

function copyOrder(o: Order): Order {
  return { ...o }
}

export function buildView(w: World, p: number): View {
  const entities: Entity[] = []
  for (const e of w.ents.values()) {
    if (!w.visibleTo(p, e)) continue
    const v: Entity = { id: e.id, type: e.type, owner: e.owner, x: e.x, y: e.y, w: e.w, h: e.h, hp: e.hp, maxHp: e.def.maxHp }
    if (e.def.kind === "resource") v.amount = e.amount
    // 规则包改过的数值（科技、增益……）：只给和 game.types 不一样的项，生命上限已经在 maxHp 里
    const st = statDiff(e.def, w.types[e.type])
    if (st) {
      const { maxHp: _, ...rest } = st
      if (Object.keys(rest).length) v.stats = rest
    }
    if (e.construction) v.construction = { ...e.construction }
    // 增益、减益（D-186）：看得到实体就看得到
    if (e.buffs.length) v.buffs = e.buffs.map((b) => (b.ticksLeft === null ? { name: b.name, damagePct: b.damagePct, defensePct: b.defensePct } : { name: b.name, damagePct: b.damagePct, defensePct: b.defensePct, ticksLeft: b.ticksLeft }))
    if (e.owner === p) {
      v.order = copyOrder(e.order)
      if (e.carrying) v.carrying = { ...e.carrying }
      if (e.def.produces.length > 0) v.queue = e.queue.map((q) => ({ ...q }))
      if (e.def.attack) v.cooldown = e.attackCd
      if (e.def.skills.length > 0) v.skillCooldowns = { ...e.skillCooldowns }
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
