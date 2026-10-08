// 骑兵速攻：开局就建兵营、补到 8 个工人再建第二座，只出骑兵（走得快、克弓兵）；凑够 5 个冲对方家，之后造出来的直接往前补，打残了退回来再凑一波。
// 不建箭塔、仓库。进攻时先打身边打几下就死的兵和工人（弓兵最先），再拆射到自己的箭塔，然后打主基地。怕枪兵和箭塔。

const FIRST_WAVE = 5
const MAX_WORKERS = 8
const PER_MINE = 3
/** 前线剩不到这么多、对面兵又比自己多时撤回集结点 */
const HOLD = 3

let attacking = false

const isFighter = (e: Entity) => game.types[e.type].kind === "unit" && e.type !== "worker" && e.type !== "scout"

/** u 打 e 一下的伤害：打被自己克的兵乘克制倍数（game.types[类型].attack.vs） */
function hitOn(u: Entity, e: Entity): number {
  const atk = game.types[u.type].attack!
  const dmg = u.stats?.attack?.damage ?? atk.damage
  return Math.max(1, Math.round(dmg * (atk.vs?.[e.type] ?? 1)))
}
const goldOf = (t: TypeName) => game.types[t].cost.gold ?? 0

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

function center(e: Entity): Pos {
  return { x: e.x + Math.floor(e.w / 2), y: e.y + Math.floor(e.h / 2) }
}

/** 从 p 往 toward 走 steps 格，落在能走的格子上 */
function toward(p: Pos, to: Pos, steps: number): Pos {
  const dx = to.x - p.x
  const dy = to.y - p.y
  const len = Math.abs(dx) + Math.abs(dy) || 1
  const c = { x: Math.round(p.x + (dx / len) * steps), y: Math.round(p.y + (dy / len) * steps) }
  for (let r = 0; r < 8; r++)
    for (let ox = -r; ox <= r; ox++)
      for (const oy of [r - Math.abs(ox), Math.abs(ox) - r]) {
        const x = c.x + ox
        const y = c.y + oy
        if (x >= 0 && y >= 0 && x < game.width && y < game.height && game.walkable[game.terrain[y][x]]) return { x, y }
      }
  return c
}

