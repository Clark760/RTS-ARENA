// 领主随军：领主跟在军队后面 3 格，团战时兵吃满光环（伤害 +20%、减伤 20%）；6、7 个兵时去清最近的野怪营地，8 个兵就出击，兵够 7 个就停下出兵攒钱召唤箭塔（在家放在集结点，出击时放在军队旁边，最多 3 座）。
// - 领主：出击时站在军队中心往自家方向退 3 格的地方，身边 4 格内有敌兵就往家撤；在家时和基准一样，钱够就在集结点召唤箭塔。
// - 其余（经济、生产、回防、挑目标）和基准一样，看得见对方领主就先打领主。
const ATTACK_AT = 8
const REINFORCE_AT = 3
const RETREAT_BELOW = 4
const MAX_WORKERS = 12
const MAX_PER_MINE = 3
/** 召唤箭塔（D-192）：一座 500 金，最多放几座，放完手上至少还留多少钱 */
const TOWER_COST = 500
const MAX_TOWERS = 3
/** 兵到这么多、冷却好了、家里没事就先不出兵，攒够 500 放塔（不到这么多兵时钱要多出 TOWER_RESERVE 才放） */
const SAVE_AT = 7
const TOWER_RESERVE = 100
const ECO_FIRST = 10
const PLAN: TypeName[] = ["soldier", "archer"]
const enemySeen = new Map<number, number>()
const SEEN_FOR = 600

let mode: "defend" | "attack" = "defend"
let produced = 0
let rally: Pos | null = null
let lordHome: Pos | null = null

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

