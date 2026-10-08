// 箭塔守家：建好兵营后在家门口和矿区连建 4 座箭塔，兵以枪兵为主（枪 2 弓 1），守在塔后面；攒到 18 个兵再推，打残了退回塔下。
// 枪兵加箭塔专防骑兵，碰上弓兵多的对手吃亏。
// 家门口的矿快采完时去分矿建仓库，旁边也补 1 座箭塔；被拆的箭塔会补建。

const ATTACK_AT = 18
const RETREAT_BELOW = 6
const MAX_PER_MINE = 3
const PLAN: TypeName[] = ["spearman", "spearman", "archer"]
const CREW: Partial<Record<TypeName, number>> = { barracks: 2, depot: 2, tower: 1 }
const HOME_TOWERS = 4

let mode: "defend" | "attack" = "defend"
let produced = 0
let expander: number | null = null

const isCombat = (e: Entity) => game.types[e.type].kind === "unit" && e.type !== "worker" && e.type !== "scout"
const isBuilding = (e: Entity) => game.types[e.type].kind === "building"

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

function naturalMines(base: Entity, enemyBase: Pos, mines: Entity[]): Entity[] {
  const far = mines.filter((m) => dist(base, m) > 12 && dist(base, m) < dist(enemyBase, m))
  const first = nearest(center(base), far)
  return first ? far.filter((m) => dist(m, first) <= 5) : []
}

function attack(cmd: Commands, u: Entity, t: Entity): void {
  if (u.order?.kind !== "attack" || u.order.target !== t.id) cmd.attack(u, t)
}

