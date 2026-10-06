// 先发展后进攻：工人补到 12 个、家门口采完去中间的矿，战士弓手 2:1 凑够 12 个再进攻，打残了撤回家。
// 打残了是剩不到 5 个；家里来敌人时全军回防。

const MAX_WORKERS = 12
const ATTACK_AT = 12
const RETREAT_BELOW = 5
let attacking = false
let produced = 0

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
  const army = mine.filter((e) => e.type === "soldier" || e.type === "archer")
  const goldmines = view.entities.filter((e) => e.type === "goldmine")
  let gold = view.resources.gold

  // 工人：闲着就去离主基地最近、且还不到 3 个人在采的矿（只认看得见的矿）
  const assigned = new Map<number, number>()
  for (const w of workers) if (w.order?.kind === "gather") assigned.set(w.order.target, (assigned.get(w.order.target) ?? 0) + 1)
  for (const w of workers) {
    if (w.order?.kind !== "idle" || !base) continue
    const free = goldmines.filter((m) => (assigned.get(m.id) ?? 0) < 3)
    const m = nearest(base, free.length > 0 ? free : goldmines)
    if (!m) continue
    cmd.gather(w, m)
    assigned.set(m.id, (assigned.get(m.id) ?? 0) + 1)
  }

  if (base && (base.queue?.length ?? 0) === 0 && workers.length < MAX_WORKERS && gold >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }
  if (barracks && (barracks.queue?.length ?? 0) < 2) {
    const type: TypeName = produced % 3 === 2 ? "archer" : "soldier"
    const cost = game.types[type].cost.gold ?? 0
    if (gold >= cost) {
      cmd.produce(barracks, type)
      gold -= cost
      produced++
    }
  }

  // 家里来敌人：全军回防
  const intruders = base ? enemies.filter((e) => dist(e, base) <= 10) : []
  if (intruders.length > 0) {
    for (const u of army) {
      const t = nearest(u, intruders)!
      if (u.order?.kind !== "attack") cmd.attack(u, t)
    }
    if (view.tick % 50 === 0) console.log(`回防：家门口有 ${intruders.length} 个敌人`)
    return
  }

  if (!attacking && army.length >= ATTACK_AT) {
    attacking = true
    console.log(`第 ${view.tick} tick 进攻，兵力 ${army.length}`)
  }
  if (attacking && army.length < RETREAT_BELOW) {
    attacking = false
    console.log(`第 ${view.tick} tick 撤退，只剩 ${army.length}`)
    if (base) for (const u of army) cmd.move(u, base.x + 4, base.y + 4)
  }
  if (attacking) {
    const target = view.objectives.enemyBases[0]
    for (const u of army) if (u.order?.kind === "idle") cmd.attackMove(u, target.x + 1, target.y + 1)
  }
}