/** 射程内挑打几下就能打死的（兵优先，被自己克的自然排前面），射程外打最近的 */
function pick(u: Entity, list: Entity[]): Entity | undefined {
  const range = u.stats?.attack?.range ?? game.types[u.type].attack?.range ?? 1
  let best: Entity | undefined
  let bestScore = Infinity
  for (const e of list) {
    const d = dist(u, e)
    const score = d <= range ? Math.ceil(e.hp / hitOn(u, e)) - (isFighter(e) ? 1000 : 0) : 10_000 + d * 10
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
  const mine = view.entities.filter((e) => e.owner === view.me)
  const base = mine.find((e) => e.type === "base")
  if (!base) return
  const home = center(base)
  const eb = view.objectives.enemyBases[0]
  const enemyHome = { x: eb.x + 1, y: eb.y + 1 }
  const rally = toward(home, enemyHome, 9)
  const workers = mine.filter((e) => e.type === "worker")
  const soldiers = mine.filter((e) => e.type === "cavalry")
  const barracks = mine.filter((e) => e.type === "barracks")
  const built = barracks.filter((b) => !b.construction)
  const enemies = view.entities.filter((e) => e.owner >= 0 && e.owner !== view.me)
  const enemyUnits = enemies.filter((e) => game.types[e.type].kind === "unit")
  let gold = view.resources.gold
  const busy = new Set<number>()

  // ---------- 兵营：第一座马上建，工人补到 6 个后建第二座；地基不够人就补人 ----------
  const wantBarracks = barracks.length === 0 || (barracks.length === 1 && built.length === 1 && workers.length >= 6)
  if (wantBarracks && gold >= goldOf("barracks")) {
    const spot = findBuildSpot(view, "barracks", toward(home, enemyHome, 6), 9)
    const w = spot && nearest(spot, workers.filter((u) => u.order?.kind !== "build"))
    if (spot && w) {
      cmd.build(w, "barracks", spot.x, spot.y)
      busy.add(w.id)
      gold -= goldOf("barracks")
    }
  }
  for (const s of barracks.filter((b) => b.construction)) {
    let crew = workers.filter((u) => u.order?.kind === "build" && u.order.target === s.id).length
    // 第一座全员上（越快出兵越好），第二座 2 个人
    const want = built.length === 0 ? workers.length : 2
    while (crew < want) {
      const w = nearest(s, workers.filter((u) => !busy.has(u.id) && u.order?.kind !== "build"))
      if (!w) break
      cmd.build(w, "barracks", s.x, s.y)
      busy.add(w.id)
      crew++
    }
  }
  const saving = wantBarracks && barracks.length > 0 ? goldOf("barracks") : 0

  // ---------- 生产：兵营先出战士，剩下的钱补工人 ----------
  for (const b of built) {
    if ((b.queue?.length ?? 0) > 0 || gold - saving < goldOf("cavalry")) continue
    cmd.produce(b, "cavalry")
    gold -= goldOf("cavalry")
  }
  if ((base.queue?.length ?? 0) === 0 && workers.length < MAX_WORKERS && gold - saving >= goldOf("worker")) cmd.produce(base, "worker")

  // ---------- 工人：采离主基地最近的矿，每矿最多 3 人 ----------
  const mines = view.entities.filter((e) => game.types[e.type].kind === "resource" && (e.amount ?? 0) > 0).sort((a, b) => dist(a, base) - dist(b, base))
  const load = new Map<number, number>()
  for (const w of workers) if (w.order?.kind === "gather") load.set(w.order.target, (load.get(w.order.target) ?? 0) + 1)
  for (const w of workers) {
    if (busy.has(w.id) || w.order?.kind === "build" || w.order?.kind === "gather") continue
    const m = mines.find((x) => (load.get(x.id) ?? 0) < PER_MINE)
    if (!m) continue
    cmd.gather(w, m)
    load.set(m.id, (load.get(m.id) ?? 0) + 1)
  }

  // ---------- 军队 ----------
  // 家里来敌人：家附近的兵先回防
  const threats = enemyUnits.filter((e) => dist(e, base) <= 10)
  const front = soldiers.filter((s) => dist(s, base) > 14)
  const enemyFighters = enemyUnits.filter(isFighter)
  if (!attacking && soldiers.length >= FIRST_WAVE && soldiers.every((s) => dist(s, rally) <= 5)) {
    attacking = true
    console.log(`第 ${view.tick} tick 冲锋，${soldiers.length} 个兵`)
  }
  if (attacking && front.length > 0 && front.length < HOLD) {
    const around = enemyFighters.filter((e) => front.some((s) => dist(s, e) <= 7))
    if (around.length > front.length) {
      attacking = false
      console.log(`第 ${view.tick} tick 撤回，前线只剩 ${front.length} 个`)
    }
  }
  if (attacking && soldiers.length === 0) attacking = false

  for (const s of soldiers) {
    const near = enemyUnits.filter((e) => dist(e, s) <= 6)
    if (threats.length > 0 && dist(s, base) <= 14) {
      attack(cmd, s, pick(s, threats)!)
      continue
    }
    if (!attacking) {
      if (near.length > 0) attack(cmd, s, pick(s, near)!)
      else if (dist(s, rally) > 3) attackMove(cmd, s, rally)
      continue
    }
    // 进攻：身边的兵和工人 → 射得到自己的箭塔 → 主基地 → 往对方家走
    const tower = enemies.find((e) => e.type === "tower" && !e.construction && dist(e, s) <= 6)
    const enemyBase = enemies.find((e) => e.type === "base")
    if (near.length > 0) attack(cmd, s, pick(s, near)!)
    else if (tower) attack(cmd, s, tower)
    else if (enemyBase && dist(enemyBase, s) <= 12) attack(cmd, s, enemyBase)
    else attackMove(cmd, s, enemyHome)
  }
}