function attackMove(cmd: Commands, u: Entity, p: Pos): void {
  if (u.order?.kind !== "attackMove" || u.order.x !== p.x || u.order.y !== p.y) cmd.attackMove(u, p.x, p.y)
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
  const base = mine.find((e) => e.type === "base")
  if (!base) return
  const buildings = mine.filter(isBuilding)
  const all = (type: TypeName) => buildings.filter((b) => b.type === type)
  const done = (type: TypeName) => all(type).filter((b) => !b.construction)
  const workers = mine.filter((e) => e.type === "worker")
  const army = mine.filter(isCombat)
  const eb = view.objectives.enemyBases[0]
  const enemyCenter = { x: eb.x + 1, y: eb.y + 1 }
  const home = center(base)
  const drops = buildings.filter((b) => game.types[b.type].dropOff && !b.construction)
  const natural = naturalMines(base, enemyCenter, goldmines)
  const homeMines = goldmines.filter((m) => dist(m, base) <= 10)
  const homeGold = homeMines.reduce((a, m) => a + (m.amount ?? 0), 0)
  // 塔的位置：家门口朝对手的方向、家门口矿区的外侧，各两座
  const front = pointToward(home, enemyCenter, 5)
  const mineSide = homeMines.length ? pointToward(centroid(homeMines), enemyCenter, 2) : front
  const anchors = [front, mineSide, pointToward(home, enemyCenter, 8), pointToward(mineSide, home, -3)]
  const rally = pointToward(home, enemyCenter, 4)

  const threats = enemyUnits.filter((e) => dist(e, base) <= 13 || buildings.some((b) => dist(e, b) <= 8) || workers.some((w) => dist(e, w) <= 5))

  let gold = view.resources.gold
  let reserve = 0
  const busy = new Set<number>()
  const freeWorkers = () => workers.filter((w) => w.order?.kind !== "build" && w.id !== expander && !busy.has(w.id))
  const place = (type: TypeName, near: Pos): void => {
    const cost = game.types[type].cost.gold ?? 0
    if (gold < cost) {
      reserve = Math.max(reserve, cost)
      return
    }
    const spot = findBuildSpot(view, type, near, 6)
    const w = spot && nearest(spot, freeWorkers())
    if (!spot || !w) return
    cmd.build(w, type, spot.x, spot.y)
    busy.add(w.id)
    gold -= cost
  }

  // ---------- 建造：兵营 → 家门口的箭塔（被拆了就补）→ 家门口的矿快采完时开分矿 ----------
  const homeTowers = all("tower").filter((t) => dist(t, base) <= 14).length
  if (all("barracks").length === 0) place("barracks", pointToward(home, enemyCenter, 4))
  else if (done("barracks").length > 0 && homeTowers < HOME_TOWERS && (threats.length === 0 || homeTowers === 0)) place("tower", anchors[homeTowers % anchors.length])

  const wantDepot = natural.length > 0 && all("depot").length === 0 && homeTowers >= 2 && (homeGold < 700 || view.tick >= 3000)
  if (wantDepot && threats.length === 0) {
    let w = workers.find((u) => u.id === expander)
    if (!w) {
      w = nearest(centroid(natural), freeWorkers())
      expander = w?.id ?? null
    }
    if (w) {
      busy.add(w.id)
      const spot = pointToward(centroid(natural), home, 3)
      reserve = Math.max(reserve, 100)
      const found = gold >= 100 && dist(w, spot) <= 5 ? findBuildSpot(view, "depot", spot, 5) : null
      if (found) {
        cmd.build(w, "depot", found.x, found.y)
        gold -= 100
        expander = null
      } else if (dist(w, spot) > 2 && (w.order?.kind !== "move" || w.order.x !== spot.x || w.order.y !== spot.y)) cmd.move(w, spot.x, spot.y)
    }
  } else if (!wantDepot) expander = null
  const depot = done("depot")[0]
  if (depot && threats.length === 0 && !all("tower").some((t) => dist(t, depot) <= 6)) place("tower", pointToward(center(depot), enemyCenter, 3))

  for (const s of buildings.filter((b) => b.construction)) {
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
  const maxWorkers = done("depot").length > 0 ? 16 : 12
  if ((base.queue?.length ?? 0) === 0 && workers.length < maxWorkers && gold - reserve >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }
  for (const b of done("barracks")) {
    if ((b.queue?.length ?? 0) > 0) continue
    const type = PLAN[produced % PLAN.length]
    const cost = game.types[type].cost.gold ?? 0
    if (gold - reserve < cost) break
    cmd.produce(b, type)
    gold -= cost
    produced++
  }

  // ---------- 工人 ----------
  const defenders = new Set<number>()
  if (threats.length > army.length)
    for (const w of workers) {
      if (w.order?.kind === "build" || busy.has(w.id)) continue
      const t = threats.find((e) => dist(e, w) <= 3)
      if (t) {
        attack(cmd, w, t)
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

  // ---------- 军队：平时守在塔后面；来敌人就打（打在塔的射程里最好）；攒够了再推 ----------
  if (threats.length > 0) {
    for (const u of army) attack(cmd, u, nearest(u, threats)!)
    return
  }
  if (mode === "defend" && army.length >= ATTACK_AT) {
    mode = "attack"
    console.log(`第 ${view.tick} tick 出门，兵力 ${army.length}`)
  }
  if (mode === "attack" && army.length < RETREAT_BELOW) {
    mode = "defend"
    console.log(`第 ${view.tick} tick 退回塔下，只剩 ${army.length}`)
  }
  if (mode === "defend") {
    for (const u of army) if (dist(u, rally) > 3) attackMove(cmd, u, rally)
    return
  }
  const goal = enemyBuildings.find((e) => e.type === "tower") ?? enemyBuildings.find((e) => e.type === "barracks") ?? enemyBuildings.find((e) => e.type === "base")
  for (const u of army) {
    const fighters = enemyUnits.filter((e) => dist(e, u) <= 8)
    if (fighters.length > 0) attack(cmd, u, nearest(u, fighters)!)
    else if (goal && dist(u, goal) <= 12) attack(cmd, u, goal)
    else attackMove(cmd, u, enemyCenter)
  }
}
