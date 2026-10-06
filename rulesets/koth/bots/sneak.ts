// 工人抢分：开局就派 2 个工人去控制点蹲着拿分（工人也算单位），兵出来后去点里接替，工人回去采矿；点里来了敌人兵就打。
// 兵营战士弓手交替出，兵力全放在控制点；家里来敌人时，点里只留 2 个，其余回防。

const MAX_WORKERS = 9
const SITTERS = 2
let sitters: number[] | null = null
let produced = 0

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

function inZone(e: Pos, z: Objectives["zone"]): boolean {
  return e.x >= z.x && e.x < z.x + z.w && e.y >= z.y && e.y < z.y + z.h
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
  const zone = view.objectives.zone
  const zoneCenter = { x: zone.x + Math.floor(zone.w / 2), y: zone.y + Math.floor(zone.h / 2) }
  let gold = view.resources.gold

  // 开局挑离控制点最近的 2 个工人去蹲点；兵到点里 2 个以上就换下来
  if (!sitters) sitters = [...workers].sort((a, b) => dist(a, zoneCenter) - dist(b, zoneCenter)).slice(0, SITTERS).map((w) => w.id)
  const armyInZone = army.filter((u) => inZone(u, zone)).length
  if (armyInZone >= 2) sitters = []
  const sitting = workers.filter((w) => sitters!.includes(w.id))
  sitting.forEach((w, i) => {
    const x = zone.x + ((i * 3) % zone.w)
    const y = zone.y + ((i * 2 + 1) % zone.h)
    if (!inZone(w, zone) && (w.order?.kind !== "move" || w.order.x !== x || w.order.y !== y)) cmd.move(w, x, y)
  })

  const load = new Map<number, number>()
  for (const w of workers) if (w.order?.kind === "gather") load.set(w.order.target, (load.get(w.order.target) ?? 0) + 1)
  for (const w of workers) {
    if (sitters.includes(w.id) || w.order?.kind === "gather") continue
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
  if (barracks && (barracks.queue?.length ?? 0) < 2) {
    const type: TypeName = produced % 2 === 0 ? "soldier" : "archer"
    const cost = game.types[type].cost.gold ?? 0
    if (gold >= cost) {
      cmd.produce(barracks, type)
      gold -= cost
      produced++
    }
  }

  // 家里来敌人：留 2 个在点里，其余回防
  const intruders = enemies.filter((e) => dist(e, base) <= 10)
  const keep = new Set(army.filter((u) => inZone(u, zone)).slice(0, 2).map((u) => u.id))
  const near = enemies.filter((e) => dist(e, zoneCenter) <= 8)
  army.forEach((u, i) => {
    const home = intruders.length > 0 && !keep.has(u.id) ? nearest(u, intruders) : undefined
    const t = home ?? nearest(u, near)
    if (t) {
      if (u.order?.kind !== "attack" || u.order.target !== t.id) cmd.attack(u, t)
      return
    }
    if (inZone(u, zone) || u.order?.kind === "attackMove") return
    cmd.attackMove(u, zone.x + (i % zone.w), zone.y + (Math.floor(i / zone.w) % zone.h))
  })
  if (view.tick % 500 === 0) console.log(`控制分 ${view.objectives.points.join(" : ")}，兵力 ${army.length}，蹲点工人 ${sitting.length}`)
}
