// 领主随军：领主跟在军队后面 3 格，团战时兵吃满光环（伤害 +20%、减伤 20%）；6、7 个兵时去清最近的野怪营地（先聚齐再集火），8 个兵就出击；领主 6 格内有 3 个以上敌兵就放击退；家里没事、兵够 10 个先去抢中央宝箱（快刷新时先开到宝箱的位置上占位，刷出来了就在旁边聚齐再点名打），野怪咬过来附近的兵一起集火还手。
// - 领主：出击时站在军队中心往自家方向退 3 格的地方，身边 4 格内有敌兵就往家撤；在家时和基准一样。
// - 其余（经济、生产、回防、挑目标）和基准一样，看得见对方领主就先打领主。
const ATTACK_AT = 8
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
    const outArmy = army.filter((u) => dist(u, base) > 12)
    const close = enemyUnits.some((e) => game.types[e.type].attack !== null && e.type !== "worker" && dist(e, lord) <= 4)
    const danger = enemyUnits.some((e) => game.types[e.type].attack !== null && e.type !== "worker" && dist(e, lord) <= 7)
    if (mode === "attack" && outArmy.length >= 3 && !close) {
      // 跟着军队：站在军队中心往家退 3 格，兵在光环范围里
      moveTo(cmd, lord, pointToward(centroid(outArmy), base, 3))
    } else if (danger) {
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
  // 对面那一侧的矿不去（走过去要横穿地图、路过营地）；野怪营地正在出手时，营地 8 格内（野怪追击的范围）的矿先别去，
  // 营地安静了再回去采（D-202/203：营地一打起来，矿边的工人整批被野怪打死；可一直躲着中间矿，家门口采完就没钱了）
  const risky = (m: Entity) => dist(m, base) > dist(m, eb) || view.objectives.creepCamps.some((c) => c.angry && c.alive > 0 && c.cells.some((p) => dist(m, p) <= 8))
  const load = new Map<number, number>()
  for (const w of workers) if (w.order?.kind === "gather") load.set(w.order.target, (load.get(w.order.target) ?? 0) + 1)
  for (const w of workers) {
    if (defenders.has(w.id)) continue
    const o = w.order
    if (o?.kind === "gather" && goldmines.some((m) => m.id === o.target && !risky(m))) continue
    let best: Entity | undefined
    let bestScore = Infinity
    for (const m of goldmines) {
      if (risky(m)) continue
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
    // 中央宝箱（D-202）：兵够 10 个、家里没事就先去打离家近的那个宝箱，打掉得 600 金
    const chest = army.length >= 10 ? [...view.objectives.treasure.chests].sort((a, b) => dist(a, base) - dist(b, base))[0] : undefined
    // 宝箱快刷新了（D-205）：兵够 10 个、家里没事就先开到宝箱的位置上等着，刷新那一刻占着位置（人比对手多）就直接捡到
    const tr = view.objectives.treasure
    const soon = !chest && army.length >= 10 && tr.nextAt - view.tick <= 150 ? [...tr.spots].sort((a, b) => dist(a, base) - dist(b, base))[0] : undefined
    if (soon) {
      for (const u of army) attackMove(cmd, u, { x: soon.x, y: soon.y })
      return
    }
    if (chest) {
      // D-203：和清野一样先在宝箱外 6 步聚齐（八成到了，或者等了 250 tick），再一起点名打宝箱。
      // 不用 attackMove 加 neutral：它会去追视野里的野怪，宝箱 5～7 格外就是营地，整个营地被惹出来；野怪咬过来由 retaliate 集火还手
      const key = `宝箱${chest.x},${chest.y}`
      if (farmCamp !== key) {
        farmCamp = key
        farmSince = view.tick
      }
      const spot = { x: chest.x, y: chest.y }
      const stage = pointToward(spot, base, 6)
      const near = army.some((u) => dist(u, spot) <= 4)
      const ready = army.filter((u) => dist(u, stage) <= 3).length >= army.length * 0.8
      if (!near && !ready && view.tick - farmSince < 250) for (const u of army) attackMove(cmd, u, stage)
      else {
        const box = view.entities.find((e) => e.type === "treasure" && e.x === chest.x && e.y === chest.y)
        for (const u of army) {
          if (box) attack(cmd, u, box)
          else attackMove(cmd, u, spot)
        }
      }
      return
    }
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

/**
 * 野怪咬过来就还手（D-203 改成集火）：贴着我方兵（3 格内）的野怪里，每个兵挑自己 8 格内血最少的那只打，
 * 附近的兵就会一起打同一只（原来各打离自己最近的，打宝箱、清野时零零散散被野怪吃掉）
 */
function retaliate(view: View, cmd: Commands): void {
  const creeps = view.entities.filter((e) => e.type === "creep")
  if (creeps.length === 0) return
  const army = view.entities.filter((u) => u.owner === view.me && (u.type === "soldier" || u.type === "archer"))
  const biting = creeps.filter((k) => army.some((u) => dist(k, u) <= 3))
  if (biting.length === 0) return
  for (const u of army) {
    let c: Entity | undefined
    for (const k of biting) if (dist(k, u) <= 8 && (!c || k.hp < c.hp)) c = k
    if (c && !(u.order?.kind === "attack" && u.order.target === c.id)) cmd.attack(u, c)
  }
}

/** 选营地时距离打平：按自己这边看（右下那家把坐标镜像过来）先挑靠下的，两家各去自己那一侧的营地（D-191） */
function campSide(c: { x: number; y: number }, base: { x: number }): number {
  return base.x > game.width / 2 ? c.y : -c.y
}
