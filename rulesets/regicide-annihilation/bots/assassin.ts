// 刺杀：凑够 12 个兵（战士弓手 2:1）带着领主出门，直奔对方领主开局的角落，看得见对方领主就全体追着打（杀了领主直接赢）。
// - 没看见对方领主时去它开局的角落找（和自己领主的开局位置中心对称），路上只打 5 格内挡路的兵。
// - 领主跟在军队后面 3 格（和领主随军一样），冷却好了先回家点金；其余（经济、回防）和基准一样。
const ATTACK_AT = 12
const REINFORCE_AT = 3
const RETREAT_BELOW = 4
const MAX_WORKERS = 12
const MAX_PER_MINE = 3
const ECO_FIRST = 10
const PLAN: TypeName[] = ["soldier", "soldier", "archer"]
const enemySeen = new Map<number, number>()
const SEEN_FOR = 600

let mode: "defend" | "attack" = "defend"
let produced = 0
let rally: Pos | null = null
let lordHome: Pos | null = null
let post: Pos | null = null

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
  for (const e of enemyUnits) if (isCombat(e)) enemySeen.set(e.id, view.tick)
  for (const ev of view.events) if (ev.kind === "died") enemySeen.delete(ev.id)
  for (const [id, t] of enemySeen) if (view.tick - t > SEEN_FOR) enemySeen.delete(id)
  const enemyArmy = enemySeen.size

  const base = mine.find((e) => e.type === "base")
  if (!base) return
  const lord = mine.find((e) => e.type === "lord")
  const barracks = mine.find((e) => e.type === "barracks")
  const workers = mine.filter((e) => e.type === "worker")
  const army = mine.filter(isCombat)
  const eb = view.objectives.enemyBases[0]
  const enemyBaseCenter = { x: eb.x + 1, y: eb.y + 1 }
  rally ??= pointToward(barracks ?? base, enemyBaseCenter, 5)

  // ---------- 领主 ----------
  if (lord) {
    lordHome ??= { x: lord.x, y: lord.y }
    const outArmy = army.filter((u) => dist(u, base) > 12)
    const close = enemyUnits.some((e) => game.types[e.type].attack !== null && e.type !== "worker" && dist(e, lord) <= 4)
    const danger = enemyUnits.some((e) => game.types[e.type].attack !== null && e.type !== "worker" && dist(e, lord) <= 7)
    const ready = (lord.skillCooldowns?.goldmine ?? 1) === 0
    if (mode === "attack" && outArmy.length >= 3 && !close && !ready) {
      // 跟着军队：站在军队中心往家退 3 格，兵在光环范围里
      moveTo(cmd, lord, pointToward(centroid(outArmy), base, 3))
      post = null
    } else if (danger) {
      moveTo(cmd, lord, lordHome)
      post = null
    } else {
      const occ = staticCells(view)
      if (!post || !openCell(post.x, post.y, occ)) {
        const home = goldmines.filter((m) => dist(m, base) <= 12)
        post = findPost(home.length ? centroid(home) : { x: base.x + 1, y: base.y + 1 }, occ)
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

  // ---------- 威胁 ----------
  const threats = enemyUnits.filter(
    (e) =>
      dist(e, base) <= 12 ||
      (barracks !== undefined && dist(e, barracks) <= 9) ||
      (lord !== undefined && dist(e, lord) <= 8) ||
      workers.some((w) => dist(e, w) <= 5),
  )

  // ---------- 生产 ----------
  let gold = view.resources.gold
  const baseIdle = (base.queue?.length ?? 0) === 0
  if (baseIdle && workers.length < ECO_FIRST && gold >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }
  if (barracks && (barracks.queue?.length ?? 0) === 0 && (workers.length >= ECO_FIRST || !baseIdle || gold >= 125)) {
    const type = PLAN[produced % PLAN.length]
    const cost = game.types[type].cost.gold ?? 0
    if (gold >= cost) {
      cmd.produce(barracks, type)
      gold -= cost
      produced++
    }
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

  const home = army.filter((u) => dist(u, base) <= 15)
  const out = army.filter((u) => dist(u, base) > 15)
  const gathered = home.every((u) => dist(u, rally!) <= 6)
  const enemyWeak = view.tick > 1500 && army.length >= 4 && army.length >= enemyArmy * 2
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
    for (const u of army) if (dist(u, rally) > 3) attackMove(cmd, u, rally)
    return
  }

  // 对方领主：看得见就全体追；看不见就去它开局的角落（和自己领主的开局位置中心对称）
  const enemyLord = enemyUnits.find((e) => e.type === "lord")
  const lordCorner = lordHome ? { x: game.width - 1 - lordHome.x, y: game.height - 1 - lordHome.y } : enemyBaseCenter
  const sendHome = home.length >= REINFORCE_AT || out.length === 0
  for (const u of army) {
    if (out.indexOf(u) < 0 && !sendHome) {
      if (dist(u, rally) > 3) attackMove(cmd, u, rally)
      continue
    }
    if (enemyLord && dist(enemyLord, u) <= 14) {
      attack(cmd, u, enemyLord)
      continue
    }
    const fighters = enemyUnits.filter((e) => isCombat(e) && dist(e, u) <= 5)
    if (fighters.length > 0) attack(cmd, u, pickTarget(u, fighters)!)
    else attackMove(cmd, u, lordCorner)
  }
}
