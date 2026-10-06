// 基准（均衡）：5 个工人采金，兵营一直出战士；前 2 个兵守自家旗台、旗被扛走就去追，其余攒够 4 个一起去扛最近的敌旗，扛到就全队护送回家，巨魔靠近旗手时护卫回头打巨魔。

let wave = false

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

export function onTick(view: View, cmd: Commands): void {
  const o = view.objectives
  const mine = view.entities.filter((e) => e.owner === view.me)
  const base = mine.find((e) => e.type === "base")
  if (!base) return
  const barracks = mine.find((e) => e.type === "barracks")
  const workers = mine.filter((e) => e.type === "worker")
  // 扛着旗的单位（不管是谁）直接回家
  const stand = o.stands[view.me]
  const carrying = new Set(o.flags.filter((f) => f.state === "carried" && f.carrierOwner === view.me).map((f) => f.carrier!))
  for (const u of mine) if (carrying.has(u.id) && u.order?.kind !== "move") cmd.move(u, stand.x, stand.y)
  const army = mine.filter((e) => (e.type === "soldier" || e.type === "archer") && !carrying.has(e.id)).sort((a, b) => a.id - b.id)
  const mines = view.entities.filter((e) => e.type === "goldmine" && (e.amount ?? 0) > 0)
  let gold = view.resources.gold

  // 经济
  if (workers.length < 5 && (base.queue?.length ?? 0) === 0 && gold >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }
  if (barracks && (barracks.queue?.length ?? 0) < 2 && gold >= 75) cmd.produce(barracks, "soldier")
  for (const w of workers) {
    if (w.order?.kind === "gather" || carrying.has(w.id)) continue
    const m = nearest(base, mines)
    if (m) cmd.gather(w, m)
  }

  const myFlag = o.flags[view.me]
  const byId = new Map(view.entities.map((e) => [e.id, e]))
  const trolls = view.entities.filter((e) => e.type === "troll")

  // 守家：前 2 个
  const defenders = army.slice(0, 2)
  const attackers = army.slice(2)
  for (const d of defenders) {
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
    const threat = view.entities.find((e) => isEnemy(e.owner) && dist(e, stand) <= 7)
    if (threat) {
      if (d.order?.kind !== "attack") cmd.attack(d, threat)
    } else if (dist(d, stand) > 3 && d.order?.kind !== "attackMove") cmd.attackMove(d, stand.x + 1, stand.y + 1)
  }

  // 进攻
  if (attackers.length >= 4) wave = true
  if (attackers.length === 0) wave = false
  // 有旗手时：护卫跟着旗手走，巨魔靠近旗手就回头打它
  const carrier = mine.find((u) => carrying.has(u.id))
  if (carrier) {
    const chaser = trolls.find((t) => dist(t, carrier) <= 5)
    for (const a of attackers) {
      if (chaser) {
        if (a.order?.kind !== "attack") cmd.attack(a, chaser)
      } else cmd.attackMove(a, carrier.x, carrier.y)
    }
    return
  }
  if (!wave) {
    for (const a of attackers) if (a.order?.kind === "idle" && dist(a, stand) > 4) cmd.attackMove(a, stand.x + 2, stand.y + 2)
    return
  }
  const lead = attackers[0]
  const targets = o.flags.filter((f) => isEnemy(f.owner) && (f.state === "home" || f.state === "dropped"))
  const target = nearest(lead, targets)
  if (!target) return
  for (const a of attackers) {
    const t = trolls.find((tr) => dist(tr, a) <= 2)
    if (t) {
      if (a.order?.kind !== "attack") cmd.attack(a, t)
    } else if (dist(a, target) <= 6) cmd.move(a, target.x, target.y)
    else if (a.order?.kind !== "attackMove" || a.order.x !== target.x || a.order.y !== target.y) cmd.attackMove(a, target.x, target.y)
  }
}
