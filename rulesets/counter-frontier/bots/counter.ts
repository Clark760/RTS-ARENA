// 针对（看兵出兵）：记下看到过的敌方兵各有几个，出克它们的兵（枪兵克骑兵、骑兵克弓兵、弓兵克枪兵），按对方的配比配。
// 开局就派侦察兵去对方主基地前面 15 格的地方盯着（敌人的视野最多 7，侦察兵 8），敌方兵到 8 格内、工人到 3 格内就往回退一段，过一会再回去；还没看清对方出什么兵时三种轮流出。
// 经济、建造、集结、进攻、回防和基准一样。
// - 配比：对方每种兵按数量折成克它的兵（对方骑兵多就多出枪兵……），哪种兵比想要的比例差得最多就出哪种。
// - 敌方兵记 600 tick，看到死了就划掉，所以对方换兵种以后跟着换。

const ATTACK_AT = 10
const REINFORCE_AT = 3
const RETREAT_BELOW = 4
const MAX_PER_MINE = 3
const PLAN: TypeName[] = ["spearman", "archer", "cavalry"]
/** 每种地基要几个工人建 */
const CREW: Partial<Record<TypeName, number>> = { barracks: 2, depot: 2, tower: 1 }
/** 看到过的敌方战斗单位：类型、最后一次出现的 tick，用来估计对方兵力和配比 */
const enemySeen = new Map<number, { type: TypeName; t: number }>()
/** 侦察兵盯着的地方离对方主基地几格；敌方兵靠近时退到哪个 tick 为止、往哪里跑 */
const SCOUT_DIST = 15
let scoutBackUntil = 0
let scoutFlee: Pos | null = null
/** 每种兵被谁克 */
const COUNTER: Partial<Record<TypeName, TypeName>> = { spearman: "archer", cavalry: "spearman", archer: "cavalry" }
const SEEN_FOR = 600

let mode: "defend" | "attack" = "defend"
let produced = 0
let rally: Pos | null = null
/** 去分矿建仓库的工人 */
let expander: number | null = null

const isCombat = (e: Entity) => game.types[e.type].kind === "unit" && e.type !== "worker" && e.type !== "scout"

/** u 打 e 一下的伤害：打被自己克的兵乘克制倍数（game.types[类型].attack.vs） */
function hitOn(u: Entity, e: Entity): number {
  const atk = game.types[u.type].attack!
  const dmg = u.stats?.attack?.damage ?? atk.damage
  return Math.max(1, Math.round(dmg * (atk.vs?.[e.type] ?? 1)))
}
const isBuilding = (e: Entity) => game.types[e.type].kind === "building"

/** 下一个出什么兵：对方的兵折成克它们的兵当想要的配比，出和想要的比例差得最多的那种 */
function nextType(army: Entity[]): TypeName {
  if (enemySeen.size < 3) return PLAN[produced % PLAN.length]
  const want = new Map<TypeName, number>()
  for (const { type } of enemySeen.values()) {
    const c = COUNTER[type]
    if (c) want.set(c, (want.get(c) ?? 0) + 1)
  }
  const have = new Map<TypeName, number>()
  for (const u of army) have.set(u.type, (have.get(u.type) ?? 0) + 1)
  let best = PLAN[produced % PLAN.length]
  let bestGap = -Infinity
  for (const t of PLAN) {
    const gap = (want.get(t) ?? 0) / enemySeen.size - (have.get(t) ?? 0) / Math.max(1, army.length)
    if (gap > bestGap) {
      best = t
      bestGap = gap
    }
  }
  return best
}

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

function centroid(list: Pos[]): Pos {
  let x = 0
  let y = 0
  for (const p of list) {
    x += p.x
    y += p.y
  }
  return { x: Math.round(x / list.length), y: Math.round(y / list.length) }
}

function center(e: Entity): Pos {
  return { x: e.x + Math.floor(e.w / 2), y: e.y + Math.floor(e.h / 2) }
}

function walkable(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < game.width && y < game.height && game.walkable[game.terrain[y][x]] === true
}

/** 从 p 往 toward 方向走 steps 格，找最近的可走格 */
function pointToward(p: Pos, toward: Pos, steps: number): Pos {
  const dx = toward.x - p.x
  const dy = toward.y - p.y
  const len = Math.abs(dx) + Math.abs(dy) || 1
  const c = { x: Math.round(p.x + (dx / len) * steps), y: Math.round(p.y + (dy / len) * steps) }
  for (let r = 0; r < 8; r++)
    for (let ox = -r; ox <= r; ox++)
      for (const oy of [r - Math.abs(ox), -(r - Math.abs(ox))]) if (walkable(c.x + ox, c.y + oy)) return { x: c.x + ox, y: c.y + oy }
  return c
}

