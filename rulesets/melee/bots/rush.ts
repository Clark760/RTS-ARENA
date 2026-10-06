// 速攻：只补 8 个工人，兵营一直出战士，凑够 6 个就去拆离自己最近的敌人，拆完换下一家；认得盟友。
// 之后新出的兵在家凑够 4 个再去会合；还没出门的兵守家。

const MAX_WORKERS = 8
const WAVE = 6
const REINFORCE = 4
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
  const team = view.players[view.me].team
  const isEnemy = (owner: number) => owner >= 0 && view.players[owner].team !== team
  const mine = view.entities.filter((e) => e.owner === view.me)
  const enemies = view.entities.filter((e) => isEnemy(e.owner))
  const base = mine.find((e) => e.type === "base")
  if (!base) return
  const barracks = mine.find((e) => e.type === "barracks")
  const workers = mine.filter((e) => e.type === "worker")
  const army = mine.filter((e) => e.type === "soldier" || e.type === "archer")
  const goldmines = view.entities.filter((e) => e.type === "goldmine")
  let gold = view.resources.gold

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

  // 第一波凑够 WAVE 个一起走；之后新出的兵在家凑够 REINFORCE 个再去会合（不一个个送）
  for (const id of [...sent]) if (!army.some((u) => u.id === id)) sent.delete(id)
  const waiting = army.filter((u) => !sent.has(u.id))
  if (waiting.length >= (sent.size === 0 ? WAVE : REINFORCE)) for (const u of waiting) sent.add(u.id)

  // 目标：离自己主基地最近的、还没出局的敌人
  const target = nearest(base, view.objectives.enemyBases)
  const intruders = enemies.filter((e) => dist(e, base) <= 10)
  for (const u of army) {
    if (!sent.has(u.id) || !target) {
      const t = nearest(u, intruders)
      if (t && (u.order?.kind !== "attack" || u.order.target !== t.id)) cmd.attack(u, t)
      continue
    }
    const goal = { x: target.x + 1, y: target.y + 1 }
    const enemyBase = enemies.find((e) => e.type === "base" && e.owner === target.owner)
    if (enemyBase && dist(u, enemyBase) <= 6) {
      if (u.order?.kind !== "attack" || u.order.target !== enemyBase.id) cmd.attack(u, enemyBase)
    } else if (u.order?.kind === "idle" || (u.order?.kind === "attackMove" && (u.order.x !== goal.x || u.order.y !== goal.y))) cmd.attackMove(u, goal.x, goal.y)
  }
}
