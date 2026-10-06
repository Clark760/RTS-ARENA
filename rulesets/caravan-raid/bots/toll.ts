// 设卡：在自家两条商路上各建一个货栈（建在商队进你家那一段的路边），战士弓手分两队各守一个货栈，商队走到货栈 7 格内才出手，劫下当场交货；从不出远门。

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

function isRoad(x: number, y: number): boolean {
  return game.terrain[y]?.[x] === "="
}

function postOk(view: View, x: number, y: number): boolean {
  if (!canBuild(view, "post", x, y)) return false
  let touches = false
  for (let yy = y - 1; yy <= y + 2; yy++)
    for (let xx = x - 1; xx <= x + 2; xx++) {
      const inside = xx >= x && xx < x + 2 && yy >= y && yy < y + 2
      if (inside && isRoad(xx, yy)) return false
      if (!inside && isRoad(xx, yy)) touches = true
    }
  if (!touches) return false
  for (const b of view.objectives.enemyBases)
    if (dist({ x, y, w: 2, h: 2 }, { x: b.x, y: b.y, w: 3, h: 3 }) < view.objectives.rules.postMinEnemyBaseDist) return false
  return true
}

function findPostSpot(view: View, near: Pos, range: number): Pos | null {
  let best: Pos | null = null
  let bd = Infinity
  for (let dy = -range; dy <= range; dy++)
    for (let dx = -range; dx <= range; dx++) {
      const d = Math.abs(dx) + Math.abs(dy)
      if (d >= bd) continue
      if (postOk(view, near.x + dx, near.y + dy)) {
        best = { x: near.x + dx, y: near.y + dy }
        bd = d
      }
    }
  return best
}

/** 两个卡点：离家最近的竖路、横路上，正对着主基地的那一段路边（在自家这一侧） */
function tollPoints(view: View, base: Entity): Pos[] {
  const lanes = view.objectives.routes.map((r) => r.lane).sort((a, b) => dist(base, a) - dist(base, b))
  const v = lanes.find((l) => l.w === 2)!
  const h = lanes.find((l) => l.h === 2)!
  return [
    { x: base.x < v.x ? v.x - 2 : v.x + 2, y: base.y },
    { x: base.x, y: base.y < h.y ? h.y - 2 : h.y + 2 },
  ]
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
  const posts = mine.filter((e) => e.type === "post")
  const myCaravans = mine.filter((e) => e.type === "caravan")
  const mines = view.entities.filter((e) => e.type === "goldmine")
  const hostile = view.entities.filter((e) => e.owner >= 0 && !allies.has(e.owner))
  const guards = view.entities.filter((e) => e.type === "guard")
  let gold = view.resources.gold
  const points = tollPoints(view, base)

  if ((base.queue?.length ?? 0) === 0 && workers.length < 7 && gold >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }

  // 货栈：每个卡点一个
  const busy = new Set<number>()
  for (const pt of points) {
    const has = posts.some((p) => dist(p, pt) <= 4)
    if (has || gold < 120 || workers.length < 4) continue
    const builder = workers.find((w) => !busy.has(w.id) && w.order?.kind === "build") ?? workers.find((w) => !busy.has(w.id))
    if (!builder) continue
    busy.add(builder.id)
    const spot = findPostSpot(view, pt, 3)
    if (spot) {
      cmd.build(builder, "post", spot.x, spot.y)
      gold -= 120
    } else cmd.move(builder, pt.x, pt.y)
  }
  if (barracks && (barracks.queue?.length ?? 0) === 0 && workers.length >= 5 && army.length < 12) {
    const t = army.filter((e) => e.type === "archer").length * 2 < army.length ? "archer" : "soldier"
    if (gold >= (t === "archer" ? 80 : 75) + (posts.length < 2 ? 120 : 0)) cmd.produce(barracks, t)
  }

  const load = new Map<number, number>()
  for (const w of workers) if (w.order?.kind === "gather") load.set(w.order.target, (load.get(w.order.target) ?? 0) + 1)
  for (const w of workers) {
    if (busy.has(w.id) || w.order?.kind === "build") continue
    if (w.order?.kind === "gather" && mines.some((m) => m.id === (w.order as { target: number }).target)) continue
    const open = mines.filter((m) => (load.get(m.id) ?? 0) < 3)
    const m = nearest(base, open.length ? open : mines)
    if (m) cmd.gather(w, m)
    if (m) load.set(m.id, (load.get(m.id) ?? 0) + 1)
  }

  const drops: Entity[] = [base, ...posts.filter((p) => !p.construction)]
  for (const c of myCaravans) {
    const d = nearest(c, drops)!
    if (c.order?.kind !== "move") cmd.move(c, d.x + Math.floor(d.w / 2), d.y + Math.floor(d.h / 2))
  }

  // 两队各守一个卡点
  army.forEach((s, i) => {
    const pt = points[i % 2]
    const post = posts.find((p) => dist(p, pt) <= 4)
    const home: Pos = post ?? pt
    const threat = nearest(s, hostile.filter((e) => dist(e, home) <= 7 || dist(e, base) <= 8))
    if (threat) {
      if (s.order?.kind !== "attack") cmd.attack(s, threat)
      return
    }
    const mineC = nearest(home, myCaravans.filter((c) => dist(c, home) <= 9))
    if (mineC) {
      if (dist(s, mineC) > 1) cmd.move(s, mineC.x, mineC.y)
      return
    }
    const prey = nearest(home, o.caravans.filter((c) => c.owner === -1 && dist(c, home) <= 7))
    if (prey) {
      const g = nearest(s, guards.filter((g) => dist(g, prey) <= 6))
      if (g) {
        if (s.order?.kind !== "attack") cmd.attack(s, g)
      } else cmd.move(s, prey.x, prey.y)
      return
    }
    if (dist(s, home) > 3 && s.order?.kind !== "move") cmd.move(s, home.x, home.y)
  })
}