/**
 * 在 near 附近找能放 type 的左上角：按离 near 的距离从近到远，最远 maxR 格。
 * 占地四周一格内不能有建筑和金矿（留出走路的空），也不占金矿和它的交货点之间的矩形（采矿的路），
 * 最后用 canBuild 确认（地形、单位、视野）。
 */
function findSpot(view: View, type: TypeName, near: Pos, maxR: number): Pos | null {
  const d = game.types[type]
  const W = game.width
  const taken = new Uint8Array(W * game.height)
  const mark = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = Math.max(0, y0); y <= Math.min(game.height - 1, y1); y++)
      for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) taken[y * W + x] = 1
  }
  const drops = view.entities.filter((e) => e.owner === view.me && game.types[e.type].dropOff)
  for (const e of view.entities) {
    const kind = game.types[e.type].kind
    if (kind === "unit") continue
    mark(e.x - 1, e.y - 1, e.x + e.w, e.y + e.h)
    const dp = kind === "resource" ? nearest(e, drops) : undefined
    if (dp && dist(dp, e) <= 12)
      mark(Math.min(e.x, dp.x), Math.min(e.y, dp.y), Math.max(e.x + e.w, dp.x + dp.w) - 1, Math.max(e.y + e.h, dp.y + dp.h) - 1)
  }
  const x0 = near.x - Math.floor(d.w / 2)
  const y0 = near.y - Math.floor(d.h / 2)
  for (let r = 0; r <= maxR; r++)
    for (let ox = -r; ox <= r; ox++)
      for (const oy of r === Math.abs(ox) ? [0] : [r - Math.abs(ox), -(r - Math.abs(ox))]) {
        const x = x0 + ox
        const y = y0 + oy
        if (x < 1 || y < 1 || x + d.w > W - 1 || y + d.h > game.height - 1) continue
        let ok = true
        for (let yy = y; yy < y + d.h && ok; yy++) for (let xx = x; xx < x + d.w && ok; xx++) if (taken[yy * W + xx]) ok = false
        if (ok && canBuild(view, type, x, y)) return { x, y }
      }
  return null
}

/** 射程内打几下就能打死的（战斗单位优先，被自己克的自然排前面），射程外打最近的（被自己克的多走几格也去） */
function pickTarget(u: Entity, enemies: Entity[]): Entity | undefined {
  const range = game.types[u.type].attack!.range
  let best: Entity | undefined
  let bestScore = Infinity
  for (const e of enemies) {
    const d = dist(u, e)
    const score = d <= range ? Math.ceil(e.hp / hitOn(u, e)) - (isCombat(e) ? 1000 : 0) : 10000 + d * 10 + (isCombat(e) ? 0 : 50) - (hitOn(u, e) > game.types[u.type].attack!.damage ? 40 : 0)
    if (score < bestScore) {
      best = e
      bestScore = score
    }
  }
  return best
}

function attack(cmd: Commands, u: Entity, t: Entity): void {
  if (u.order?.kind !== "attack" || u.order.target !== t.id) cmd.attack(u, t)
}

function attackMove(cmd: Commands, u: Entity, p: Pos): void {
  if (u.order?.kind !== "attackMove" || u.order.x !== p.x || u.order.y !== p.y) cmd.attackMove(u, p.x, p.y)
}

/** 分矿：离自己主基地 12 格以外、比离对手近的金矿里最近的一个，连同它 5 格内的金矿 */
function naturalMines(base: Entity, enemyBase: Pos, mines: Entity[]): Entity[] {
  const far = mines.filter((m) => dist(base, m) > 12 && dist(base, m) < dist(enemyBase, m))
  const first = nearest(center(base), far)
  return first ? far.filter((m) => dist(m, first) <= 5) : []
}

