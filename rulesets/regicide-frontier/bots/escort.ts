// 领主随军：拓荒的基准打法，领主跟在军队后面 3 格，团战时兵吃满光环（伤害 +25%、减伤 25%）；8 个兵就出击，冷却好了先回家点金再追上。
// - 领主：出击时站在军队中心往家退 3 格的地方，身边 4 格内有敌兵就不跟、7 格内有敌兵就往家撤；在家时在矿边点金。
// - 其余（建造、经济、回防、挑目标）和基准一样，看得见对方领主就先打领主。
const ATTACK_AT = 8
const REINFORCE_AT = 3
const RETREAT_BELOW = 4
const MAX_PER_MINE = 3
const PLAN: TypeName[] = ["soldier", "archer"]
/** 每种地基要几个工人建 */
const CREW: Partial<Record<TypeName, number>> = { barracks: 2, depot: 2, tower: 1 }
const enemySeen = new Map<number, number>()
const SEEN_FOR = 600

let mode: "defend" | "attack" = "defend"
let produced = 0
let rally: Pos | null = null
/** 去分矿建仓库的工人 */
let expander: number | null = null
/** 领主开局的位置（被追时往这里躲）和点金的站位 */
let lordHome: Pos | null = null
let post: Pos | null = null

const isCombat = (e: Entity) => e.type === "soldier" || e.type === "archer"
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

