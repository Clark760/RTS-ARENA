// 拆家速攻：只补 8 个工人，兵营一直出战士，凑够 6 个就不管控制点、直接去拆对方主基地，之后新出的兵跟上。
// 家里来敌人、而且还没出门时回防；出门的兵死光了就重新凑一波。

const MAX_WORKERS = 8
const WAVE = 6
let attacking = false

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
  const enemies = view.entities.filter((e) => e.owner >= 0 && e.owner !== view.me)
  const base = mine.find((e) => e.type === "base")
  if (!base) return
  const barracks = mine.find((e) => e.type === "barracks")
  const workers = mine.filter((e) => e.type === "worker")
  const army = mine.filter((e) => e.type === "soldier" || e.type === "archer")
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

  if (army.length >= WAVE) attacking = true
  if (army.length === 0) attacking = false

  if (!attacking) {
    const intruders = enemies.filter((e) => dist(e, base) <= 10)
    for (const u of army) {
      const t = nearest(u, intruders)
      if (t && (u.order?.kind !== "attack" || u.order.target !== t.id)) cmd.attack(u, t)
    }
    return
  }

  // 出门：一路打过去，看见对方主基地就直接打它
  const eb = view.objectives.enemyBases[0]
  const enemyBase = enemies.find((e) => e.type === "base")
  for (const u of army) {
    if (enemyBase && dist(u, enemyBase) <= 6) {
      if (u.order?.kind !== "attack" || u.order.target !== enemyBase.id) cmd.attack(u, enemyBase)
    } else if (u.order?.kind === "idle") cmd.attackMove(u, eb.x + 1, eb.y + 1)
  }
}
