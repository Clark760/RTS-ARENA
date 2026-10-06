// 猎手：只出弓箭手，站在射程外清野怪和守卫拿赏金、抢台址（野怪和守卫不会动、只能打贴身的）；钱多了再盖第二座兵营。
// 先把自己这侧、中央、对方那侧的野怪都清掉。

const BEACON_COST = game.types.beacon.cost.gold ?? 75
const BARRACKS_COST = game.types.barracks.cost.gold ?? 150

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

function inSite(e: Entity, s: Site): boolean {
  return e.x >= s.x && e.y >= s.y && e.x + e.w <= s.x + s.w && e.y + e.h <= s.y + s.h
}

/** 台址中间的格子；偶数边长时两家各取靠自己的那格，保证两边对称 */
function mid(s: Site): Pos {
  if (game.me === 0) return { x: s.x + Math.floor((s.w - 1) / 2), y: s.y + Math.floor((s.h - 1) / 2) }
  return { x: s.x + s.w - 1 - Math.floor((s.w - 1) / 2), y: s.y + s.h - 1 - Math.floor((s.h - 1) / 2) }
}

function spotIn(view: View, type: TypeName, x0: number, y0: number, w: number, h: number, from: Pos): Pos | undefined {
  const t = game.types[type]
  const spots: Pos[] = []
  for (let y = y0; y + t.h <= y0 + h; y++) for (let x = x0; x + t.w <= x0 + w; x++) if (canBuild(view, type, x, y)) spots.push({ x, y })
  if (view.me === 1) spots.reverse()
  return nearest(from, spots)
}

let secondBarracksAt: Pos | null = null