/** 射程内打血最少的（战斗单位优先），射程外打最近的 */
function pickTarget(u: Entity, enemies: Entity[]): Entity | undefined {
  const range = game.types[u.type].attack!.range
  let best: Entity | undefined
  let bestScore = Infinity
  for (const e of enemies) {
    const d = dist(u, e)
    // 领主最优先，其次射程内血最少的战斗单位
    const score = e.type === "lord" && d <= 10 ? -100000 + d : d <= range ? e.hp - (isCombat(e) ? 1000 : 0) : 10000 + d * 10 + (isCombat(e) ? 0 : 50)
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

function moveTo(cmd: Commands, u: Entity, p: Pos): void {
  if (u.x === p.x && u.y === p.y) return
  if (u.order?.kind !== "move" || u.order.x !== p.x || u.order.y !== p.y) cmd.move(u, p.x, p.y)
}

/** 建筑、资源点占着的格子 */
function staticCells(view: View): Set<number> {
  const s = new Set<number>()
  for (const e of view.entities) {
    if (game.types[e.type].kind === "unit") continue
    for (let y = e.y; y < e.y + e.h; y++) for (let x = e.x; x < e.x + e.w; x++) s.add(y * game.width + x)
  }
  return s
}

/** 这一格和上下左右都能走、没有建筑和资源点：领主站这里点金，金矿出现在旁边也不会把它围住 */
function openCell(x: number, y: number, occ: Set<number>): boolean {
  for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx
    const ny = y + dy
    if (!walkable(nx, ny) || occ.has(ny * game.width + nx)) return false
  }
  return true
}

function findPost(anchor: Pos, occ: Set<number>): Pos | null {
  for (let r = 0; r <= 10; r++)
    for (let ox = -r; ox <= r; ox++)
      for (const oy of r === Math.abs(ox) ? [0] : [r - Math.abs(ox), -(r - Math.abs(ox))]) {
        const x = anchor.x + ox
        const y = anchor.y + oy
        if (openCell(x, y, occ)) return { x, y }
      }
  return null
}

/** 分矿：离自己主基地 12 格以外、比离对手近的金矿里最近的一个，连同它 5 格内的金矿 */
function naturalMines(base: Entity, enemyBase: Pos, mines: Entity[]): Entity[] {
  const far = mines.filter((m) => dist(base, m) > 12 && dist(base, m) < dist(enemyBase, m))
  const first = nearest(center(base), far)
  return first ? far.filter((m) => dist(m, first) <= 5) : []
}

export function onTick(view: View, cmd: Commands): void {
  // 单位数（含生产队列）到上限就不再排生产，排了也会被拒
  const own = view.entities.filter((e) => e.owner === view.me)
  let room = game.unitCap > 0 ? game.unitCap - own.filter((e) => game.types[e.type].kind === "unit").length - own.reduce((a, e) => a + (e.queue?.length ?? 0), 0) : Infinity
  const mine: Entity[] = []
  const enemyUnits: Entity[] = []
  const enemyBuildings: Entity[] = []
  const goldmines: Entity[] = []
  for (const e of view.entities) {
    if (e.type === "goldmine") goldmines.push(e)
    else if (e.owner === view.me) mine.push(e)
    else if (e.owner >= 0) (game.types[e.type].kind === "unit" ? enemyUnits : enemyBuildings).push(e)
  }
  for (const e of enemyUnits) if (isCombat(e)) enemySeen.set(e.id, view.tick)
  for (const ev of view.events) if (ev.kind === "died") enemySeen.delete(ev.id)
  for (const [id, t] of enemySeen) if (view.tick - t > SEEN_FOR) enemySeen.delete(id)
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

  // ---------- 领主 ----------
  const lord = mine.find((e) => e.type === "lord")
  if (lord) {
    lordHome ??= { x: lord.x, y: lord.y }
    // 出击时跟着军队：站在军队中心往家退 3 格，兵在光环范围里；4 格内有敌兵、或者冷却好了要回家点金时不跟
    const outArmy = army.filter((u) => dist(u, base) > 12)
    const close = enemyUnits.some((e) => game.types[e.type].attack !== null && e.type !== "worker" && dist(e, lord) <= 4)
    const ready = (lord.skillCooldowns?.goldmine ?? 1) === 0
    if (mode === "attack" && outArmy.length >= 3 && !close && !ready) {
      moveTo(cmd, lord, pointToward(centroid(outArmy), home, 3))
      post = null
    } else {
    const danger = enemyUnits.some((e) => game.types[e.type].attack !== null && e.type !== "worker" && dist(e, lord) <= 7)
    if (danger) {
      moveTo(cmd, lord, lordHome)
      post = null
    } else {
      // 在家门口的金矿边找一格四周都空着的地方站着，点金冷却好了就放
      const occ = staticCells(view)
      if (!post || !openCell(post.x, post.y, occ)) {
        const near = goldmines.filter((m) => dist(m, base) <= 10)
        post = findPost(near.length ? centroid(near) : home, occ)
      }
      if (post) {
        if (lord.x !== post.x || lord.y !== post.y) moveTo(cmd, lord, post)
        else if ((lord.skillCooldowns?.goldmine ?? 1) === 0) {
          cmd.cast(lord, "goldmine")
          post = null
        }
      }
    }
    }
  }

  // ---------- 威胁 ----------
  const threats = enemyUnits.filter(
    (e) =>
      dist(e, base) <= 12 ||
      buildings.some((b) => dist(e, b) <= 8) ||
      (lord !== undefined && dist(e, lord) <= 8) ||
      workers.some((w) => dist(e, w) <= 5),
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
    room-- > 0 && cmd.produce(base, "worker")
    gold -= 50
  }
  for (const b of barracks) {
    if ((b.queue?.length ?? 0) > 0) continue
    const type = PLAN[produced % PLAN.length]
    const cost = game.types[type].cost.gold ?? 0
    if (gold - reserve < cost) break
    room-- > 0 && cmd.produce(b, type)
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
    // 领主跟着回防的兵（光环盖住守军）；身边 4 格内有敌兵就不过去
    if (lord && lordHome && army.length >= 3 && !enemyUnits.some((e) => game.types[e.type].attack !== null && e.type !== "worker" && dist(e, lord) <= 4))
      moveTo(cmd, lord, pointToward(centroid(army), lordHome, 2))
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
    const fighters = enemyUnits.filter((e) => dist(e, u) <= 8 || (e.type === "lord" && dist(e, u) <= 10))
    if (fighters.length > 0) attack(cmd, u, pickTarget(u, fighters)!)
    else if (goal && dist(u, goal) <= 12) attack(cmd, u, goal)
    else attackMove(cmd, u, enemyBaseCenter)
  }
}
