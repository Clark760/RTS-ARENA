// 速攻：不管商队，4 个工人采金、兵营一直出战士，凑够 6 个就去拆离得最近的非盟友主基地（拆掉对方出局），之后新兵直接跟上。

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

export function onTick(view: View, cmd: Commands): void {
  const o = view.objectives
  const allies = new Set(view.players.filter((p) => p.team === o.myTeam).map((p) => p.id))
  const mine = view.entities.filter((e) => e.owner === view.me)
  const base = mine.find((e) => e.type === "base")
  if (!base) return
  const barracks = mine.find((e) => e.type === "barracks")
  const workers = mine.filter((e) => e.type === "worker")
  const soldiers = mine.filter((e) => e.type === "soldier")
  const mines = view.entities.filter((e) => e.type === "goldmine")
  let gold = view.resources.gold
  if ((base.queue?.length ?? 0) === 0 && workers.length < 4 && gold >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }
  for (const w of workers) if (w.order?.kind !== "gather") {
    const m = nearest(base, mines)
    if (m) cmd.gather(w, m)
  }
  if (barracks && (barracks.queue?.length ?? 0) < 2 && gold >= 75) cmd.produce(barracks, "soldier")

  // 还在场的非盟友里离我最近的主基地
  const alive = new Set(view.players.filter((p) => p.alive && !allies.has(p.id)).map((p) => p.id))
  const targetBase = nearest(base, o.enemyBases.filter((b) => alive.has(b.owner)).map((b) => ({ x: b.x, y: b.y, w: 3, h: 3, owner: b.owner })))
  if (!targetBase) return
  if (soldiers.length >= 6) attacking = true
  const seen = view.entities.find((e) => e.type === "base" && e.owner === targetBase.owner)
  for (const s of soldiers) {
    if (!attacking) continue
    if (seen && dist(s, seen) <= 6) {
      if (s.order?.kind !== "attack") cmd.attack(s, seen)
    } else if (s.order?.kind === "idle" || s.order?.kind === "move") cmd.attackMove(s, targetBase.x + 1, targetBase.y + 1)
  }
}
