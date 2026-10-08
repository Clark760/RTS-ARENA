// 骑兵突袭：工人只补到 8 个，兵营只出骑兵（走得快），凑够 4 个就冲过去，先杀看得见的工人和弓兵，再拆主基地。

const MAX_WORKERS = 8
const WAVE = 4
let attacking = false

function nearest<T extends Pos>(from: Pos, list: T[]): T | undefined {
  let best: T | undefined
  for (const e of list) if (!best || dist(from, e) < dist(from, best)) best = e
  return best
}

export function onTick(view: View, cmd: Commands): void {
  const mine = view.entities.filter((e) => e.owner === view.me)
  const enemies = view.entities.filter((e) => e.owner >= 0 && e.owner !== view.me)
  const base = mine.find((e) => e.type === "base")
  const barracks = mine.find((e) => e.type === "barracks")
  const workers = mine.filter((e) => e.type === "worker")
  const army = mine.filter((e) => e.type === "cavalry")
  const goldmines = view.entities.filter((e) => e.type === "goldmine")
  let gold = view.resources.gold

  // 闲着的工人去采离自己最近的矿
  for (const w of workers) {
    if (w.order?.kind !== "idle") continue
    const m = nearest(w, goldmines)
    if (m) cmd.gather(w, m)
  }

  // 主基地补工人（同一时间只排一个）
  if (base && base.queue?.length === 0 && workers.length < MAX_WORKERS && gold >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }

  // 兵营一直出骑兵
  const cavCost = game.types.cavalry.cost.gold ?? 0
  if (barracks && (barracks.queue?.length ?? 0) < 2 && gold >= cavCost) {
    cmd.produce(barracks, "cavalry")
    gold -= cavCost
  }

  // 够数了就出发；之后新出的骑兵直接跟上
  if (army.length >= WAVE) attacking = true
  if (!attacking) return
  const target = view.objectives.enemyBases[0]
  // 骑兵克弓兵、跑得比工人快：附近有工人、弓兵就先杀它们，枪兵克骑兵，能不碰就不碰
  const prey = enemies.filter((e) => e.type === "worker" || e.type === "archer")
  for (const u of army) {
    const near = prey.filter((e) => dist(e, u) <= 8)
    const t = nearest(u, near)
    if (t) {
      if (u.order?.kind !== "attack" || u.order.target !== t.id) cmd.attack(u, t)
    } else if (u.order?.kind === "idle") cmd.attackMove(u, target.x + 1, target.y + 1)
  }
}
