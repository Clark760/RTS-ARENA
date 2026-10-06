// 占点：工人分散采矿，兵营一直出兵；兵力够 4 个就去控制点，到了就守在里面。家里来敌人时回防。

const MAX_WORKERS = 10
const GO_AT = 4

function nearest<T extends Pos>(from: Pos, list: T[]): T | undefined {
  let best: T | undefined
  for (const e of list) if (!best || dist(from, e) < dist(from, best)) best = e
  return best
}

function inZone(e: Pos, z: Objectives["zone"]): boolean {
  return e.x >= z.x && e.x < z.x + z.w && e.y >= z.y && e.y < z.y + z.h
}

export function onTick(view: View, cmd: Commands): void {
  const mine = view.entities.filter((e) => e.owner === view.me)
  const enemies = view.entities.filter((e) => e.owner >= 0 && e.owner !== view.me)
  const base = mine.find((e) => e.type === "base")
  const barracks = mine.find((e) => e.type === "barracks")
  const workers = mine.filter((e) => e.type === "worker")
  const army = mine.filter((e) => e.type === "soldier" || e.type === "archer")
  const goldmines = view.entities.filter((e) => e.type === "goldmine")
  const zone = view.objectives.zone
  let gold = view.resources.gold

  const assigned = new Map<number, number>()
  for (const w of workers) if (w.order?.kind === "gather") assigned.set(w.order.target, (assigned.get(w.order.target) ?? 0) + 1)
  for (const w of workers) {
    if (w.order?.kind !== "idle" || !base) continue
    const free = goldmines.filter((m) => (assigned.get(m.id) ?? 0) < 3)
    const m = nearest(base, free.length ? free : goldmines)
    if (!m) continue
    cmd.gather(w, m)
    assigned.set(m.id, (assigned.get(m.id) ?? 0) + 1)
  }

  if (base && (base.queue?.length ?? 0) === 0 && workers.length < MAX_WORKERS && gold >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }
  if (barracks && (barracks.queue?.length ?? 0) < 2) {
    // 弓手射程长，守点更好用；钱不够弓手就先出战士
    const type: TypeName = gold >= 90 && army.length % 2 === 1 ? "archer" : "soldier"
    const cost = game.types[type].cost.gold ?? 0
    if (gold >= cost) cmd.produce(barracks, type)
  }

  const intruders = base ? enemies.filter((e) => dist(e, base) <= 8) : []
  if (intruders.length > 0) {
    for (const u of army) if (u.order?.kind !== "attack") cmd.attack(u, nearest(u, intruders)!)
    return
  }

  if (army.length < GO_AT) return
  // 控制点里的格子，按编号轮流分给单位，免得都挤一格
  army.forEach((u, i) => {
    if (inZone(u, zone) || u.order?.kind !== "idle") return
    const x = zone.x + (i % zone.w)
    const y = zone.y + (Math.floor(i / zone.w) % zone.h)
    cmd.attackMove(u, x, y)
  })
  if (view.tick % 100 === 0) console.log(`控制分 ${view.objectives.points.join(" : ")}，兵力 ${army.length}`)
}
