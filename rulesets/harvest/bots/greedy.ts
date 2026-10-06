// 全力发展：一直补工人，每个矿最多 2 个人采，从离主基地近的矿开始。不出兵。

const MAX_WORKERS = 16
const PER_MINE = 2

function nearest<T extends Pos>(from: Pos, list: T[]): T | undefined {
  let best: T | undefined
  for (const e of list) if (!best || dist(from, e) < dist(from, best)) best = e
  return best
}

export function onTick(view: View, cmd: Commands): void {
  const mine = view.entities.filter((e) => e.owner === view.me)
  const base = mine.find((e) => e.type === "base")
  if (!base) return
  const workers = mine.filter((e) => e.type === "worker")
  const goldmines = view.entities.filter((e) => e.type === "goldmine")

  const assigned = new Map<number, number>()
  for (const w of workers) if (w.order?.kind === "gather") assigned.set(w.order.target, (assigned.get(w.order.target) ?? 0) + 1)
  for (const w of workers) {
    if (w.order?.kind !== "idle") continue
    const free = goldmines.filter((m) => (assigned.get(m.id) ?? 0) < PER_MINE)
    const m = nearest(base, free.length ? free : goldmines)
    if (!m) {
      // 看得见的矿都采完了：往地图中间走，找新的矿
      cmd.move(w, Math.floor(game.width / 2), Math.floor(game.height / 2))
      continue
    }
    cmd.gather(w, m)
    assigned.set(m.id, (assigned.get(m.id) ?? 0) + 1)
  }

  if ((base.queue?.length ?? 0) < 2 && workers.length + (base.queue?.length ?? 0) < MAX_WORKERS && view.resources.gold >= 50) {
    cmd.produce(base, "worker")
  }
}
