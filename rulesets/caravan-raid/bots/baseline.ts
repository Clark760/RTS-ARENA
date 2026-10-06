// 基准（均衡）：8 个工人采金，在自家两条商路的路口旁建一个货栈；战士最多 12 个，凑够 3 个就去劫离家 26 格内的中立商队（先打镖师）或抢别人押运中的商队（先打押运的兵），劫到就押回最近的交货点；家门口有敌人先回防。

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

/** 货栈的放置限制（canBuild 不知道）：不压路、贴着路、离非盟友主基地够远 */
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

/** 离 base 最近的两条路的路口，往自家这边退 2 格（货栈的左上角从这里附近找） */
function homeCrossing(view: View, base: Entity): Pos {
  const lanes = view.objectives.routes.map((r) => r.lane).sort((a, b) => dist(base, a) - dist(base, b))
  const v = lanes.find((l) => l.w === 2)!
  const h = lanes.find((l) => l.h === 2)!
  return { x: base.x < v.x ? v.x - 2 : v.x + 2, y: base.y < h.y ? h.y - 2 : h.y + 2 }
}

export function onTick(view: View, cmd: Commands): void {
  const o = view.objectives
  const mine = view.entities.filter((e) => e.owner === view.me)
  const base = mine.find((e) => e.type === "base")
  if (!base) return
  const barracks = mine.find((e) => e.type === "barracks")
  const workers = mine.filter((e) => e.type === "worker")
  const soldiers = mine.filter((e) => e.type === "soldier")
  const posts = mine.filter((e) => e.type === "post")
  const myCaravans = mine.filter((e) => e.type === "caravan")
  const mines = view.entities.filter((e) => e.type === "goldmine")
  const hostile = view.entities.filter((e) => e.owner >= 0 && !view.players.some((p) => p.id === e.owner && p.team === o.myTeam))
  const guards = view.entities.filter((e) => e.type === "guard")
  let gold = view.resources.gold

  // 生产：先工人，再留钱建货栈，再出兵
  if ((base.queue?.length ?? 0) === 0 && workers.length < 8 && gold >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }
  const needPost = posts.length === 0
  if (barracks && (barracks.queue?.length ?? 0) === 0 && workers.length >= 5 && soldiers.length < 12 && gold >= (needPost && view.tick > 300 ? 195 : 75)) {
    cmd.produce(barracks, "soldier")
    gold -= 75
  }

  // 建货栈：派一个工人去路口
  let builder: Entity | undefined
  if (needPost && gold >= 120 && workers.length >= 4) {
    builder = workers.find((w) => w.order?.kind === "build") ?? workers[0]
    const cross = homeCrossing(view, base)
    const spot = findPostSpot(view, cross, 4)
    if (spot) cmd.build(builder, "post", spot.x, spot.y)
    else cmd.move(builder, cross.x, cross.y)
  }

  // 工人采金
  const load = new Map<number, number>()
  for (const w of workers) if (w.order?.kind === "gather") load.set(w.order.target, (load.get(w.order.target) ?? 0) + 1)
  for (const w of workers) {
    if (w === builder || w.order?.kind === "build") continue
    if (w.order?.kind === "gather" && mines.some((m) => m.id === (w.order as { target: number }).target)) continue
    const open = mines.filter((m) => (load.get(m.id) ?? 0) < 3)
    const m = nearest(base, open)
    if (!m) continue
    cmd.gather(w, m)
    load.set(m.id, (load.get(m.id) ?? 0) + 1)
  }

  // 自己的商队：押去最近的交货点
  const drops: Entity[] = [base, ...posts.filter((p) => !p.construction)]
  for (const c of myCaravans) {
    const d = nearest(c, drops)!
    if (c.order?.kind !== "move") cmd.move(c, d.x + Math.floor(d.w / 2), d.y + Math.floor(d.h / 2))
  }

  // 战士
  const threat = nearest(base, hostile.filter((e) => dist(e, base) <= 10).concat(guards.filter((g) => dist(g, base) <= 8)))
  const escort = nearest(base, myCaravans)
  // 目标：离家 26 格内的中立商队，或者别的队正在押运的商队（抢过来）
  const allyIds = new Set(view.players.filter((p) => p.team === o.myTeam).map((p) => p.id))
  const prey = o.caravans
    .filter((c) => (c.owner === -1 || !allyIds.has(c.owner)) && dist(c, base) <= 26)
    .sort((a, b) => dist(a, base) - dist(b, base))[0]
  // 押商队时离它最近的一个兵贴身看着（商队 2 格内没有自己人会被抢、被镖师夺回）
  const minder = escort ? nearest(escort, soldiers) : undefined
  for (const s of soldiers) {
    if (s === minder && escort) {
      if (dist(s, escort) > 1) cmd.move(s, escort.x, escort.y)
      continue
    }
    if (threat) {
      if (s.order?.kind !== "attack") cmd.attack(s, threat)
      continue
    }
    if (escort) {
      // 跟着自己的商队，打靠近的敌人
      const foe = nearest(escort, hostile.filter((e) => dist(e, escort) <= 5).concat(guards.filter((g) => dist(g, escort) <= 4)))
      if (foe) cmd.attack(s, foe)
      else if (dist(s, escort) > 1) cmd.move(s, escort.x, escort.y)
      continue
    }
    if (prey && soldiers.length >= 3) {
      const g = prey.owner === -1 ? nearest(prey, guards.filter((g) => dist(g, prey) <= 6)) : nearest(prey, hostile.filter((e) => dist(e, prey) <= 5))
      if (g) {
        if (s.order?.kind !== "attack") cmd.attack(s, g)
      } else cmd.move(s, prey.x, prey.y)
      continue
    }
    if (s.order?.kind === "idle" && dist(s, base) > 6) cmd.move(s, base.x + 1, base.y + 4)
  }
}