export function onTick(view: View, cmd: Commands): void {
  const me = view.me
  const enemy = 1 - me
  const mine = view.entities.filter((e) => e.owner === me)
  const base = mine.find((e) => e.type === "base")
  if (!base) return
  const workers = mine.filter((e) => e.type === "worker")
  const archers = mine.filter((e) => e.type === "archer" || e.type === "soldier")
  const barracks = mine.filter((e) => e.type === "barracks")
  const myBeacons = mine.filter((e) => e.type === "beacon")
  const mines = view.entities.filter((e) => e.type === "goldmine")
  const enemies = view.entities.filter((e) => e.owner >= 0 && e.owner !== me)
  const monsters = view.entities.filter((e) => e.owner === -1 && e.maxHp > 0)
  const sites = view.objectives.sites
  const site = (n: string) => sites.find((s) => s.name === n)!
  let gold = view.resources.gold

  for (const ev of view.events) if (ev.kind === "rejected") {
    console.log("被拒", ev.command.kind, ev.reason)
    if (ev.command.kind === "build" && ev.command.type === "barracks") secondBarracksAt = null
  }

  // ---------- 建造：没建好的接着建，然后按顺序抢台址，最后第二座兵营 ----------
  const busy = new Set<number>()
  for (const w of workers) if (w.order?.kind === "build" || w.order?.kind === "move") busy.add(w.id)
  for (const b of [...myBeacons, ...barracks]) {
    if (!b.construction) continue
    if (workers.some((w) => w.order?.kind === "build" && w.order.target === b.id)) continue
    const w = nearest(b, workers.filter((w) => !busy.has(w.id)))
    if (w) {
      cmd.build(w, b.type, b.x, b.y)
      busy.add(w.id)
    }
  }
  const order = [site("home" + me), site("flank" + me), site("center"), site("flank" + enemy)]
  const want = order.find((s) => s.monsters === 0 && s.holder !== me && !myBeacons.some((b) => inSite(b, s)))
  const building = workers.some((w) => w.order?.kind === "build")
  if (want && !building && workers.length >= 4) {
    const w = nearest(mid(want), workers)!
    const spot = spotIn(view, "beacon", want.x, want.y, want.w, want.h, w)
    if (spot && gold >= BEACON_COST) {
      cmd.build(w, "beacon", spot.x, spot.y)
      gold -= BEACON_COST
      busy.add(w.id)
    } else if (!spot && dist(w, mid(want)) > 1) {
      cmd.move(w, mid(want).x, mid(want).y)
      busy.add(w.id)
    }
  } else if (!want && !building && barracks.length < 2 && gold >= BARRACKS_COST + 40) {
    // 第二座兵营盖在主基地旁边（留一格路）
    const w = nearest(base, workers.filter((w) => !busy.has(w.id)))
    const spot = secondBarracksAt ?? spotIn(view, "barracks", base.x - 1, base.y + 4, 6, 4, base)
    if (w && spot) {
      cmd.build(w, "barracks", spot.x, spot.y)
      secondBarracksAt = spot
      gold -= BARRACKS_COST
      busy.add(w.id)
    }
  }

  // ---------- 生产 ----------
  if ((base.queue?.length ?? 0) === 0 && workers.length < 8 && gold >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }
  for (const b of barracks) {
    if (b.construction || (b.queue?.length ?? 0) > 0) continue
    if (workers.length >= 4 && gold >= 80 + (want ? 40 : 0)) {
      cmd.produce(b, "archer")
      gold -= 80
    }
  }

  // ---------- 采集 ----------
  const load = new Map<number, number>()
  for (const w of workers) if (w.order?.kind === "gather") load.set(w.order.target, (load.get(w.order.target) ?? 0) + 1)
  for (const w of workers) {
    if (busy.has(w.id)) continue
    if (w.order?.kind === "gather" && mines.some((m) => m.id === (w.order as { target: number }).target)) continue
    const m = nearest(base, mines.filter((m) => (load.get(m.id) ?? 0) < 3))
    if (!m) continue
    cmd.gather(w, m)
    load.set(m.id, (load.get(m.id) ?? 0) + 1)
  }

  // ---------- 弓箭手 ----------
  if (archers.length === 0) return
  const guard: Entity[] = [base, ...myBeacons, ...workers]
  const threat = enemies.find((e) => guard.some((g) => dist(e, g) <= 5))
  // 按顺序找还有野怪的台址：看得见野怪就点名打，看不见就走过去
  const hunts = [site("flank" + me), site("center"), site("flank" + enemy)]
  const minNeeded = [2, 3, 5]
  let huntSite: Site | undefined
  for (let i = 0; i < hunts.length; i++) if (hunts[i].monsters > 0 && archers.length >= minNeeded[i]) {
    huntSite = hunts[i]
    break
  }
  const enemyBeacon = nearest(archers[0], enemies.filter((e) => e.type === "beacon"))
  for (const a of archers) {
    if (threat) {
      if (!(a.order?.kind === "attack" && a.order.target === threat.id)) cmd.attack(a, threat)
      continue
    }
    if (huntSite) {
      const prey = nearest(a, monsters.filter((m) => inSite(m, huntSite!)))
      if (prey) {
        if (!(a.order?.kind === "attack" && a.order.target === prey.id)) cmd.attack(a, prey)
      } else {
        // 停在台址外 3 格，等看见野怪
        const p = mid(huntSite)
        const tx = p.x + (base.x < p.x ? -4 : 4)
        if (!(a.order?.kind === "move")) cmd.move(a, Math.max(0, Math.min(game.width - 1, tx)), p.y)
      }
      continue
    }
    if (enemyBeacon && archers.length >= 6) {
      if (!(a.order?.kind === "attack" && a.order.target === enemyBeacon.id)) cmd.attack(a, enemyBeacon)
      continue
    }
    const enemyHeld = sites.filter((s) => s.holder === enemy || s.holder === -2)
    const goal = archers.length >= 6 && enemyHeld.length > 0 ? mid(nearest(a, enemyHeld)!) : mid(site("center"))
    const gx = goal.x + (me === 0 ? -3 : 3)
    if (a.order?.kind === "idle" && dist(a, { x: gx, y: goal.y }) <= 3) continue
    if (a.order?.kind === "attackMove" && a.order.x === gx && a.order.y === goal.y) continue
    if (a.order?.kind === "attack") continue
    cmd.attackMove(a, gx, goal.y)
  }
}
