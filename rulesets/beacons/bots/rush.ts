// 速攻：不建烽火台、不打野怪，工人补到 5 个采金，兵营一直出战士，凑够 5 个就去拆对方主基地（拆掉直接赢），之后新兵在家凑够 3 个再去会合。
// 还没出门的兵守家；路上碰到对方的兵先打兵，到了对方家门口直接打主基地。

const MAX_WORKERS = 5
const WAVE = 5
const REINFORCE = 3
/** 已经派出门的兵 */
const sent = new Set<number>()

function nearest<T extends Pos>(from: Pos, list: T[]): T | undefined {
  let best: T | undefined
  let bestD = Infinity
  for (const e of list) {
    const d = dist(from, e)
    if (d < bestD) {
      best = e
      bestD = d
    }
  }
  return best
}

export function onTick(view: View, cmd: Commands): void {
  const mine = view.entities.filter((e) => e.owner === view.me)
  const base = mine.find((e) => e.type === "base")
  if (!base) return
  const barracks = mine.find((e) => e.type === "barracks" && !e.construction)
  const workers = mine.filter((e) => e.type === "worker")
  const army = mine.filter((e) => e.type === "soldier")
  const enemies = view.entities.filter((e) => e.owner >= 0 && e.owner !== view.me)
  const goldmines = view.entities.filter((e) => e.type === "goldmine")
  let gold = view.resources.gold

  // 工人：没在采的去离主基地近、人少的矿
  const load = new Map<number, number>()
  for (const w of workers) if (w.order?.kind === "gather") load.set(w.order.target, (load.get(w.order.target) ?? 0) + 1)
  for (const w of workers) {
    if (w.order?.kind === "gather") continue
    const open = goldmines.filter((m) => (load.get(m.id) ?? 0) < 3)
    const m = nearest(base, open.length ? open : goldmines)
    if (!m) continue
    cmd.gather(w, m)
    load.set(m.id, (load.get(m.id) ?? 0) + 1)
  }
  if ((base.queue?.length ?? 0) === 0 && workers.length < MAX_WORKERS && gold >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }
  const soldierCost = game.types.soldier.cost.gold ?? 0
  if (barracks && (barracks.queue?.length ?? 0) < 2 && gold >= soldierCost) cmd.produce(barracks, "soldier")

  // 第一波凑够 WAVE 个一起走，之后的援兵凑够 REINFORCE 个再走
  for (const id of [...sent]) if (!army.some((u) => u.id === id)) sent.delete(id)
  const waiting = army.filter((u) => !sent.has(u.id))
  if (waiting.length >= (sent.size === 0 ? WAVE : REINFORCE)) for (const u of waiting) sent.add(u.id)

  const eb = view.objectives.enemyBase
  const goal = { x: eb.x + 1, y: eb.y + 1 }
  const enemyBase = enemies.find((e) => e.type === "base")
  const intruders = enemies.filter((e) => game.types[e.type].kind === "unit" && dist(e, base) <= 10)
  for (const u of army) {
    if (!sent.has(u.id)) {
      const t = nearest(u, intruders)
      if (t && (u.order?.kind !== "attack" || u.order.target !== t.id)) cmd.attack(u, t)
      continue
    }
    const fighters = enemies.filter((e) => game.types[e.type].kind === "unit" && dist(e, u) <= 4)
    const t = enemyBase && dist(u, enemyBase) <= 6 ? enemyBase : nearest(u, fighters)
    if (t) {
      if (u.order?.kind !== "attack" || u.order.target !== t.id) cmd.attack(u, t)
    } else if (u.order?.kind !== "attackMove" || u.order.x !== goal.x || u.order.y !== goal.y) cmd.attackMove(u, goal.x, goal.y)
  }
}
