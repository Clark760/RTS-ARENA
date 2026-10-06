// 先发展后夺点：工人补到 12 个、采到中间的矿，战士弓手 1:1 攒够 10 个才一起去占点；对方领先太多或快赢了就提前压上。
// 点里的兵打残了（剩不到 4 个）就撤回家；家里来敌人时全军回防。

const MAX_WORKERS = 12
const GO_AT = 10
const RETREAT_BELOW = 4
let holding = false
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

  // 工人：每矿最多 3 人，离主基地近的先；家门口的采完自然轮到中间的
  const load = new Map<number, number>()
  for (const w of workers) if (w.order?.kind === "gather") load.set(w.order.target, (load.get(w.order.target) ?? 0) + 1)
  for (const w of workers) {
    if (w.order?.kind === "gather" || w.order?.kind === "attack") continue
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
  if (barracks && (barracks.queue?.length ?? 0) < 2 && workers.length >= 8) {
    const type: TypeName = produced % 2 === 0 ? "soldier" : "archer"
    const cost = game.types[type].cost.gold ?? 0
    if (gold >= cost) {
      cmd.produce(barracks, type)
      gold -= cost
      produced++
    }
  }

  // 家里来敌人：全军回防，兵不够时附近的工人也上
  const intruders = enemies.filter((e) => dist(e, base) <= 11 || workers.some((w) => dist(w, e) <= 4))
  if (intruders.length > 0) {
    for (const u of army) {
      const t = nearest(u, intruders)!
      if (u.order?.kind !== "attack" || u.order.target !== t.id) cmd.attack(u, t)
    }
    if (intruders.length > army.length)
      for (const w of workers) {
        const t = intruders.find((e) => dist(e, w) <= 3)
        if (t && w.order?.kind !== "attack") cmd.attack(w, t)
      }
    return
  }

  const me = view.me
  const theirs = Math.max(...view.objectives.points.filter((_, i) => i !== me))
  const mineP = view.objectives.points[me]
  // 对方领先 200 分以上、或者离获胜不到 150 分：有 6 个兵就去抢点
  const urgent = theirs > mineP && (theirs - mineP >= 200 || theirs >= view.objectives.target - 150)
  if (!holding && (army.length >= GO_AT || (urgent && army.length >= 6))) {
    holding = true
    console.log(`第 ${view.tick} tick 去占点，兵力 ${army.length}`)
  }
  const atZone = army.filter((u) => dist(u, zoneCenter) <= 8)
  if (holding && atZone.length > 0 && atZone.length < RETREAT_BELOW && !urgent && enemies.filter((e) => dist(e, zoneCenter) <= 10).length >= atZone.length) {
    holding = false
    console.log(`第 ${view.tick} tick 撤回家，点里只剩 ${atZone.length} 个`)
  }

  if (!holding) {
    const home = { x: base.x + 1, y: base.y + 1 }
    const rally = { x: Math.round(home.x + (zoneCenter.x - home.x) * 0.3), y: Math.round(home.y + (zoneCenter.y - home.y) * 0.3) }
    for (const u of army) if (dist(u, rally) > 3 && (u.order?.kind !== "attackMove" || u.order.x !== rally.x || u.order.y !== rally.y)) cmd.attackMove(u, rally.x, rally.y)
    return
  }

  // 占点：点附近的敌人先打，没有就在点里分散站位
  const near = enemies.filter((e) => dist(e, zoneCenter) <= 9)
  army.forEach((u, i) => {
    const t = nearest(u, near)
    if (t) {
      if (u.order?.kind !== "attack" || u.order.target !== t.id) cmd.attack(u, t)
      return
    }
    if (inZone(u, zone) || u.order?.kind === "attackMove") return
    cmd.attackMove(u, zone.x + (i % zone.w), zone.y + (Math.floor(i / zone.w) % zone.h))
  })
}
