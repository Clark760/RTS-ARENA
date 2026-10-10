// 基准（均衡）：领主待在家里，身边 6 格内来了 3 个以上敌兵就放击退；兵战士弓手交替出，6～9 个兵时家里没事就去清最近的野怪营地（先在营地外聚齐，再集火血最少的那只），凑够 10 个兵出击，家里或领主附近来敌人全军回防。
// 用来衡量新 bot 的标准对手。
// - 领主：平时站在开局的角落，回防时跟着守军；6 格内有 3 个以上敌兵、击退冷却好了就放；
//   7 格内出现敌方的兵就跑回开局的角落，等敌人走了再回去。出击时领主不跟。
// - 经济：工人补到 12 个，按"离主基地近、人少"分配到各个金矿（每矿最多 3 人），点出来的新矿近就先采。
// - 防守：主基地 12 格、兵营 9 格、工人 5 格、领主 8 格内出现敌方单位就全军回防。
// - 进攻：在集结点凑够 10 个兵一起出发；对方兵力明显打空时不用凑够就去推家。看得见对方领主就先打领主。

const ATTACK_AT = 10
const REINFORCE_AT = 3
const RETREAT_BELOW = 4
const MAX_WORKERS = 12
const MAX_PER_MINE = 3
const ECO_FIRST = 10
const PLAN: TypeName[] = ["soldier", "archer"]
const enemySeen = new Map<number, number>()
const SEEN_FOR = 600

let mode: "defend" | "attack" = "defend"
let produced = 0
let rally: Pos | null = null
let lordHome: Pos | null = null
/** 正在清的营地（"x,y"）和开始去清它的 tick */
let farmCamp = ""
let farmSince = 0

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

/** attackMove 加 neutral：野怪也打，射程里有敌人先打敌人（D-191） */
function attackMoveNeutral(cmd: Commands, u: Entity, p: Pos): void {
  if (u.order?.kind !== "attackMove" || u.order.x !== p.x || u.order.y !== p.y || u.order.neutral !== true) cmd.attackMove(u, p.x, p.y, { neutral: true })
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
  if (lord) {
    lordHome ??= { x: lord.x, y: lord.y }
    const danger = enemyUnits.some((e) => game.types[e.type].attack !== null && e.type !== "worker" && dist(e, lord) <= 7)
    if (danger) {
      moveTo(cmd, lord, lordHome)
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
  let gold = view.resources.gold
  const baseIdle = (base.queue?.length ?? 0) === 0
  if (baseIdle && workers.length < ECO_FIRST && gold >= 50) {
    room-- > 0 && cmd.produce(base, "worker")
    gold -= 50
  }
  if (barracks && (workers.length >= ECO_FIRST || !baseIdle || gold >= 125)) {
    // 兵营排进队列的同时造（D-196，弑君歼灭是 5 个）：钱够就把队列排满
    for (let q = barracks.queue?.length ?? 0; q < game.types.barracks.parallel; q++) {
      const type = PLAN[produced % PLAN.length]
      const cost = game.types[type].cost.gold ?? 0
      if (gold < cost || room <= 0) break
      cmd.produce(barracks, type)
      room--
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
      // D-194（第四轮试写：一个个跑过去会被野怪逐个吃掉）：先在营地外 5 步聚齐（八成到了，或者等了 250 tick），
      // 再一起集火血最少的那只；附近 8 格有敌兵就改 attackMove 加 neutral（射程里先打敌兵）
      const key = `${camp.x},${camp.y}`
      if (farmCamp !== key) {
        farmCamp = key
        farmSince = view.tick
      }
      const stage = pointToward(camp, base, 5)
      const creeps = view.entities.filter((e) => e.type === "creep" && dist(e, camp) <= 8)
      const engaged = army.some((u) => creeps.some((k) => dist(k, u) <= 2))
      const gathered = army.filter((u) => dist(u, stage) <= 3).length >= army.length * 0.8
      const foes = enemyUnits.some((e) => isCombat(e) && army.some((u) => dist(e, u) <= 8))
      if (!engaged && !gathered && view.tick - farmSince < 250) for (const u of army) attackMove(cmd, u, stage)
      else if (foes || creeps.length === 0) for (const u of army) attackMoveNeutral(cmd, u, camp)
      else {
        const target = creeps.reduce((x, y) => (y.hp < x.hp ? y : x))
        for (const u of army) attack(cmd, u, target)
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
  retaliate(view, cmd)
  repel(view, cmd)
}

/**
 * 击退（D-197）：领主 6 格内有 3 个以上敌兵就放，把领主视野里的敌方单位推到视野外。
 * 放在每次决策的最后：击退当场生效，先放的话，后面对被推走的敌人下 attack 会被拒（看不到目标）
 */
function repel(view: View, cmd: Commands): void {
  const lord = view.entities.find((e) => e.owner === view.me && e.type === "lord")
  if (!lord || (lord.skillCooldowns?.repel ?? 1) !== 0) return
  const near = view.entities.filter((e) => e.owner >= 0 && e.owner !== view.me && isCombat(e) && dist(e, lord) <= 6)
  if (near.length >= 3) cmd.cast(lord, "repel")
}

/** 贴身的野怪咬过来就还手 */
function retaliate(view: View, cmd: Commands): void {
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
