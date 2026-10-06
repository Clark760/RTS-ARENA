// 守塔：6 个工人采金，先在旗台旁的两块高地上各建一座哨塔，兵营出弓手战士守在旗台边；攒够 10 个兵（或第 2000 tick 后有 7 个）才出击，留 3 个守家、其余一起去扛最近的敌旗。

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

function isEnemy(owner: number): boolean {
  return owner >= 0 && game.teams[owner] !== game.teams[game.me]
}

let wave = false

export function onTick(view: View, cmd: Commands): void {
  const o = view.objectives
  const mine = view.entities.filter((e) => e.owner === view.me)
  const base = mine.find((e) => e.type === "base")
  if (!base) return
  const stand = o.stands[view.me]
  const carrying = new Set(o.flags.filter((f) => f.state === "carried" && f.carrierOwner === view.me).map((f) => f.carrier!))
  for (const u of mine) if (carrying.has(u.id) && u.order?.kind !== "move") cmd.move(u, stand.x, stand.y)

  const barracks = mine.find((e) => e.type === "barracks")
  const workers = mine.filter((e) => e.type === "worker" && !carrying.has(e.id))
  const towers = mine.filter((e) => e.type === "tower")
  const army = mine.filter((e) => (e.type === "soldier" || e.type === "archer") && !carrying.has(e.id)).sort((a, b) => a.id - b.id)
  const mines = view.entities.filter((e) => e.type === "goldmine" && (e.amount ?? 0) > 0)
  let gold = view.resources.gold

  if (workers.length < 6 && (base.queue?.length ?? 0) === 0 && gold >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }
  // 哨塔：两座，一次只派一个工人建
  let builder: Entity | undefined = workers.find((w) => w.order?.kind === "build")
  const unfinished = towers.find((t) => t.construction)
  if (!builder && unfinished && workers.length) {
    builder = workers[0]
    cmd.build(builder, "tower", unfinished.x, unfinished.y)
  } else if (!builder && towers.length < 2 && gold >= 120 && workers.length >= 4) {
    const spot = o.towerSpots.find((s) => canBuild(view, "tower", s.x, s.y))
    if (spot) {
      builder = workers[0]
      cmd.build(builder, "tower", spot.x, spot.y)
      gold -= 120
    }
  }
  const saving = towers.length < 2 && !unfinished && view.tick < 1500
  if (barracks && !saving && (barracks.queue?.length ?? 0) < 2) {
    const type = army.filter((a) => a.type === "archer").length < army.length / 2 ? "archer" : "soldier"
    if (gold >= 80) cmd.produce(barracks, type)
  }
  for (const w of workers) {
    if (w === builder || w.order?.kind === "gather" || w.order?.kind === "build") continue
    const m = nearest(base, mines)
    if (m) cmd.gather(w, m)
  }

  const myFlag = o.flags[view.me]
  const byId = new Map(view.entities.map((e) => [e.id, e]))
  if (army.length >= 10 || (view.tick >= 2000 && army.length >= 7)) wave = true
  if (army.length <= 3) wave = false
  const home = wave ? army.slice(0, 3) : army
  const out = wave ? army.slice(3) : []

  for (const d of home) {
    if (myFlag.state === "carried" && myFlag.carrier !== null) {
      const c = byId.get(myFlag.carrier)
      if (c) {
        if (d.order?.kind !== "attack") cmd.attack(d, c)
      } else cmd.attackMove(d, myFlag.x, myFlag.y)
      continue
    }
    if (myFlag.state === "dropped") {
      cmd.move(d, myFlag.x, myFlag.y)
      continue
    }
    const threat = view.entities.find((e) => isEnemy(e.owner) && dist(e, stand) <= 8)
    if (threat) {
      if (d.order?.kind !== "attack") cmd.attack(d, threat)
    } else if (dist(d, stand) > 2 && d.order?.kind === "idle") cmd.attackMove(d, stand.x, stand.y)
  }

  const carrier = mine.find((u) => carrying.has(u.id))
  if (out.length === 0) return
  if (carrier) {
    for (const a of out) cmd.attackMove(a, carrier.x, carrier.y)
    return
  }
  const targets = o.flags.filter((f) => isEnemy(f.owner) && (f.state === "home" || f.state === "dropped"))
  const target = nearest(out[0], targets)
  if (!target) return
  for (const a of out) {
    if (dist(a, target) <= 6) cmd.move(a, target.x, target.y)
    else if (a.order?.kind !== "attackMove") cmd.attackMove(a, target.x, target.y)
  }
}
