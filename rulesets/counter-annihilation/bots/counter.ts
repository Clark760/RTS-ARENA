// 针对（看兵出兵）：记下看到过的敌方兵各有几个，出克它们的兵（枪兵克骑兵、骑兵克弓兵、弓兵克枪兵），按对方的配比配；
// 还没看清对方出什么兵时三种轮流出，第 300 tick 派一个工人去对方主基地前面 9 格的地方侦察。经济、集结、进攻、回防和基准一样。
// - 配比：对方每种兵按数量折成克它的兵（对方骑兵多就多出枪兵……），哪种兵比想要的比例差得最多就出哪种。
// - 敌方兵记 600 tick，看到死了就划掉，所以对方换兵种以后跟着换。

const ATTACK_AT = 10
const REINFORCE_AT = 3
const RETREAT_BELOW = 4
const MAX_WORKERS = 11
const MAX_PER_MINE = 3
const ECO_FIRST = 10
const PLAN: TypeName[] = ["spearman", "archer", "cavalry"]
/** 看到过的敌方战斗单位：类型、最后一次出现的 tick，用来估计对方兵力和配比 */
const enemySeen = new Map<number, { type: TypeName; t: number }>()
/** 侦察的工人：0 还没派，-1 不再派 */
let scoutId = 0
let scoutsSent = 0
const SCOUT_AT = 300
/** 每种兵被谁克 */
const COUNTER: Partial<Record<TypeName, TypeName>> = { spearman: "archer", cavalry: "spearman", archer: "cavalry" }
const SEEN_FOR = 600

let mode: "defend" | "attack" = "defend"
let produced = 0
let rally: Pos | null = null

const isCombat = (e: Entity) => game.types[e.type].kind === "unit" && e.type !== "worker"

/** u 打 e 一下的伤害：打被自己克的兵乘克制倍数（game.types[类型].attack.vs） */
function hitOn(u: Entity, e: Entity): number {
  const atk = game.types[u.type].attack!
  const dmg = u.stats?.attack?.damage ?? atk.damage
  return Math.max(1, Math.round(dmg * (atk.vs?.[e.type] ?? 1)))
}

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
  // 和当前命令相同的命令不会有任何影响，但少发一点更省燃料
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
  for (const e of enemyUnits) if (isCombat(e)) enemySeen.set(e.id, { type: e.type, t: view.tick })
  for (const ev of view.events) if (ev.kind === "died") enemySeen.delete(ev.id)
  for (const [id, s] of enemySeen) if (view.tick - s.t > SEEN_FOR) enemySeen.delete(id)
  const enemyArmy = enemySeen.size

  const base = mine.find((e) => e.type === "base")
  if (!base) return
  const barracks = mine.find((e) => e.type === "barracks")
  const workers = mine.filter((e) => e.type === "worker")
  const army = mine.filter(isCombat)
  const eb = view.objectives.enemyBases[0]
  const enemyBaseCenter = { x: eb.x + 1, y: eb.y + 1 }
  rally ??= pointToward(barracks ?? base, enemyBaseCenter, 5)

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
  if (barracks && (barracks.queue?.length ?? 0) === 0 && (workers.length >= ECO_FIRST || !baseIdle || gold >= 125)) {
    const type = nextType(army)
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
  // 侦察：还没看清对方出什么兵（看到的敌方兵不到 4 个），派一个工人到对方主基地前面 9 格的地方看着；看清了或者死了就回去采矿
  if (scoutId > 0 && !workers.some((w) => w.id === scoutId)) scoutId = scoutsSent < 2 ? 0 : -1
  if (scoutId > 0 && enemySeen.size >= 4) scoutId = -1
  if (scoutId === 0 && view.tick >= SCOUT_AT && enemySeen.size < 4 && workers.length >= 6) {
    const w = workers.find((x) => !x.carrying) ?? workers[0]
    scoutId = w.id
    scoutsSent++
  }
  const scout = workers.find((w) => w.id === scoutId)
  if (scout) {
    const spot = pointToward(enemyBaseCenter, base, 9)
    if (scout.order?.kind !== "move" || scout.order.x !== spot.x || scout.order.y !== spot.y) cmd.move(scout, spot.x, spot.y)
  }
  const defenders = new Set<number>()
  if (threats.length > army.length) {
    // 兵不够：离威胁 4 格内的工人一起打
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
    if (defenders.has(w.id) || w.id === scoutId) continue
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
    // 回防：全军打来犯的敌人
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

  // 进攻：出门的兵按目标优先级打；家里的新兵凑够了再出发
  const goal = enemyBuildings.find((e) => e.type === "barracks") ?? enemyBuildings.find((e) => e.type === "base")
  const sendHome = home.length >= REINFORCE_AT || out.length === 0
  for (const u of army) {
    if (out.indexOf(u) < 0 && !sendHome) {
      if (dist(u, rally) > 3) attackMove(cmd, u, rally)
      continue
    }
    const fighters = enemyUnits.filter((e) => dist(e, u) <= 8)
    if (fighters.length > 0) attack(cmd, u, pickTarget(u, fighters)!)
    else if (goal && dist(u, goal) <= 12) attack(cmd, u, goal)
    else attackMove(cmd, u, enemyBaseCenter)
  }
}
