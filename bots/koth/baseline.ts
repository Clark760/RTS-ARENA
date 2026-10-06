// 夺点的基准 bot：用来衡量新 bot 的标准对手。
// - 经济、生产和歼灭的基准 bot 相同：工人优先补到 10 个，之后兵营不停地出战士，工人按"离主基地近、人少"分配到金矿。
// - 防守：主基地 12 格、兵营 9 格、工人 5 格内出现敌方单位就全军回防；兵不够时附近的工人也上。
// - 占点：兵凑够 3 个、而且不少于估计的对方兵力（记住看到过、还没死的敌方兵）就去控制点，在点里分散站位，
//   打靠近控制点、进入自己视野的敌人（射程内打血最少的战斗单位）。对方兵多时退回家门口：那里有工人帮忙、援兵也近。
//   但对方离获胜只差 250 分以内、而且领先时，不管打不打得过都全军压上（缩在家里只会输）。

const GO_AT = 3
/** 对方离获胜还差这么多分时，打不过也全军压上 */
const ALL_IN_WITHIN = 250
const MAX_WORKERS = 11
const MAX_PER_MINE = 3
const ECO_FIRST = 10
/** 打离控制点这么近的敌人 */
const ZONE_GUARD = 8

let produced = 0
let homeRally: Pos | null = null
/** 看到过的敌方战斗单位最后一次出现的 tick，用来估计对方兵力 */
const enemySeen = new Map<number, number>()
const SEEN_FOR = 600

const isCombat = (e: Entity) => e.type === "soldier" || e.type === "archer"

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
    const score = d <= range ? e.hp - (isCombat(e) ? 1000 : 0) : 10000 + d * 10 + (isCombat(e) ? 0 : 50)
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

export function onTick(view: View, cmd: Commands): void {
  const mine: Entity[] = []
  const enemyUnits: Entity[] = []
  const goldmines: Entity[] = []
  for (const e of view.entities) {
    if (e.type === "goldmine") goldmines.push(e)
    else if (e.owner === view.me) mine.push(e)
    else if (e.owner >= 0 && game.types[e.type].kind === "unit") enemyUnits.push(e)
  }
  for (const e of enemyUnits) if (isCombat(e)) enemySeen.set(e.id, view.tick)
  for (const ev of view.events) if (ev.kind === "died") enemySeen.delete(ev.id)
  for (const [id, t] of enemySeen) if (view.tick - t > SEEN_FOR) enemySeen.delete(id)
  const enemyArmy = enemySeen.size

  const base = mine.find((e) => e.type === "base")
  if (!base) return
  const barracks = mine.find((e) => e.type === "barracks")
  const workers = mine.filter((e) => e.type === "worker")
  const army = mine.filter(isCombat).sort((a, b) => a.id - b.id)
  const zone = view.objectives.zone
  const zoneCenter = { x: zone.x + Math.floor(zone.w / 2), y: zone.y + Math.floor(zone.h / 2) }
  homeRally ??= pointToward(barracks ?? base, zoneCenter, 4)

  // ---------- 威胁 ----------
  const threats = enemyUnits.filter(
    (e) => dist(e, base) <= 12 || (barracks !== undefined && dist(e, barracks) <= 9) || workers.some((w) => dist(e, w) <= 5),
  )

  // ---------- 生产 ----------
  let gold = view.resources.gold
  const baseIdle = (base.queue?.length ?? 0) === 0
  if (baseIdle && workers.length < ECO_FIRST && gold >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }
  if (barracks && (barracks.queue?.length ?? 0) === 0 && (workers.length >= ECO_FIRST || !baseIdle || gold >= 125) && gold >= 75) {
    cmd.produce(barracks, "soldier")
    gold -= 75
    produced++
  }
  if (baseIdle && workers.length >= ECO_FIRST && workers.length < MAX_WORKERS && gold >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }

  // ---------- 工人 ----------
  const defenders = new Set<number>()
  if (threats.length > army.length) {
    for (const w of workers) {
      const near = threats.filter((t) => dist(t, w) <= 4)
      if (near.length === 0) continue
      attack(cmd, w, pickTarget(w, near)!)
      defenders.add(w.id)
    }
  }
  const load = new Map<number, number>()
  for (const w of workers) if (w.order?.kind === "gather") load.set(w.order.target, (load.get(w.order.target) ?? 0) + 1)
  for (const w of workers) {
    if (defenders.has(w.id)) continue
    const o = w.order
    if (o?.kind === "gather" && goldmines.some((m) => m.id === o.target)) continue
    let best: Entity | undefined
    let bestScore = Infinity
    for (const m of goldmines) {
      const n = load.get(m.id) ?? 0
      if (n >= MAX_PER_MINE) continue
      const score = dist(base, m) + n * 3
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
  const contesters = enemyUnits.filter((e) => dist(e, zone) <= ZONE_GUARD)
  const enemyStrength = Math.max(enemyArmy, contesters.filter(isCombat).length)
  // 兵太少或打不过：退回家门口
  // 对方快拿满分了：不打就输，全军压上
  const pts = view.objectives.points
  const theirs = Math.max(...pts.filter((_, i) => i !== view.me))
  const desperate = theirs > pts[view.me] && view.objectives.target - theirs <= ALL_IN_WITHIN
  const holdBack = !desperate && (army.length < GO_AT || army.length < enemyStrength)
  army.forEach((u, i) => {
    if (holdBack) {
      if (dist(u, homeRally!) > 3) attackMove(cmd, u, homeRally!)
      return
    }
    const close = contesters.filter((e) => dist(e, u) <= game.types[u.type].sight + 2)
    if (close.length > 0) {
      attack(cmd, u, pickTarget(u, close)!)
      return
    }
    // 控制点里的格子按编号分给各个单位，免得挤在一格
    const spot = { x: zone.x + (i % zone.w), y: zone.y + (Math.floor(i / zone.w) % zone.h) }
    if (u.x !== spot.x || u.y !== spot.y) attackMove(cmd, u, spot)
  })

  if (view.tick % 500 === 0) {
    const c = army.length ? centroid(army) : base
    console.log(`控制分 ${view.objectives.points.join(" : ")}，兵力 ${army.length}（中心 ${c.x},${c.y}），点附近敌兵 ${enemyStrength}`)
  }
}
