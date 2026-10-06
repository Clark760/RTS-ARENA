// 混战的基准 bot：用来衡量新 bot 的标准对手。和歼灭的基准 bot 基本相同，区别是：
// - 认得盟友（view.players[i].team 相同的）：不当敌人、不当威胁。
// - 目标：挑离"自己和盟友主基地的中心"最近、还没出局的敌人；队友算出来的是同一家，自然集火。集结点朝地图中心。
// - 出击时只拆目标那一家的兵营和主基地，路上碰到敌人的兵都打。
// - 自己家没事、在家集结时，盟友家门口来了敌人就去帮忙。
// - 经济：工人补到 11 个，按"离主基地近、人少"分配到各个金矿（每矿最多 3 人），家门口采完自动去中间。
// - 生产：工人优先补到 10 个，之后兵营不停地出兵，战士、弓手交替（战士在前面挡，弓手射程 4 在后面输出，混编比纯战士强）。
// - 防守：主基地 12 格、兵营 9 格、工人 5 格内出现敌方单位就全军回防；兵不够时附近的工人也上。
// - 进攻：在集结点凑够 10 个兵一起出发；对方兵力明显打空时（记住看到过、还没死的敌方兵）不用凑够就去推家。
//   先打看得见的敌方单位（射程内打血最少的战斗单位），再打兵营，最后打主基地。
//   出门的兵打残了（少于 4 个且打不过）就撤回集结点；进攻期间新出的兵在集结点凑够 3 个再去会合。

const ATTACK_AT = 10
const REINFORCE_AT = 3
const RETREAT_BELOW = 4
const MAX_WORKERS = 11
const MAX_PER_MINE = 3
const ECO_FIRST = 10
const PLAN: TypeName[] = ["soldier", "archer"]
/** 看到过的敌方战斗单位最后一次出现的 tick，用来估计对方兵力 */
const enemySeen = new Map<number, number>()
const SEEN_FOR = 600

let mode: "defend" | "attack" = "defend"
let produced = 0
let rally: Pos | null = null

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
    const score = d <= range ? e.hp - (isCombat(e) ? 1000 : 0) : 10000 + d * 10 + (isCombat(e) ? 0 : 50)
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
  const myTeam = view.players[view.me].team
  const mine: Entity[] = []
  const enemyUnits: Entity[] = []
  const enemyBuildings: Entity[] = []
  const goldmines: Entity[] = []
  for (const e of view.entities) {
    if (e.type === "goldmine") goldmines.push(e)
    else if (e.owner === view.me) mine.push(e)
    else if (e.owner >= 0 && view.players[e.owner].team !== myTeam) (game.types[e.type].kind === "unit" ? enemyUnits : enemyBuildings).push(e)
  }
  for (const e of enemyUnits) if (isCombat(e)) enemySeen.set(e.id, view.tick)
  for (const ev of view.events) if (ev.kind === "died") enemySeen.delete(ev.id)
  for (const [id, t] of enemySeen) if (view.tick - t > SEEN_FOR) enemySeen.delete(id)
  const enemyArmy = enemySeen.size

  const base = mine.find((e) => e.type === "base")
  if (!base) return
  const barracks = mine.find((e) => e.type === "barracks")
  const workers = mine.filter((e) => e.type === "worker")
  const army = mine.filter(isCombat)
  // 离全队主基地中心最近、还没出局的敌人（队友算出来的是同一家）
  const teamCenter = centroid([base, ...view.objectives.allyBases.map((b) => ({ x: b.x + 1, y: b.y + 1 }))])
  const targets = [...view.objectives.enemyBases].sort((a, b) => dist(a, teamCenter) - dist(b, teamCenter) || a.owner - b.owner)
  if (targets.length === 0) return
  const eb = targets[0]
  const enemyBaseCenter = { x: eb.x + 1, y: eb.y + 1 }
  rally ??= pointToward(barracks ?? base, { x: Math.floor(game.width / 2), y: Math.floor(game.height / 2) }, 5)

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
    // 盟友家门口有敌人：去帮忙
    const allyInTrouble = view.objectives.allyBases
      .map((b) => ({ x: b.x + 1, y: b.y + 1 }))
      .find((c) => enemyUnits.some((e) => dist(e, c) <= 12))
    for (const u of army) {
      if (allyInTrouble) {
        const near = enemyUnits.filter((e) => dist(e, allyInTrouble) <= 12 && dist(e, u) <= 10)
        if (near.length > 0) attack(cmd, u, pickTarget(u, near)!)
        else attackMove(cmd, u, allyInTrouble)
      } else if (dist(u, rally) > 3) attackMove(cmd, u, rally)
    }
    return
  }

  // 进攻：出门的兵按目标优先级打；家里的新兵凑够了再出发
  const theirs = enemyBuildings.filter((e) => e.owner === eb.owner)
  const goal = theirs.find((e) => e.type === "barracks") ?? theirs.find((e) => e.type === "base")
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
