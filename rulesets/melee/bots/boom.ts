// 先发展、坐山观虎斗：工人补到 14 个、采到两家之间和中间的矿，只守家（盟友家来敌人也去帮）；
// 攒够 16 个兵、或者已经有人出局了才出门，打离自己最近的敌人；打残了（剩不到 6 个）就撤回家。

const MAX_WORKERS = 14
const ATTACK_AT = 16
const RETREAT_BELOW = 6
const PLAN: TypeName[] = ["soldier", "archer", "archer"]
let attacking = false
let produced = 0

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

function attackOnce(cmd: Commands, u: Entity, t: Entity): void {
  if (u.order?.kind !== "attack" || u.order.target !== t.id) cmd.attack(u, t)
}

export function onTick(view: View, cmd: Commands): void {
  const team = view.players[view.me].team
  const isEnemy = (owner: number) => owner >= 0 && view.players[owner].team !== team
  const mine = view.entities.filter((e) => e.owner === view.me)
  const enemies = view.entities.filter((e) => isEnemy(e.owner))
  const base = mine.find((e) => e.type === "base")
  if (!base) return
  const barracks = mine.find((e) => e.type === "barracks")
  const workers = mine.filter((e) => e.type === "worker")
  const army = mine.filter((e) => e.type === "soldier" || e.type === "archer")
  const goldmines = view.entities.filter((e) => e.type === "goldmine")
  const home = { x: base.x + 1, y: base.y + 1 }
  const middle = { x: Math.floor(game.width / 2), y: Math.floor(game.height / 2) }
  let gold = view.resources.gold

  // 工人：每矿最多 3 人，按离主基地的距离挑，家门口的采完自然轮到更远的
  const load = new Map<number, number>()
  for (const w of workers) if (w.order?.kind === "gather") load.set(w.order.target, (load.get(w.order.target) ?? 0) + 1)
  for (const w of workers) {
    if (w.order?.kind === "gather" || w.order?.kind === "attack") continue
    const open = goldmines.filter((m) => (load.get(m.id) ?? 0) < 3)
    const m = nearest(base, open.length ? open : goldmines)
    if (!m) continue
    cmd.gather(w, m)
    load.set(m.id, (load.get(m.id) ?? 0) + 1)
  }

  if ((base.queue?.length ?? 0) === 0 && workers.length < MAX_WORKERS && gold >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }
  if (barracks && (barracks.queue?.length ?? 0) < 2 && workers.length >= 8) {
    const type = PLAN[produced % PLAN.length]
    const cost = game.types[type].cost.gold ?? 0
    if (gold >= cost) {
      cmd.produce(barracks, type)
      gold -= cost
      produced++
    }
  }

  // 自己家（主基地、兵营、采矿的工人附近）来敌人：全军回防，兵不够时附近的工人也上
  const threats = enemies.filter((e) => dist(e, base) <= 12 || (barracks && dist(e, barracks) <= 8) || workers.some((w) => dist(w, e) <= 4))
  if (threats.length > 0) {
    for (const u of army) attackOnce(cmd, u, nearest(u, threats)!)
    if (threats.length > army.length)
      for (const w of workers) {
        const t = threats.find((e) => dist(e, w) <= 3)
        if (t) attackOnce(cmd, w, t)
      }
    return
  }

  if (!attacking && (army.length >= ATTACK_AT || (view.objectives.eliminated.length > 0 && army.length >= ATTACK_AT / 2))) {
    attacking = true
    console.log(`第 ${view.tick} tick 出门，兵力 ${army.length}，已出局 ${view.objectives.eliminated.length} 家`)
  }
  const out = army.filter((u) => dist(u, base) > 15)
  if (attacking && out.length > 0 && army.length < RETREAT_BELOW) {
    attacking = false
    console.log(`第 ${view.tick} tick 撤回家，只剩 ${army.length}`)
  }

  if (!attacking) {
    // 盟友家门口来敌人就去帮，不然在家门口朝地图中间的方向集合
    const allyThreat = view.objectives.allyBases
      .map((b) => enemies.find((e) => dist(e, { x: b.x + 1, y: b.y + 1 }) <= 10))
      .find((e) => e !== undefined)
    const rally = { x: Math.round(home.x + (middle.x - home.x) * 0.2), y: Math.round(home.y + (middle.y - home.y) * 0.2) }
    for (const u of army) {
      if (allyThreat) attackOnce(cmd, u, allyThreat)
      else if (dist(u, rally) > 3 && (u.order?.kind !== "attackMove" || u.order.x !== rally.x || u.order.y !== rally.y)) cmd.attackMove(u, rally.x, rally.y)
    }
    return
  }

  const target = nearest(base, view.objectives.enemyBases)
  if (!target) return
  const goal = { x: target.x + 1, y: target.y + 1 }
  const enemyBase = enemies.find((e) => e.type === "base" && e.owner === target.owner)
  for (const u of army) {
    const fighters = enemies.filter((e) => game.types[e.type].kind === "unit" && dist(e, u) <= 6)
    if (fighters.length > 0) attackOnce(cmd, u, nearest(u, fighters)!)
    else if (enemyBase && dist(u, enemyBase) <= 10) attackOnce(cmd, u, enemyBase)
    else if (u.order?.kind !== "attackMove" || u.order.x !== goal.x || u.order.y !== goal.y) cmd.attackMove(u, goal.x, goal.y)
  }
}