function mainTick(view: View, cmd: Commands): void {
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
  const lord = mine.find((e) => e.type === "lord")
  const barracks = mine.find((e) => e.type === "barracks")
  const workers = mine.filter((e) => e.type === "worker")
  const army = mine.filter(isCombat)
  const eb = view.objectives.enemyBases[0]
  const enemyBaseCenter = { x: eb.x + 1, y: eb.y + 1 }
  rally ??= pointToward(barracks ?? base, enemyBaseCenter, 5)

  // ---------- 领主 ----------
  let towerGold = 0
  const wantTower = lord !== undefined && mine.filter((e) => e.type === "tower").length < MAX_TOWERS && (lord.skillCooldowns?.tower ?? 1) === 0
  if (lord) {
    lordHome ??= { x: lord.x, y: lord.y }
    const towerReady = wantTower && view.resources.gold >= TOWER_COST + (army.length >= SAVE_AT ? 0 : TOWER_RESERVE)
    const outArmy = army.filter((u) => dist(u, base) > 12)
    const close = enemyUnits.some((e) => game.types[e.type].attack !== null && e.type !== "worker" && dist(e, lord) <= 4)
    const danger = enemyUnits.some((e) => game.types[e.type].attack !== null && e.type !== "worker" && dist(e, lord) <= 7)
    if (mode === "attack" && outArmy.length >= 3 && !close) {
      // 跟着军队：站在军队中心往家退 3 格，兵在光环范围里
      moveTo(cmd, lord, pointToward(centroid(outArmy), base, 3))
      // 团战时召唤箭塔（D-192）：军队 10 格内有敌兵、钱够，就在领主往军队方向 2 格的地方放一座
      const spot = pointToward(lord, centroid(outArmy), 2)
      if (towerReady && enemyUnits.some((e) => isCombat(e) && dist(e, centroid(outArmy)) <= 10) && Math.abs(spot.x - lord.x) + Math.abs(spot.y - lord.y) <= 3) {
        cmd.cast(lord, "tower", spot)
        towerGold = TOWER_COST
      }
    } else if (danger) {
      moveTo(cmd, lord, lordHome)
    } else if (towerReady) {
      // 召唤箭塔（D-192）：走到集结点 3 格内，在集结点放一座（那格被占就放在旁边最近的空地）
      if (Math.abs(lord.x - rally.x) + Math.abs(lord.y - rally.y) <= 3) {
        cmd.cast(lord, "tower", rally)
        towerGold = TOWER_COST
      } else moveTo(cmd, lord, rally)
    } else moveTo(cmd, lord, lordHome)
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
  let gold = view.resources.gold - towerGold
  const baseIdle = (base.queue?.length ?? 0) === 0
  if (baseIdle && workers.length < ECO_FIRST && gold >= 50) {
    room-- > 0 && cmd.produce(base, "worker")
    gold -= 50
  }
  // 攒钱放塔（D-192）：兵够 SAVE_AT 个、家里没事、领主冷却好了，先不出兵
  const saving = wantTower && army.length >= SAVE_AT && threats.length === 0
  if (barracks && !saving && (barracks.queue?.length ?? 0) === 0 && (workers.length >= ECO_FIRST || !baseIdle || gold >= 125)) {
    const type = PLAN[produced % PLAN.length]
    const cost = game.types[type].cost.gold ?? 0
    if (gold >= cost) {
      room-- > 0 && cmd.produce(barracks, type)
      gold -= cost
      produced++
    }
  }
  if (baseIdle && workers.length >= ECO_FIRST && workers.length < MAX_WORKERS && gold >= 50) {
    room-- > 0 && cmd.produce(base, "worker")
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
    // 领主跟着回防的兵（光环盖住守军）；身边 4 格内有敌兵就不过去
    if (lord && lordHome && army.length >= 3 && !enemyUnits.some((e) => game.types[e.type].attack !== null && e.type !== "worker" && dist(e, lord) <= 4))
      moveTo(cmd, lord, pointToward(centroid(army), lordHome, 2))
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
    // 清野（D-189）：兵够 6 个、家里没事时去打离家最近的野怪营地，一只 150 金赏金
    const camp = army.length >= 6 ? view.objectives.creepCamps.filter((c) => c.alive > 0).sort((a, b) => dist(a, base) - dist(b, base) || campSide(a, base) - campSide(b, base))[0] : undefined
    if (camp) {
      const creeps = view.entities.filter((e) => e.type === "creep")
      for (const u of army) {
        let c: Entity | undefined
        for (const k of creeps) if (dist(k, u) <= 8 && (!c || dist(k, u) < dist(c, u))) c = k
        if (c) attack(cmd, u, c)
        else attackMove(cmd, u, camp)
      }
      return
    }
    for (const u of army) if (dist(u, rally) > 3) attackMove(cmd, u, rally)
    return
  }

  const goal = enemyBuildings.find((e) => e.type === "barracks") ?? enemyBuildings.find((e) => e.type === "base")
  const sendHome = home.length >= REINFORCE_AT || out.length === 0
  for (const u of army) {
    if (out.indexOf(u) < 0 && !sendHome) {
      if (dist(u, rally) > 3) attackMove(cmd, u, rally)
      continue
    }
    const fighters = enemyUnits.filter((e) => dist(e, u) <= 8 || (e.type === "lord" && dist(e, u) <= 10))
    if (fighters.length > 0) attack(cmd, u, pickTarget(u, fighters)!)
    else if (goal && dist(u, goal) <= 12) attack(cmd, u, goal)
    else attackMove(cmd, u, enemyBaseCenter)
  }
}

/**
 * 野怪（D-189）：玩家的兵不会自动打中立实体，贴上来打我的野怪要自己还手。
 * 先跑上面的主逻辑，再把身边 2 格内（弓兵是射程内）有野怪的兵改成打它（同一个兵后下的命令覆盖前面的）
 */
export function onTick(view: View, cmd: Commands): void {
  mainTick(view, cmd)
  const creeps = view.entities.filter((e) => e.type === "creep")
  if (creeps.length === 0) return
  for (const u of view.entities) {
    if (u.owner !== view.me || (u.type !== "soldier" && u.type !== "archer")) continue
    const reach = Math.max(2, game.types[u.type].attack!.range)
    let c: Entity | undefined
    for (const k of creeps) if (dist(k, u) <= reach && (!c || dist(k, u) < dist(c, u))) c = k
    if (c && !(u.order?.kind === "attack" && u.order.target === c.id)) cmd.attack(u, c)
  }
}

/** 选营地时距离打平：按自己这边看（右下那家把坐标镜像过来）先挑靠下的，两家各去自己那一侧的营地（D-191） */
function campSide(c: { x: number; y: number }, base: { x: number }): number {
  return base.x > game.width / 2 ? c.y : -c.y
}