export function onTick(view: View, cmd: Commands): void {
  const mine: Entity[] = []
  const enemyUnits: Entity[] = []
  const enemyBuildings: Entity[] = []
  const goldmines: Entity[] = []
  for (const e of view.entities) {
    if (e.type === "goldmine") goldmines.push(e)
    else if (e.owner === view.me) mine.push(e)
    else if (e.owner >= 0) (game.types[e.type].kind === "unit" ? enemyUnits : enemyBuildings).push(e)
  }
  for (const e of enemyUnits) if (isCombat(e)) enemySeen.set(e.id, { type: e.type, t: view.tick })
  for (const ev of view.events) if (ev.kind === "died") enemySeen.delete(ev.id)
  for (const [id, s] of enemySeen) if (view.tick - s.t > SEEN_FOR) enemySeen.delete(id)
  const enemyArmy = enemySeen.size

  const base = mine.find((e) => e.type === "base")
  if (!base) return
  const buildings = mine.filter(isBuilding)
  const done = (type: TypeName) => buildings.filter((b) => b.type === type && !b.construction)
  const all = (type: TypeName) => buildings.filter((b) => b.type === type)
  const sites = buildings.filter((b) => b.construction)
  const barracks = done("barracks")
  const workers = mine.filter((e) => e.type === "worker")
  const army = mine.filter(isCombat)
  const eb = view.objectives.enemyBases[0]
  const enemyBaseCenter = { x: eb.x + 1, y: eb.y + 1 }
  const home = center(base)
  if (!rally && barracks.length > 0) rally = pointToward(center(barracks[0]), enemyBaseCenter, 5)
  const rallyPoint = rally ?? pointToward(home, enemyBaseCenter, 5)
  const drops = buildings.filter((b) => game.types[b.type].dropOff && !b.construction)
  const natural = naturalMines(base, enemyBaseCenter, goldmines)
  const homeGold = goldmines.filter((m) => dist(m, base) <= 10).reduce((a, m) => a + (m.amount ?? 0), 0)

  // ---------- 侦察兵：去对方主基地前面盯着对方出什么兵；8 格内有敌方兵（它们看不见 8 格外）、3 格内有敌方工人就往回退 8 格，150 tick 后再回去 ----------
  const scout = mine.find((e) => e.type === "scout")
  if (scout) {
    // 往远离最近那个敌人的方向跑（侦察兵走一格 1 tick，比谁都快）
    const threat = nearest(scout, enemyUnits.filter((e) => (isCombat(e) && dist(e, scout) <= 8) || (e.type === "worker" && dist(e, scout) <= 3)))
    if (threat) {
      scoutBackUntil = view.tick + 150
      scoutFlee = pointToward(threat, scout, dist(threat, scout) + 8)
    }
    const spot = view.tick < scoutBackUntil ? (scoutFlee ?? pointToward(enemyBaseCenter, base, SCOUT_DIST + 8)) : pointToward(enemyBaseCenter, base, SCOUT_DIST)
    if (dist(scout, spot) > 1 && (scout.order?.kind !== "move" || scout.order.x !== spot.x || scout.order.y !== spot.y)) cmd.move(scout, spot.x, spot.y)
  }

  // ---------- 威胁 ----------
  const threats = enemyUnits.filter(
    (e) => dist(e, base) <= 12 || buildings.some((b) => dist(e, b) <= 8) || workers.some((w) => dist(e, w) <= 5),
  )

  // ---------- 建造：每次最多新放一块地基；钱不够就把钱留着（生产只花留下之外的钱） ----------
  let gold = view.resources.gold
  let reserve = 0
  const busy = new Set<number>() // 这次已经派了活的工人
  const freeWorkers = () => workers.filter((w) => w.order?.kind !== "build" && w.id !== expander && !busy.has(w.id))
  const place = (type: TypeName, near: Pos, maxR: number): void => {
    const cost = game.types[type].cost.gold ?? 0
    if (gold < cost) {
      reserve = cost
      return
    }
    const spot = findSpot(view, type, near, maxR)
    const w = spot && nearest(spot, freeWorkers())
    if (!spot || !w) return
    cmd.build(w, type, spot.x, spot.y)
    busy.add(w.id)
    gold -= cost
  }
  if (threats.length === 0) {
    const towers = all("tower")
    const depots = all("depot")
    if (all("barracks").length === 0) place("barracks", pointToward(home, enemyBaseCenter, 6), 8)
    else if (barracks.length > 0 && towers.length === 0 && army.length >= 2) place("tower", pointToward(home, enemyBaseCenter, 4), 6)
    else if (barracks.length === 1 && all("barracks").length === 1 && workers.length >= 12 && view.tick >= 1500)
      place("barracks", pointToward(center(barracks[0]), home, 0), 8)
    else if (done("depot").length > 0 && towers.length === 1 && army.length >= 6) place("tower", pointToward(center(depots[0]), enemyBaseCenter, 3), 6)
  }

  // 开分矿：家门口不够用了就派一个工人过去，走到看得见的地方再放仓库
  const wantDepot = natural.length > 0 && all("depot").length === 0 && done("tower").length > 0 && (homeGold < 900 || workers.length >= 12)
  if (wantDepot && threats.length === 0) {
    let w = workers.find((u) => u.id === expander)
    if (!w) {
      w = nearest(centroid(natural), freeWorkers())
      expander = w?.id ?? null
    }
    if (w) {
      busy.add(w.id)
      const spot = pointToward(centroid(natural), home, 3)
      if (gold < 100) reserve = Math.max(reserve, 100)
      const found = gold >= 100 && dist(w, spot) <= 6 ? findSpot(view, "depot", spot, 5) : null
      if (found) {
        cmd.build(w, "depot", found.x, found.y)
        gold -= 100
        expander = null
      } else if (dist(w, spot) > 2 && (w.order?.kind !== "move" || w.order.x !== spot.x || w.order.y !== spot.y)) cmd.move(w, spot.x, spot.y)
    }
  } else if (!wantDepot) expander = null

  // 每块地基补够工人（工人死了、或者刚放下只派了一个）
  for (const s of sites) {
    let crew = workers.filter((w) => w.order?.kind === "build" && w.order.target === s.id).length
    while (crew < (CREW[s.type] ?? 1)) {
      const w = nearest(s, freeWorkers())
      if (!w || dist(w, s) > 25) break
      cmd.build(w, s.type, s.x, s.y)
      busy.add(w.id)
      crew++
    }
  }

  // ---------- 生产 ----------
  const maxWorkers = done("depot").length > 0 ? 18 : 12
  if ((base.queue?.length ?? 0) === 0 && workers.length < maxWorkers && gold - reserve >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }
  for (const b of barracks) {
    if ((b.queue?.length ?? 0) > 0) continue
    const type = nextType(army)
    const cost = game.types[type].cost.gold ?? 0
    if (gold - reserve < cost) break
    cmd.produce(b, type)
    gold -= cost
    produced++
  }

  // ---------- 工人 ----------
  const defenders = new Set<number>()
  if (threats.length > army.length) {
    for (const w of workers) {
      if (w.order?.kind === "build") continue
      const near = threats.filter((t) => dist(t, w) <= 4)
      if (near.length === 0) continue
      attack(cmd, w, pickTarget(w, near)!)
      defenders.add(w.id)
    }
  }
  const load = new Map<number, number>()
  for (const w of workers) if (w.order?.kind === "gather") load.set(w.order.target, (load.get(w.order.target) ?? 0) + 1)
  for (const w of workers) {
    if (defenders.has(w.id) || busy.has(w.id) || w.order?.kind === "build") continue
    const o = w.order
    if (o?.kind === "gather" && goldmines.some((m) => m.id === o.target)) continue
    let best: Entity | undefined
    let bestScore = Infinity
    for (const m of goldmines) {
      const n = load.get(m.id) ?? 0
      if (n >= MAX_PER_MINE) continue
      const drop = nearest(m, drops)
      const score = (drop ? dist(drop, m) : 99) + n * 3
      if (score < bestScore) {
        best = m
        bestScore = score
      }
    }
    if (!best) continue
    cmd.gather(w, best)
    load.set(best.id, (load.get(best.id) ?? 0) + 1)
  }

  // ---------- 军队 ----------
  if (threats.length > 0) {
    for (const u of army) attack(cmd, u, pickTarget(u, threats)!)
    return
  }

  const inside = army.filter((u) => dist(u, base) <= 15)
  const out = army.filter((u) => dist(u, base) > 15)
  const gathered = inside.every((u) => dist(u, rallyPoint) <= 6)
  const enemyWeak = view.tick > 2000 && army.length >= 4 && army.length >= enemyArmy * 2
  if (mode === "defend" && gathered && (army.length >= ATTACK_AT || enemyWeak)) {
    mode = "attack"
    console.log(`第 ${view.tick} tick 进攻，兵力 ${army.length}，估计对方 ${enemyArmy}`)
  }
  if (mode === "attack" && out.length > 0 && out.length < RETREAT_BELOW) {
    const around = enemyUnits.filter((e) => isCombat(e) && dist(e, centroid(out)) <= 10)
    if (around.length >= out.length) {
      mode = "defend"
      console.log(`第 ${view.tick} tick 撤退，外面只剩 ${out.length} 个`)
    }
  }

  if (mode === "defend") {
    for (const u of army) if (dist(u, rallyPoint) > 3) attackMove(cmd, u, rallyPoint)
    return
  }

  // 进攻：先打看得见的敌方单位，再拆箭塔、兵营，最后打主基地
  const goal =
    enemyBuildings.find((e) => e.type === "tower") ?? enemyBuildings.find((e) => e.type === "barracks") ?? enemyBuildings.find((e) => e.type === "base")
  const sendHome = inside.length >= REINFORCE_AT || out.length === 0
  for (const u of army) {
    if (out.indexOf(u) < 0 && !sendHome) {
      if (dist(u, rallyPoint) > 3) attackMove(cmd, u, rallyPoint)
      continue
    }
    const fighters = enemyUnits.filter((e) => dist(e, u) <= 8)
    if (fighters.length > 0) attack(cmd, u, pickTarget(u, fighters)!)
    else if (goal && dist(u, goal) <= 12) attack(cmd, u, goal)
    else attackMove(cmd, u, enemyBaseCenter)
  }
}
