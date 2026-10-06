// 基准（均衡）：工人补到 15 个分开采，出护卫守着自家工人，再派几个战士去对面的矿杀工人。
// 用来衡量新 bot 的标准对手。
// 分数是累计交货量，花钱不扣分，所以出兵不亏分数，只是少买几个工人。
// - 经济：主基地不停地造工人，补到 15 个；按"离主基地近、人少"分配到各个金矿（每矿最多 3 人），近处采完自动去远处。
// - 护卫：工人到 6 个起，钱先给兵营，出护卫守在自家工人附近，集火来犯的敌人。
//   护卫站在工人和对方之间，敌方单位进入自家工人 9 格内就拦截。一个兵都没有时，入侵者 4 格内的工人才上手。
// - 骚扰：工人到一定数量后钱也先给兵营，出几个战士去对面的矿杀工人（地图中心对称，对方主基地 = 自己主基地的对称位置）。
//   骚扰的兵凑齐了一起出发，没凑齐时和护卫一起守家；路上遇到不比自己少的敌方战士就先撤回家，下次再去。

const MAX_WORKERS = 15
const MAX_PER_MINE = 3
const GUARDS = 3
const RAIDERS = 3
const GUARDS_FROM_WORKERS = 6
const RAID_FROM_WORKERS = 12
/** 敌方单位离自家工人或主基地这么近就拦截 */
const INTERCEPT = 9

/** 已经分好工的兵：id -> 护卫 / 骚扰 */
const role = new Map<number, "guard" | "raid">()

const isCombat = (e: Entity) => e.type === "soldier" || e.type === "archer"

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

/** 射程内打血最少的（战斗单位优先），射程外打最近的 */
function pickTarget(u: Entity, enemies: Entity[]): Entity | undefined {
  const range = game.types[u.type].attack!.range
  let best: Entity | undefined
  let bestScore = Infinity
  for (const e of enemies) {
    const d = dist(u, e)
    const score = d <= range ? e.hp - (isCombat(e) ? 1000 : 0) : 10000 + d * 10
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

/** 走到 p 附近（3 格内算到了，免得一直挤同一格） */
function goNear(cmd: Commands, u: Entity, p: Pos): void {
  if (dist(u, p) <= 3) return
  if (u.order?.kind !== "attackMove" || u.order.x !== p.x || u.order.y !== p.y) cmd.attackMove(u, p.x, p.y)
}

export function onTick(view: View, cmd: Commands): void {
  const mine: Entity[] = []
  const enemyUnits: Entity[] = []
  const goldmines: Entity[] = []
  for (const e of view.entities) {
    if (e.type === "goldmine") goldmines.push(e)
    else if (e.owner === view.me) mine.push(e)
    else if (e.owner >= 0 && game.types[e.type].kind === "unit") enemyUnits.push(e)
  }
  const base = mine.find((e) => e.type === "base")
  if (!base) return
  const barracks = mine.find((e) => e.type === "barracks")
  const workers = mine.filter((e) => e.type === "worker")
  const soldiers = mine.filter(isCombat)
  const enemyBase = { x: game.width - base.x - base.w, y: game.height - base.y - base.h }

  // ---------- 分工：新出的兵先补护卫，再补骚扰 ----------
  for (const id of [...role.keys()]) if (!soldiers.some((s) => s.id === id)) role.delete(id)
  const count = (r: "guard" | "raid") => [...role.values()].filter((x) => x === r).length
  for (const s of soldiers) if (!role.has(s.id)) role.set(s.id, count("guard") < GUARDS ? "guard" : "raid")

  // ---------- 生产 ----------
  let gold = view.resources.gold
  const wantSoldiers =
    (workers.length >= GUARDS_FROM_WORKERS ? GUARDS : 0) + (workers.length >= RAID_FROM_WORKERS ? RAIDERS : 0)
  const barracksIdle = barracks !== undefined && (barracks.queue?.length ?? 0) === 0
  if (barracksIdle && soldiers.length < wantSoldiers && gold >= 75) {
    cmd.produce(barracks!, "soldier")
    gold -= 75
  }
  // 兵没出够时先攒钱给兵营（兵营在造的时候照常补工人）
  const saveForSoldier = soldiers.length < wantSoldiers && barracksIdle
  if ((base.queue?.length ?? 0) === 0 && workers.length < MAX_WORKERS && gold >= (saveForSoldier ? 125 : 50)) {
    cmd.produce(base, "worker")
    gold -= 50
  }

  // ---------- 工人 ----------
  const intruders = enemyUnits.filter((e) => workers.some((w) => dist(e, w) <= INTERCEPT) || dist(e, base) <= INTERCEPT)
  const fighting = new Set<number>()
  // 工人打兵很亏（还耽误采矿），只有一个兵都没有时才上手
  if (intruders.length > 0 && soldiers.length === 0) {
    for (const w of workers) {
      const near = intruders.filter((e) => dist(e, w) <= 4)
      if (near.length === 0) continue
      attack(cmd, w, pickTarget(w, near)!)
      fighting.add(w.id)
    }
  }
  const load = new Map<number, number>()
  for (const w of workers) if (w.order?.kind === "gather") load.set(w.order.target, (load.get(w.order.target) ?? 0) + 1)
  for (const w of workers) {
    if (fighting.has(w.id)) continue
    const o = w.order
    if (o?.kind === "gather" && goldmines.some((m) => m.id === o.target)) continue
    let best: Entity | undefined
    let bestScore = Infinity
    for (const m of goldmines) {
      const n = load.get(m.id) ?? 0
      if (n >= MAX_PER_MINE) continue
      // 对方家门口的矿不去（会被骚扰），实在没矿了再说
      const risky = dist(m, enemyBase) < dist(m, base)
      const score = dist(base, m) + n * 3 + (risky ? 40 : 0)
      if (score < bestScore) {
        best = m
        bestScore = score
      }
    }
    if (!best) continue
    cmd.gather(w, best)
    load.set(best.id, (load.get(best.id) ?? 0) + 1)
  }

  // ---------- 护卫（骚扰的兵没凑齐或打不过时也在这里） ----------
  // 护卫站在工人和对方之间，先把来犯的兵拦下
  const guardPost = pointToward(workers.length > 0 ? centroid(workers) : base, enemyBase, 3)
  let raiders = soldiers.filter((s) => role.get(s.id) === "raid")
  let raiding = raiders.length >= RAIDERS
  if (raiding) {
    const c = centroid(raiders)
    const enemyFighters = enemyUnits.filter((e) => isCombat(e) && dist(e, c) <= 8)
    if (enemyFighters.length >= raiders.length && dist(c, base) > 12) raiding = false
  }
  if (!raiding) raiders = []
  const guards = soldiers.filter((s) => raiders.indexOf(s) < 0)
  for (const g of guards) {
    if (intruders.length > 0) attack(cmd, g, pickTarget(g, intruders)!)
    else goNear(cmd, g, guardPost)
  }

  // ---------- 骚扰 ----------
  if (raiders.length === 0) return
  // 目标：对方那一侧离对方主基地最近的矿
  const enemyMines = goldmines.filter((m) => dist(m, enemyBase) < dist(m, base))
  const targetMine = nearest(enemyBase, enemyMines)
  for (const r of raiders) {
    const prey = enemyUnits.filter((e) => dist(e, r) <= 8)
    if (prey.length > 0) attack(cmd, r, pickTarget(r, prey)!)
    else if (targetMine) goNear(cmd, r, targetMine)
    else goNear(cmd, r, { x: enemyBase.x + 1, y: enemyBase.y + 4 })
  }
}
