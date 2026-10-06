// 偷牛贼：只留 1 个战士守栏，战士弓手成群去偷别队的牛、路上拆别队的牧栏，没有可偷的才驯野牛。
// 细节：和 baseline 一样建一个牧栏、采金，但兵营交替出战士和弓手，
// 只留 1 个战士守栏；其余的成群行动，优先去偷别的队伍的牛（目标牛周围的守卫会被自动打），
// 路上看到别队的牧栏就拆；没有可偷的才去驯服野牛。

const RING: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]
let builderId = -1
let made = 0

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

function walkable(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < game.width && y < game.height && game.walkable[game.terrain[y][x]]
}

function penSlots(pen: Entity): Pos[] {
  const out: Pos[] = []
  for (let i = 0; i < 2; i++) {
    out.push({ x: pen.x + i, y: pen.y - 1 }, { x: pen.x + 2, y: pen.y + i }, { x: pen.x + 1 - i, y: pen.y + 2 }, { x: pen.x - 1, y: pen.y + 1 - i })
  }
  return out.filter((p) => walkable(p.x, p.y))
}

export function onTick(view: View, cmd: Commands): void {
  const me = view.me
  const myTeam = view.players[me].team
  const isEnemy = (o: number) => o >= 0 && view.players[o].team !== myTeam
  const obj = view.objectives
  const mine = view.entities.filter((e) => e.owner === me)
  const base = mine.find((e) => e.type === "base")
  const home: Pos = base ?? mine[0]
  if (!home) return
  const barracks = mine.find((e) => e.type === "barracks")
  const workers = mine.filter((e) => e.type === "worker")
  const army = mine.filter((e) => e.type === "soldier" || e.type === "archer").sort((a, b) => a.id - b.id)
  const myBison = mine.filter((e) => e.type === "bison")
  const pens = mine.filter((e) => e.type === "pen")
  const donePens = pens.filter((p) => !p.construction)
  const mines = view.entities.filter((e) => e.type === "goldmine")
  let gold = view.resources.gold

  if (base && (base.queue?.length ?? 0) === 0 && workers.length < 5 && gold >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }

  // 牧栏：一个就够
  const unfinished = pens.find((p) => p.construction)
  let builder = workers.find((w) => w.id === builderId)
  if (unfinished) {
    if (!workers.some((w) => w.order?.kind === "build")) {
      const w = builder ?? nearest(unfinished, workers)
      if (w) cmd.build(w, "pen", unfinished.x, unfinished.y)
    }
  } else if (pens.length < (myBison.length > 4 ? 2 : 1) && gold >= 100) {
    const usable = obj.pastures.filter((p) => p.holder === null || p.holder === myTeam)
    const past = nearest(home, usable)
    if (!builder) builder = past ? nearest(past, workers) : undefined
    if (past && builder) {
      builderId = builder.id
      let spot: Pos | undefined
      for (let y = past.y; y + 2 <= past.y + past.h && !spot; y++)
        for (let x = past.x; x + 2 <= past.x + past.w && !spot; x++) if (canBuild(view, "pen", x, y)) spot = { x, y }
      if (spot) {
        cmd.build(builder, "pen", spot.x, spot.y)
        gold -= 100
        builderId = -1
      } else if (builder.order?.kind !== "move") cmd.move(builder, past.x + 1, past.y + 1)
    }
  }
  if (barracks && (barracks.queue?.length ?? 0) === 0) {
    const type = made % 3 === 2 ? "archer" : "soldier"
    if (gold >= (pens.length > 0 ? 80 : 180)) {
      cmd.produce(barracks, type)
      made++
    }
  }

  const load = new Map<number, number>()
  for (const w of workers) if (w.order?.kind === "gather") load.set(w.order.target, (load.get(w.order.target) ?? 0) + 1)
  for (const w of workers) {
    if (w.id === builderId || w.order?.kind === "build") continue
    if (w.order?.kind === "gather" && mines.some((m) => m.id === (w.order as { target: number }).target)) continue
    const m = nearest(home, mines.filter((m) => (load.get(m.id) ?? 0) < 3))
    if (m) {
      cmd.gather(w, m)
      load.set(m.id, (load.get(m.id) ?? 0) + 1)
    }
  }

  // 牛赶回牧栏
  const anchor: Pos = donePens[0] ?? pens[0] ?? home
  myBison.forEach((b, i) => {
    const pen = donePens[Math.min(Math.floor(i / 4), donePens.length - 1)]
    if (!pen) {
      if (dist(b, anchor) > 3) cmd.move(b, anchor.x, anchor.y)
      return
    }
    if (dist(b, pen) <= obj.penRadius) return
    const slots = penSlots(pen)
    const s = slots[i % 4] ?? pen
    cmd.move(b, s.x, s.y)
  })

  // 守卫：1 个战士，打靠近牧栏的狼和敌人
  const guard = army.find((u) => u.type === "soldier")
  const wolvesSeen = view.entities.filter((e) => e.type === "wolf")
  const enemyUnits = view.entities.filter((e) => isEnemy(e.owner) && game.types[e.type].kind === "unit")
  if (guard && donePens[0]) {
    const t = nearest(guard, [...wolvesSeen, ...enemyUnits].filter((h) => dist(h, donePens[0]) <= 6))
    if (t) {
      if (guard.order?.kind !== "attack") cmd.attack(guard, t)
    } else if (dist(guard, donePens[0]) > 2) cmd.move(guard, donePens[0].x - 1, donePens[0].y)
  }

  // 突击队
  const raiders = army.filter((u) => u !== guard)
  if (raiders.length < 3) {
    for (const r of raiders) {
      const w = nearest(r, wolvesSeen.filter((h) => dist(h, r) <= 5))
      if (w) cmd.attack(r, w)
      else if (dist(r, anchor) > 4) cmd.move(r, anchor.x, anchor.y + 2)
    }
    return
  }
  const center = raiders[0]
  const stealable = obj.bison.filter((b) => isEnemy(b.owner))
  const wild = obj.bison.filter((b) => b.owner === -1)
  const target = nearest(center, stealable) ?? nearest(anchor, wild)
  const enemyPen = view.entities.find((e) => e.type === "pen" && isEnemy(e.owner) && dist(e, center) <= 6)
  for (const [i, r] of raiders.entries()) {
    const w = nearest(r, wolvesSeen.filter((h) => dist(h, r) <= 4))
    if (w) {
      if (r.order?.kind !== "attack") cmd.attack(r, w)
      continue
    }
    if (r.type === "archer") {
      // 弓手跟在后面，拆牧栏、打敌人
      if (enemyPen) {
        if (r.order?.kind !== "attack") cmd.attack(r, enemyPen)
      } else if (target) cmd.attackMove(r, target.x, target.y)
      continue
    }
    if (!target) continue
    if (Math.max(Math.abs(r.x - target.x), Math.abs(r.y - target.y)) <= 1) {
      if (r.order?.kind === "move") cmd.stop(r)
      continue
    }
    const [dx, dy] = RING[i % RING.length]
    cmd.move(r, target.x + dx, target.y + dy)
  }
}
