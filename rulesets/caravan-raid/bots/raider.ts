// 劫道：不建货栈，8 个工人攒钱出战士 + 弓手，专抢别人已经劫下、正在押运的商队（满地图追），没有可抢的才去劫中立商队；抢到就押回自家主基地。

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
  const army = mine.filter((e) => e.type === "soldier" || e.type === "archer")
  const myCaravans = mine.filter((e) => e.type === "caravan")
  const mines = view.entities.filter((e) => e.type === "goldmine")
  const hostile = view.entities.filter((e) => e.owner >= 0 && !allies.has(e.owner))
  const guards = view.entities.filter((e) => e.type === "guard")
  let gold = view.resources.gold

  if ((base.queue?.length ?? 0) === 0 && workers.length < 8 && gold >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }
  if (barracks && (barracks.queue?.length ?? 0) < 2 && workers.length >= 6 && army.length < 14) {
    const archers = army.filter((e) => e.type === "archer").length
    const t = archers * 2 < army.length ? "archer" : "soldier"
    if (gold >= (t === "archer" ? 80 : 75)) cmd.produce(barracks, t)
  }

  const load = new Map<number, number>()
  for (const w of workers) if (w.order?.kind === "gather") load.set(w.order.target, (load.get(w.order.target) ?? 0) + 1)
  for (const w of workers) {
    if (w.order?.kind === "gather" && mines.some((m) => m.id === (w.order as { target: number }).target)) continue
    const open = mines.filter((m) => (load.get(m.id) ?? 0) < 3)
    const m = nearest(base, open.length ? open : mines)
    if (m) cmd.gather(w, m)
    if (m) load.set(m.id, (load.get(m.id) ?? 0) + 1)
  }

  for (const c of myCaravans) if (c.order?.kind !== "move") cmd.move(c, base.x + 1, base.y + 1)

  // 目标：先护送自己的，再抢别人押运中的，再劫中立的
  const escort = nearest(base, myCaravans)
  const center = army.length ? { x: Math.round(army.reduce((s, e) => s + e.x, 0) / army.length), y: Math.round(army.reduce((s, e) => s + e.y, 0) / army.length) } : base
  const stolen = nearest(center, o.caravans.filter((c) => c.owner >= 0 && !allies.has(c.owner)))
  const neutral = nearest(center, o.caravans.filter((c) => c.owner === -1))
  const threat = nearest(base, hostile.filter((e) => dist(e, base) <= 8).concat(guards.filter((g) => dist(g, base) <= 6)))
  const minder = escort ? nearest(escort, army.filter((e) => e.type === "soldier")) : undefined

  for (const s of army) {
    if (s === minder && escort) {
      if (dist(s, escort) > 1) cmd.move(s, escort.x, escort.y)
      continue
    }
    if (threat) {
      if (s.order?.kind !== "attack") cmd.attack(s, threat)
      continue
    }
    if (escort) {
      const foe = nearest(escort, hostile.filter((e) => dist(e, escort) <= 6).concat(guards.filter((g) => dist(g, escort) <= 4)))
      if (foe) cmd.attack(s, foe)
      else if (dist(s, escort) > 2) cmd.move(s, escort.x, escort.y)
      continue
    }
    if (army.length < 4) continue
    if (stolen) {
      // 打押运的人；附近没敌人了就贴上去，商队自然归我
      const foe = nearest(stolen, hostile.filter((e) => dist(e, stolen) <= 5))
      if (foe) {
        if (s.order?.kind !== "attack") cmd.attack(s, foe)
      } else cmd.move(s, stolen.x, stolen.y)
      continue
    }
    if (neutral) {
      const g = nearest(neutral, guards.filter((g) => dist(g, neutral) <= 6))
      if (g) {
        if (s.order?.kind !== "attack") cmd.attack(s, g)
      } else cmd.move(s, neutral.x, neutral.y)
    }
  }
}
