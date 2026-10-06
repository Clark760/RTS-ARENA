// 边采边骚扰：10 个工人采矿，再出 4 个战士去对方家门口杀工人。
// 采集竞速的目标信息里没有对方基地位置，但地图是中心对称的，可以从自己的主基地推出来。

const MAX_WORKERS = 10
const RAIDERS = 4

function nearest<T extends Pos>(from: Pos, list: T[]): T | undefined {
  let best: T | undefined
  for (const e of list) if (!best || dist(from, e) < dist(from, best)) best = e
  return best
}

export function onTick(view: View, cmd: Commands): void {
  const mine = view.entities.filter((e) => e.owner === view.me)
  const base = mine.find((e) => e.type === "base")
  const barracks = mine.find((e) => e.type === "barracks")
  if (!base) return
  const workers = mine.filter((e) => e.type === "worker")
  const soldiers = mine.filter((e) => e.type === "soldier")
  const goldmines = view.entities.filter((e) => e.type === "goldmine")
  const enemyWorkers = view.entities.filter((e) => e.owner >= 0 && e.owner !== view.me && e.type === "worker")
  let gold = view.resources.gold

  const assigned = new Map<number, number>()
  for (const w of workers) if (w.order?.kind === "gather") assigned.set(w.order.target, (assigned.get(w.order.target) ?? 0) + 1)
  for (const w of workers) {
    if (w.order?.kind !== "idle") continue
    const free = goldmines.filter((m) => (assigned.get(m.id) ?? 0) < 2)
    const m = nearest(base, free.length ? free : goldmines)
    if (!m) continue
    cmd.gather(w, m)
    assigned.set(m.id, (assigned.get(m.id) ?? 0) + 1)
  }

  if ((base.queue?.length ?? 0) === 0 && workers.length < MAX_WORKERS && gold >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }
  if (barracks && workers.length >= 6 && soldiers.length + (barracks.queue?.length ?? 0) < RAIDERS && gold >= 75) {
    cmd.produce(barracks, "soldier")
  }

  // 对方主基地 = 自己主基地的中心对称位置
  const enemyBase = { x: game.width - base.x - base.w, y: game.height - base.y - base.h }
  for (const s of soldiers) {
    const prey = nearest(s, enemyWorkers)
    if (prey && dist(s, prey) <= 8) {
      if (s.order?.kind !== "attack") cmd.attack(s, prey)
    } else if (s.order?.kind === "idle") {
      cmd.attackMove(s, enemyBase.x + 1, enemyBase.y + 5)
    }
  }
}
