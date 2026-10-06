// 拆家：不管旗，4 个工人采金、兵营一直出战士，凑够 6 个就去拆离得最近的敌方主基地（拆掉对方出局），之后新兵直接跟上；路过敌旗顺手扛上就往家走。

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

function isEnemy(owner: number): boolean {
  return owner >= 0 && game.teams[owner] !== game.teams[game.me]
}

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
  const soldiers = mine.filter((e) => e.type === "soldier" && !carrying.has(e.id))
  const mines = view.entities.filter((e) => e.type === "goldmine" && (e.amount ?? 0) > 0)
  for (const w of workers)
    if (w.order?.kind !== "gather") {
      const m = nearest(base, mines)
      if (m) cmd.gather(w, m)
    }
  if (barracks && (barracks.queue?.length ?? 0) < 2 && view.resources.gold >= 75) cmd.produce(barracks, "soldier")

  if (soldiers.length >= 6) attacking = true
  if (!attacking) return
  const targets = o.bases.filter((b) => b.alive && isEnemy(b.owner))
  const tb = nearest(base, targets)
  if (!tb) return
  const enemyBase = view.entities.find((e) => e.type === "base" && e.owner === tb.owner)
  for (const s of soldiers) {
    if (enemyBase && dist(s, enemyBase) <= 6) {
      if (s.order?.kind !== "attack") cmd.attack(s, enemyBase)
    } else if (s.order?.kind !== "attackMove") cmd.attackMove(s, tb.x + 1, tb.y + 1)
  }
}
