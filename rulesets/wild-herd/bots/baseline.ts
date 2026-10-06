// 基准（均衡）：建一个牧栏，战士 2 个守栏、其余两两去围野牛（没有野牛就偷别队的），牛多了再建牧栏。
// 细节：工人补到 6 个采金；派一个工人去离家最近、能用的草场建牧栏；
// 兵营出战士：前 2 个守牧栏（打狼和来犯的敌人），其余凑够 2 个就一起去围离牧栏最近的野牛（没有野牛就去偷别队的牛）；
// 驯服的牛赶到牧栏边；牛比 4×牧栏数多时再建一个牧栏（最多 3 个）。

const RING: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]
let builderId = -1

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

/** 2×2 牧栏周围、离它距离正好 1 的格子（不含角） */
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
  const obj = view.objectives
  const mine = view.entities.filter((e) => e.owner === me)
  const base = mine.find((e) => e.type === "base")
  const home: Pos = base ?? mine[0]
  if (!home) return
  const barracks = mine.find((e) => e.type === "barracks")
  const workers = mine.filter((e) => e.type === "worker")
  const soldiers = mine.filter((e) => e.type === "soldier").sort((a, b) => a.id - b.id)
  const myBison = mine.filter((e) => e.type === "bison").sort((a, b) => a.id - b.id)
  const pens = mine.filter((e) => e.type === "pen")
  const donePens = pens.filter((p) => !p.construction)
  const mines = view.entities.filter((e) => e.type === "goldmine")
  const hostile = view.entities.filter(
    (e) => e.type === "wolf" || (e.owner >= 0 && view.players[e.owner].team !== myTeam && game.types[e.type].kind === "unit"),
  )
  let gold = view.resources.gold

  // ---- 生产 ----
  if (base && (base.queue?.length ?? 0) === 0 && workers.length < 6 && gold >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }

  // ---- 牧栏 ----
  const unfinished = pens.find((p) => p.construction)
  const wantPens = Math.min(3, Math.max(1, Math.ceil(myBison.length / 4)))
  let builder = workers.find((w) => w.id === builderId)
  if (unfinished) {
    // 没人在建就派最近的工人接着建
    if (!workers.some((w) => w.order?.kind === "build")) {
      const w = builder ?? nearest(unfinished, workers)
      if (w) cmd.build(w, "pen", unfinished.x, unfinished.y)
    }
  } else if (pens.length < wantPens && gold >= 100) {
    const usable = obj.pastures.filter((p) => p.holder === null || p.holder === myTeam)
    // 已经有牧栏的草场优先（离得近、好守），否则离家最近的
    const withMine = usable.find((p) => pens.some((pen) => pen.x >= p.x && pen.y >= p.y && pen.x < p.x + p.w && pen.y < p.y + p.h))
    const past = withMine ?? nearest(home, usable)
    if (!builder) builder = past ? nearest(past, workers) : undefined
    if (past && builder) {
      builderId = builder.id
      let spot: Pos | undefined
      let bd = Infinity
      for (let y = past.y; y + 2 <= past.y + past.h; y++)
        for (let x = past.x; x + 2 <= past.x + past.w; x++)
          if (canBuild(view, "pen", x, y) && dist(home, { x, y }) < bd) {
            spot = { x, y }
            bd = dist(home, spot)
          }
      if (spot) {
        cmd.build(builder, "pen", spot.x, spot.y)
        gold -= 100
        builderId = -1
      } else if (builder.order?.kind !== "move") cmd.move(builder, past.x + 1, past.y + 1) // 先走过去开视野
    }
  }
  // 驯服的牛也占单位上限：满了就不造兵
  const units = mine.filter((e) => game.types[e.type].kind === "unit").length + (base?.queue?.length ?? 0)
  const roomy = game.unitCap === 0 || units < game.unitCap - 1
  if (barracks && roomy && (barracks.queue?.length ?? 0) === 0 && gold >= (pens.length > 0 ? 75 : 175)) {
    cmd.produce(barracks, "soldier")
    gold -= 75
  }

  // ---- 工人采金 ----
  const load = new Map<number, number>()
  for (const w of workers) if (w.order?.kind === "gather") load.set(w.order.target, (load.get(w.order.target) ?? 0) + 1)
  for (const w of workers) {
    if (w.id === builderId || w.order?.kind === "build") continue
    if (w.order?.kind === "gather" && mines.some((m) => m.id === (w.order as { target: number }).target)) continue
    const m = nearest(home, mines.filter((m) => (load.get(m.id) ?? 0) < 3))
    if (!m) continue
    cmd.gather(w, m)
    load.set(m.id, (load.get(m.id) ?? 0) + 1)
  }

  // ---- 牛：赶到牧栏边 ----
  const anchor: Pos = donePens[0] ?? pens[0] ?? home
  myBison.forEach((b, i) => {
    const pen = donePens[Math.min(Math.floor(i / 4), donePens.length - 1)]
    if (!pen) {
      if (dist(b, anchor) > 3) cmd.move(b, anchor.x, anchor.y)
      return
    }
    if (dist(b, pen) <= obj.penRadius) return
    const slots = penSlots(pen)
    const s = slots[i % 4] ?? slots[0] ?? pen
    cmd.move(b, s.x, s.y)
  })

  // ---- 战士 ----
  const guards = soldiers.slice(0, 2)
  const tamers = soldiers.slice(2)
  const guardPen = donePens[0] ?? pens[0]
  for (const [i, g] of guards.entries()) {
    const center: Pos = guardPen ?? home
    const threat = nearest(g, hostile.filter((h) => dist(h, center) <= 7))
    if (threat) {
      if (g.order?.kind !== "attack" || g.order.target !== threat.id) cmd.attack(g, threat)
      continue
    }
    if (!guardPen) continue
    const slots = penSlots(guardPen)
    const s = slots[4 + i] ?? slots[i]
    if (s && dist(g, s) > 0 && g.order?.kind !== "move") cmd.move(g, s.x, s.y)
  }

  // 驯服：至少 2 个一起去，围住离牧栏最近的野牛；没有野牛了就去偷离得最近的别队的牛
  const wild = obj.bison.filter((b) => b.owner === -1)
  const theirs = obj.bison.filter((b) => b.owner >= 0 && view.players[b.owner].team !== myTeam)
  const target = nearest(anchor, wild) ?? nearest(anchor, theirs)
  for (const [i, t] of tamers.entries()) {
    const wolf = nearest(t, hostile.filter((h) => dist(h, t) <= 4))
    if (wolf) {
      if (t.order?.kind !== "attack") cmd.attack(t, wolf)
      continue
    }
    if (!target || tamers.length < 2) {
      if (guardPen && dist(t, guardPen) > 4) cmd.move(t, guardPen.x, guardPen.y)
      continue
    }
    if (Math.max(Math.abs(t.x - target.x), Math.abs(t.y - target.y)) <= 1) {
      if (t.order?.kind !== "idle") cmd.stop(t)
      continue
    }
    const [dx, dy] = RING[i % RING.length]
    cmd.move(t, target.x + dx, target.y + dy)
  }
}
