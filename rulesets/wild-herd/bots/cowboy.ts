// 牛仔：不靠战士，靠便宜的工人驯牛（工人补到 10 个，4 个采金，其余两两一组去围野牛），兵营只出弓手守栏、守家。
// 细节：
// 牧栏按牛的数量建（每 4 头一个，最多 3 个）；兵营只出弓手守牧栏、打狼（狼赏金补贴经济）。

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

function penSlots(pen: Entity): Pos[] {
  const out: Pos[] = []
  for (let i = 0; i < 2; i++) {
    out.push({ x: pen.x + i, y: pen.y - 1 }, { x: pen.x + 2, y: pen.y + i }, { x: pen.x + 1 - i, y: pen.y + 2 }, { x: pen.x - 1, y: pen.y + 1 - i })
  }
  return out.filter((p) => walkable(p.x, p.y))
}

const cheb = (a: Pos, b: Pos) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))

export function onTick(view: View, cmd: Commands): void {
  const me = view.me
  const myTeam = view.players[me].team
  const obj = view.objectives
  const mine = view.entities.filter((e) => e.owner === me)
  const base = mine.find((e) => e.type === "base")
  const home: Pos = base ?? mine[0]
  if (!home) return
  const barracks = mine.find((e) => e.type === "barracks")
  const workers = mine.filter((e) => e.type === "worker").sort((a, b) => a.id - b.id)
  const archers = mine.filter((e) => e.type === "archer")
  const myBison = mine.filter((e) => e.type === "bison").sort((a, b) => a.id - b.id)
  const pens = mine.filter((e) => e.type === "pen")
  const donePens = pens.filter((p) => !p.construction)
  const mines = view.entities.filter((e) => e.type === "goldmine")
  const threats = view.entities.filter((e) => e.type === "wolf" || (e.owner >= 0 && view.players[e.owner].team !== myTeam && game.types[e.type].kind === "unit"))
  let gold = view.resources.gold

  // 工人到 6 个以后，弓手不到 2 个就先攒钱出弓手（不然死了工人就补，钱永远不够）
  const saveForArcher = workers.length >= 6 && archers.length < 2 && !!barracks
  if (base && (base.queue?.length ?? 0) === 0 && workers.length < 10 && gold >= 50 && !saveForArcher) {
    cmd.produce(base, "worker")
    gold -= 50
  }

  // 牧栏
  const unfinished = pens.find((p) => p.construction)
  const wantPens = Math.min(3, Math.max(1, Math.ceil((myBison.length + 1) / 4)))
  let builder = workers.find((w) => w.id === builderId)
  if (unfinished) {
    if (!workers.some((w) => w.order?.kind === "build")) {
      const w = builder ?? nearest(unfinished, workers)
      if (w) cmd.build(w, "pen", unfinished.x, unfinished.y)
    }
  } else if (pens.length < wantPens && gold >= 100) {
    const usable = obj.pastures.filter((p) => p.holder === null || p.holder === myTeam)
    const past = nearest(pens[0] ?? home, usable)
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
  // 弓手：工人够 6 个就开始出，每个牧栏 3 个，另外 2 个守家（狼拆完牧栏会去拆最近的建筑）
  if (barracks && (donePens.length > 0 || workers.length >= 6) && (barracks.queue?.length ?? 0) === 0 && archers.length < 3 * Math.max(1, donePens.length) + 2 && gold >= 80) {
    cmd.produce(barracks, "archer")
    gold -= 80
  }

  // 前 4 个工人采金，其余的当牛仔
  const miners = workers.filter((w) => w.id !== builderId && w.order?.kind !== "build").slice(0, 4)
  const cowboys = workers.filter((w) => w.id !== builderId && w.order?.kind !== "build" && !miners.includes(w))
  const load = new Map<number, number>()
  for (const w of miners) if (w.order?.kind === "gather") load.set(w.order.target, (load.get(w.order.target) ?? 0) + 1)
  for (const w of miners) {
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

  // 牛仔两两一组，每组去不同的野牛（离牧栏近的先）
  const wild = obj.bison.filter((b) => b.owner === -1).sort((a, b) => dist(anchor, a) - dist(anchor, b))
  for (let g = 0; g * 2 + 1 < cowboys.length; g++) {
    const target = wild[g % Math.max(1, wild.length)]
    for (let j = 0; j < 2; j++) {
      const c = cowboys[g * 2 + j]
      if (!target) {
        if (dist(c, anchor) > 3) cmd.move(c, anchor.x, anchor.y)
        continue
      }
      if (cheb(c, target) <= 1) {
        if (c.order?.kind === "move") cmd.stop(c)
        continue
      }
      const [dx, dy] = RING[(g * 2 + j) % RING.length]
      cmd.move(c, target.x + dx, target.y + dy)
    }
  }

  // 弓手：前 2 个守家，其余分到各个牧栏边；打靠近的狼和敌人（家门口来了就都回来打）
  const homeThreats = base ? threats.filter((h) => dist(h, base) <= 8) : []
  archers.forEach((a, i) => {
    const pen = i < 2 ? undefined : donePens[(i - 2) % Math.max(1, donePens.length)]
    const post: Pos = pen ?? home
    const t = nearest(a, homeThreats.length > 0 ? homeThreats : threats.filter((h) => dist(h, post) <= 7))
    if (t) {
      if (a.order?.kind !== "attack" || a.order.target !== t.id) cmd.attack(a, t)
    } else if (dist(a, post) > 3) cmd.move(a, post.x + 3, post.y + 1)
  })
}
