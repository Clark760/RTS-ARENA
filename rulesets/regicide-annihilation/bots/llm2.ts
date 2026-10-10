// 大模型试写（Sonnet 测试员第八轮 60 分钟交的 v4，困难陪练）：一整团兵带着领主轮流清野、抢宝箱，记着看到的敌兵、打不过就退回家门口；兵够 22 个（或者 16 个且击杀价值领先 600）先在对方家外聚齐再推。
// 外部大模型试写的 bot（2026-10-10，D-207）：子代理只读了 PROMPT.md、看不到平台源码和参考 bot 的源码，写到第 4 版交卷，
// 当时（D-206 的规则：宝箱每方不限捡几个、击退不眩晕）对 baseline、assassin、escort 各 20 局全胜，llm 19-1，turtle 15-5。原样收录，只改了开头的说明。
//
// 打法：
// 1. 经济：10 个工人采家门口的矿（每矿最多 4 人），家门口矿快采完（<40）后改去离我家近、不挨着野怪营地的中间矿；
//    工人被发怒的营地追就回家。兵营一直排满（弓手约占 1/3），钱是唯一的限制。
// 2. 兵不单独行动：兵凑到 6 个就带着领主出门清最近的野怪营地。先在营地外 4～5 格的集合点聚齐（前面的兵等后面的），
//    再一起 attackMove(neutral) 进营地；开打后这个营地不打完不换事（commitCamp）。领主站在团里靠家的一侧，
//    离活着的营地 3 格内会自动挪开，被野怪咬或敌人贴脸会躲开并叫兵回头。后来造出的兵 4 个一批去和领主会合。
// 3. 宝箱：每次刷新前 150 tick 全团到正中，刷新前 45 tick 让离格子最近的两个兵 move 上去站着（站格子直接捡），
//    其余的 attackMove(neutral) 守着；宝箱出来了就一起打。
// 4. 对手兵力记忆（seen）：看到的敌兵记 80 tick。折算后（有领主光环算 1.5 倍）对手比我强 15% 以上就退回集合点打，
//    弱到 80% 以下再出来。对手到家附近 16 格内全军回防。
// 5. 推家：兵 >= 22（或 >= 16 且击杀价值领先 600）才推，先在对方家 11～13 格外集合。看到对方领主且它周围守兵不多，
//    附近 5 个兵专打领主（attack）。
// 6. 击退：领主 3 格内有 >= 2 个敌兵、或 8 格内有 >= 3 个敌兵且比我方多、或领主血量低于 60% 且有敌兵贴脸时放
//    （消融实测：从不放、这样放、见 2 个敌兵就放，三种对每个参考 bot 的胜负完全一样，所以不是这个打法的关键）。
// 所有坐标都按当局地图算（pathDistances / creepCamps / treasure.spots），右下角座位用同一套规则（平局时按座位取镜像）。
//
const WORKER_TARGET = 10
const CAMP_GO_MIN = 6 // 兵凑到几个就出门清野
const PUSH_MIN = 22 // 兵凑到几个就推对方的家
const ARCHER_SHARE = 0.34 // 弓手占比
const JOIN_MIN = 4 // 家里攒到几个就去增援

let W = 0
let H = 0
let pdHome: number[] = [] // 从我家出发的走路距离（只看地形）
let pdEnemy: number[] = [] // 从对方家出发的走路距离
let commitCamp = -1 // 已经开打的营地，打完再换别的事
let rally: Pos = { x: 0, y: 0 }
let homeBase: Pos = { x: 0, y: 0 }
let enemyBase: Pos = { x: 0, y: 0 }
let pushStage: Pos = { x: 0, y: 0 }
let inited = false
let defendUntil = 0
let campStaging: Pos[] = []
let lastLogMission = ""
let latched = false // 已经从集合点出发
let latchKey = ""
let retreating = false
let lordPanicUntil = 0
const deployed = new Set<number>()
const joining = new Set<number>()
const seen = new Map<number, { tick: number; x: number; y: number; lord: boolean }>()
const pdCache = new Map<string, number[]>()

function isWalk(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= W || y >= H) return false
  return !!game.walkable[game.terrain[y][x]]
}
function pdAt(x: number, y: number): number {
  if (x < 0 || y < 0 || x >= W || y >= H) return -1
  return pdHome[y * W + x]
}
function isArmy(e: Entity): boolean {
  return e.type === "soldier" || e.type === "archer"
}
function d2(a: Pos, b: Pos): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
}
function pdFrom(p: Pos): number[] {
  const k = p.x + "," + p.y
  let r = pdCache.get(k)
  if (!r) {
    r = pathDistances(null, p)
    if (pdCache.size > 12) pdCache.clear()
    pdCache.set(k, r)
  }
  return r
}

function init(view: View): void {
  W = game.width
  H = game.height
  const base = view.entities.find((e) => e.owner === view.me && e.type === "base")!
  homeBase = { x: base.x + 1, y: base.y + 1 }
  const eb = view.objectives.enemyBases[0]
  enemyBase = { x: eb.x + 1, y: eb.y + 1 }
  pdHome = pathDistances(null, base)
  pdEnemy = pathDistances(null, { x: eb.x, y: eb.y })
  // 集结点：离家 9～11 步、离地图中心最近的格子
  let best = -1
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = pdAt(x, y)
      if (p < 9 || p > 11) continue
      const score = Math.abs(x - W / 2) + Math.abs(y - H / 2)
      if (best < 0 || score < best) {
        best = score
        rally = { x, y }
      }
    }
  // 每个营地的集合点：离营地 4～5 格、离我家走路最近
  for (const c of view.objectives.creepCamps) {
    let bp: Pos = { x: c.x, y: c.y }
    let bd = 1e9
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (!isWalk(x, y)) continue
        const p = pdAt(x, y)
        if (p < 0) continue
        let md = 1e9
        for (const cell of c.cells) md = Math.min(md, Math.abs(cell.x - x) + Math.abs(cell.y - y))
        if (md < 4 || md > 5) continue
        const s = p * 10 + (view.me === 0 ? x + y : -(x + y)) * 0.01
        if (s < bd) {
          bd = s
          bp = { x, y }
        }
      }
    campStaging.push(bp)
  }
  // 推家的集合点：离对方主基地 11～13 格、离我家走路最近
  let bd = 1e9
  pushStage = rally
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!isWalk(x, y)) continue
      const p = pdAt(x, y)
      if (p < 0) continue
      const dd = Math.abs(x - enemyBase.x) + Math.abs(y - enemyBase.y)
      if (dd < 11 || dd > 13) continue
      if (p < bd) {
        bd = p
        pushStage = { x, y }
      }
    }
  inited = true
}

export function onTick(view: View, cmd: Commands): void {
  if (!inited) init(view)
  const me = view.me
  const tick = view.tick
  const E = view.entities
  const mine = E.filter((e) => e.owner === me)
  const base = mine.find((e) => e.type === "base")
  const barracks = mine.find((e) => e.type === "barracks")
  const lord = mine.find((e) => e.type === "lord")
  const workers = mine.filter((e) => e.type === "worker")
  const army = mine.filter(isArmy)
  const enemies = E.filter((e) => e.owner >= 0 && e.owner !== me)
  const enemyMil = enemies.filter((e) => isArmy(e) || e.type === "lord")
  const enemyArmy = enemies.filter(isArmy)
  const enemyLord = enemies.find((e) => e.type === "lord")
  const neutrals = E.filter((e) => e.owner === -1 && game.types[e.type].kind !== "resource")
  const mines = E.filter((e) => game.types[e.type].kind === "resource" && (e.amount ?? 0) > 0)
  const camps = view.objectives.creepCamps
  const tre = view.objectives.treasure
  let gold = view.resources.gold

  // ---------------- 记账：谁出门了、对手兵力记忆 ----------------
  const armyIds = new Set(army.map((e) => e.id))
  for (const id of deployed) if (!armyIds.has(id)) deployed.delete(id)
  for (const id of joining) if (!armyIds.has(id)) joining.delete(id)
  for (const ev of view.events) if (ev.kind === "died") seen.delete(ev.id)
  for (const e of enemyMil) seen.set(e.id, { tick, x: e.x, y: e.y, lord: e.type === "lord" })
  for (const [id, s] of seen) if (tick - s.tick > 80) seen.delete(id)

  // ---------------- 工人矿点：营地附近的矿 ----------------
  const campDanger = (p: Pos): boolean => {
    for (const c of camps) {
      if (c.alive <= 0) continue
      for (const cell of c.cells) {
        const dd = d2(cell, p)
        if (dd <= 3) return true
        if (c.angry && dd <= 9) return true
      }
    }
    return false
  }
  // 能采的矿：离我家比离对方家近、不挨着活着的野怪营地；家门口的矿快采完时（<40）不再算，免得工人守着最后一点点干等
  const homeMines = mines.filter((m) => {
    const p = pdAt(m.x, m.y)
    return p >= 0 && p <= 13 && (m.amount ?? 0) >= 40
  })
  const usable = mines.filter((m) => {
    const a = pdAt(m.x, m.y)
    const b = pdEnemy[m.y * W + m.x]
    if (a < 0) return false
    if (a <= 13) return (m.amount ?? 0) >= 40
    return (b < 0 || a < b) && !campDanger(m)
  })

  // ---------------- 经济：工人 ----------------
  if (base) {
    const bq = base.queue?.length ?? 0
    const wq = (base.queue ?? []).filter((q) => q.type === "worker").length
    const wTotal = workers.length + wq
    if (wTotal < WORKER_TARGET && wTotal < usable.length * 4 && bq < 2 && gold >= 50) {
      cmd.produce(base, "worker")
      gold -= 50
    }
  }
  const assigned = new Map<number, number>()
  for (const w of workers) {
    if (w.order?.kind === "gather") assigned.set(w.order.target, (assigned.get(w.order.target) ?? 0) + 1)
  }
  for (const w of workers) {
    const o = w.order
    // 被愤怒的营地追：回家
    let danger = false
    for (const c of camps) if (c.angry && c.alive > 0) for (const cell of c.cells) if (d2(cell, w) <= 9) danger = true
    if (danger && base) {
      cmd.move(w, homeBase.x, homeBase.y + 2)
      continue
    }
    const okTarget = o?.kind === "gather" && mines.some((m) => m.id === o.target)
    if (okTarget) {
      const mm = mines.find((m) => m.id === (o as { target: number }).target)
      if (!(mm && campDanger(mm) && homeMines.length === 0)) continue
    }
    if (o?.kind === "gather" && o.returning) continue
    let bestM: Entity | null = null
    let bs = 1e9
    for (const m of usable) {
      const cnt = assigned.get(m.id) ?? 0
      if (cnt >= 4) continue
      const s = cnt * 8 + d2(w, m)
      if (s < bs) {
        bs = s
        bestM = m
      }
    }
    if (bestM) {
      cmd.gather(w, bestM)
      assigned.set(bestM.id, (assigned.get(bestM.id) ?? 0) + 1)
    }
  }

  // ---------------- 生产：兵 ----------------
  if (barracks) {
    const q = barracks.queue ?? []
    let total = mine.filter((e) => game.types[e.type].kind === "unit").length + q.length + (base?.queue?.length ?? 0)
    let arch = army.filter((e) => e.type === "archer").length + q.filter((x) => x.type === "archer").length
    let all = army.length + q.length
    let slots = 5 - q.length
    const reserve = workers.length + (base?.queue?.length ?? 0) < WORKER_TARGET && (base?.queue?.length ?? 0) === 0 ? 50 : 0
    while (slots > 0 && total < game.unitCap) {
      const wantArcher = arch < (all + 1) * ARCHER_SHARE
      const type: TypeName = wantArcher ? "archer" : "soldier"
      const cost = game.types[type].cost.gold ?? 0
      if (gold - reserve < cost) break
      cmd.produce(barracks, type)
      gold -= cost
      slots--
      total++
      all++
      if (wantArcher) arch++
    }
  }

  // ---------------- 军队编组 ----------------
  const n = army.length
  let body = army.filter((u) => deployed.has(u.id) && !joining.has(u.id))
  let joiners = army.filter((u) => joining.has(u.id))
  let reserveU = army.filter((u) => !deployed.has(u.id))
  if (body.length === 0 && joiners.length > 0) {
    for (const u of joiners) joining.delete(u.id)
    body = joiners
    joiners = []
  }
  // 增援的兵到了领主身边就算归队
  if (lord) {
    for (const u of joiners) if (d2(u, lord) <= 7) joining.delete(u.id)
    joiners = army.filter((u) => joining.has(u.id))
    body = army.filter((u) => deployed.has(u.id) && !joining.has(u.id))
  }
  const bodyBase = body.length > 0 ? body : reserveU
  let cx = rally.x
  let cy = rally.y
  if (bodyBase.length > 0) {
    cx = Math.round(bodyBase.reduce((s, e) => s + e.x, 0) / bodyBase.length)
    cy = Math.round(bodyBase.reduce((s, e) => s + e.y, 0) / bodyBase.length)
  }
  const centroid: Pos = { x: cx, y: cy }

  // ---------------- 威胁评估 ----------------
  let seenCnt = 0
  let seenLordNear = false
  for (const [, s] of seen) {
    if (d2(s, centroid) > 16) continue
    if (s.lord) seenLordNear = true
    else seenCnt++
  }
  const bodyN = Math.max(1, bodyBase.length)
  const mineEff = bodyN * (lord && d2(lord, centroid) <= 8 ? 1.5 : 1)
  const enemyEff = seenCnt * (seenLordNear ? 1.5 : 1.25)
  if (!retreating && seenCnt >= 3 && enemyEff > mineEff * 1.15) retreating = true
  if (retreating && (seenCnt === 0 || enemyEff < mineEff * 0.8)) retreating = false

  const threats = enemyMil.filter((e) => d2(e, homeBase) <= 16)
  if (threats.length > 0) defendUntil = tick + 40
  const defending = tick < defendUntil

  // ---------------- 任务选择 ----------------
  let goal: Pos = rally
  let stage: Pos | null = null
  let neutral = false
  const nearChest = tre.chests.length > 0
  const inTreasureWindow = tick >= tre.nextAt - 150 && tick < tre.nextAt + 100
  let m = "rally"

  // 选营地：活着的、走路近、没有对手兵力的
  let campIdx = -1
  {
    let bs = 1e9
    camps.forEach((c, i) => {
      if (c.alive <= 0) return
      const sp = campStaging[i]
      const p = pdAt(sp.x, sp.y)
      if (p < 0) return
      let contested = 0
      for (const [, s] of seen) if (!s.lord && d2(s, { x: c.x, y: c.y }) <= 10) contested++
      if (contested >= 3) return
      const s = p - c.alive * 4
      if (s < bs) {
        bs = s
        campIdx = i
      }
    })
  }
  if (commitCamp >= 0 && (camps[commitCamp].alive <= 0 || retreating)) commitCamp = -1
  const kv = view.objectives.killValue
  const kvLead = (kv[me] ?? 0) - Math.max(...kv.filter((_, i) => i !== me), 0)

  if (defending && threats.length > 0) {
    m = "defend"
    goal = {
      x: Math.round(threats.reduce((s, e) => s + e.x, 0) / threats.length),
      y: Math.round(threats.reduce((s, e) => s + e.y, 0) / threats.length),
    }
  } else if (retreating) {
    m = "retreat"
    goal = rally
  } else if (commitCamp >= 0 && camps[commitCamp].alive > 0 && n >= 3 && !(tick >= tre.nextAt - 50 && tick < tre.nextAt + 100)) {
    m = "camp"
    stage = campStaging[commitCamp]
    const c = camps[commitCamp]
    goal = {
      x: Math.round(c.cells.reduce((s, p) => s + p.x, 0) / c.cells.length),
      y: Math.round(c.cells.reduce((s, p) => s + p.y, 0) / c.cells.length),
    }
    neutral = true
  } else if (n >= 4 && (inTreasureWindow || (nearChest && n >= 5))) {
    m = "treasure"
    goal = {
      x: Math.round(tre.spots.reduce((s, p) => s + p.x, 0) / tre.spots.length),
      y: Math.round(tre.spots.reduce((s, p) => s + p.y, 0) / tre.spots.length),
    }
    // 集合点：离正中 4 格、离我家走路最近的格子（先聚齐再进去）
  } else if (n >= PUSH_MIN || (n >= 16 && kvLead >= 600)) {
    m = "push"
    goal = enemyBase
    stage = pushStage
  } else if (n >= CAMP_GO_MIN && campIdx >= 0) {
    m = "camp"
    commitCamp = campIdx
    stage = campStaging[campIdx]
    const c = camps[campIdx]
    goal = {
      x: Math.round(c.cells.reduce((s, p) => s + p.x, 0) / c.cells.length),
      y: Math.round(c.cells.reduce((s, p) => s + p.y, 0) / c.cells.length),
    }
    neutral = true
  }
  if (m !== lastLogMission) {
    console.log(`t${tick} mission ${m} n=${n} body=${body.length} seen=${seenCnt} kvLead=${kvLead}`)
    lastLogMission = m
  }
  const key = m + ":" + goal.x + "," + goal.y
  if (key !== latchKey) {
    latchKey = key
    latched = stage === null
  }

  // ---------------- 出门/归队 ----------------
  const outMission = m === "camp" || m === "treasure" || m === "push"
  if (outMission) {
    if (body.length === 0 && reserveU.length >= (m === "treasure" ? 4 : CAMP_GO_MIN)) {
      for (const u of reserveU) deployed.add(u.id)
      body = reserveU
      reserveU = []
    } else if (body.length > 0 && reserveU.length >= JOIN_MIN && lord) {
      for (const u of reserveU) {
        deployed.add(u.id)
        joining.add(u.id)
      }
      joiners = joiners.concat(reserveU)
      reserveU = []
    }
  } else {
    // 回家/防守：全部算一个团
    if (m === "rally" || m === "retreat") {
      deployed.clear()
      joining.clear()
      body = []
      joiners = []
      reserveU = army
    }
  }

  // ---------------- 指挥军队 ----------------
  const moveGroup = body.length > 0 ? body : reserveU
  if (m === "treasure") {
    const spots = tre.spots
    const sitters = new Set<number>()
    if (tick >= tre.nextAt - 45 && tick < tre.nextAt + 20) {
      const free = moveGroup.slice()
      for (const sp of spots) {
        free.sort((a, b) => d2(a, sp) - d2(b, sp))
        const u = free.find((x) => !sitters.has(x.id))
        if (u) {
          sitters.add(u.id)
          cmd.move(u, sp.x, sp.y)
        }
      }
    }
    for (const u of moveGroup) {
      if (sitters.has(u.id)) continue
      if (tre.chests.length > 0) {
        const ch = tre.chests.reduce((a, b) => (d2(u, a) <= d2(u, b) ? a : b))
        cmd.attackMove(u, ch.x, ch.y, { neutral: true })
      } else {
        cmd.attackMove(u, goal.x, goal.y, { neutral: true })
      }
    }
  } else if (m === "camp" || m === "push") {
    const sp = stage!
    if (!latched) {
      const near = moveGroup.filter((u) => d2(u, sp) <= 6).length
      if (near >= Math.ceil(moveGroup.length * 0.75)) latched = true
    }
    if (latched) {
      for (const u of moveGroup) cmd.attackMove(u, goal.x, goal.y, { neutral })
    } else {
      // 前面的等后面的：走路距离比中位数近 3 步以上的先停下
      const pdT = pdFrom(sp)
      const keys = moveGroup.map((u) => pdT[u.y * W + u.x]).sort((a, b) => a - b)
      const med = keys[Math.floor(keys.length / 2)]
      const enemyClose = enemyMil.some((e) => d2(e, centroid) <= 12)
      for (const u of moveGroup) {
        const k = pdT[u.y * W + u.x]
        if (!enemyClose && k >= 0 && k < med - 3) {
          if (u.order?.kind !== "idle") cmd.stop(u)
        } else cmd.attackMove(u, sp.x, sp.y)
      }
    }
  } else if (m === "rally") {
    for (const u of army) if (d2(u, rally) > 4) cmd.attackMove(u, rally.x, rally.y)
  } else if (m === "retreat") {
    for (const u of army) cmd.move(u, rally.x, rally.y)
  } else {
    // defend
    for (const u of army) cmd.attackMove(u, goal.x, goal.y)
  }

  // 增援的兵走向领主
  if (lord && outMission) for (const u of joiners) cmd.attackMove(u, lord.x, lord.y)

  // 敌方领主在眼前、周围敌兵不多：附近的几个兵专打它
  if (enemyLord && army.length >= 4 && m !== "retreat") {
    const guards = enemyArmy.filter((e) => d2(e, enemyLord) <= 4).length
    if (guards <= 2) {
      const close = army.filter((u) => d2(u, enemyLord) <= 7).sort((a, b) => d2(a, enemyLord) - d2(b, enemyLord)).slice(0, 5)
      if (close.length >= 3) for (const u of close) cmd.attack(u, enemyLord)
    }
  }

  // ---------------- 领主 ----------------
  if (lord) {
    const hurt = view.events.some((ev) => ev.kind === "damaged" && ev.id === lord.id)
    const creepsNear = neutrals.filter((c) => c.type === "creep" && d2(c, lord) <= 4)
    if (hurt || creepsNear.length > 0) lordPanicUntil = tick + 30
    const panic = tick < lordPanicUntil
    let lt: Pos
    const g = body.length > 0 ? body : army
    if (m === "retreat" || g.length === 0) {
      lt = g.length === 0 ? { x: rally.x, y: rally.y } : rally
      if (g.length === 0 && d2(lord, homeBase) <= 8) lt = { x: lord.x, y: lord.y }
    } else {
      // 站在团里靠家这一侧：按走路距离排序后取前面 25%～35% 的那个兵的位置
      const sorted = g.slice().sort((a, b) => pdAt(a.x, a.y) - pdAt(b.x, b.y))
      const k = Math.floor(sorted.length * (m === "push" ? 0.25 : 0.35))
      const u = sorted[Math.min(k, sorted.length - 1)]
      lt = { x: u.x, y: u.y }
    }
    lt = safeSpot(lt, camps)
    if (panic) {
      // 被野怪咬或敌人贴脸：往离威胁远、离团近的地方躲，兵回头救
      const threatsNear: Pos[] = neutrals.filter((c) => c.type === "creep" && d2(c, lord) <= 9).map((c) => ({ x: c.x, y: c.y }))
      for (const e of enemyMil) if (d2(e, lord) <= 9) threatsNear.push({ x: e.x, y: e.y })
      const goalP = body.length > 0 ? centroid : rally
      let bestC: Pos | null = null
      let bsc = 1e9
      for (let dy = -8; dy <= 8; dy++)
        for (let dx = -8; dx <= 8; dx++) {
          if (Math.abs(dx) + Math.abs(dy) > 8) continue
          const x = lord.x + dx
          const y = lord.y + dy
          if (!isWalk(x, y)) continue
          let md = 99
          for (const t of threatsNear) md = Math.min(md, Math.abs(t.x - x) + Math.abs(t.y - y))
          if (md < 6) continue
          const sc = Math.abs(x - goalP.x) + Math.abs(y - goalP.y) + (Math.abs(dx) + Math.abs(dy)) * 0.3
          if (sc < bsc) {
            bsc = sc
            bestC = { x, y }
          }
        }
      lt = bestC ?? { x: homeBase.x, y: homeBase.y }
      if (creepsNear.length > 0 && army.length > 0 && m !== "retreat") {
        for (const u of army) if (d2(u, lord) <= 14) cmd.attackMove(u, lord.x, lord.y, { neutral: true })
      }
    }
    if (d2(lord, lt) > 1) cmd.move(lord, lt.x, lt.y)

    // 击退：身边敌兵 >= 2 贴脸，或 8 格内 >= 3 个而自己这边兵不占优
    const cd = lord.skillCooldowns?.repel ?? 0
    if (cd === 0) {
      const close = enemyMil.filter((e) => d2(e, lord) <= 3).length
      const wide = enemyMil.filter((e) => d2(e, lord) <= 8)
      const mineNear = army.filter((u) => d2(u, lord) <= 8).length
      if (close >= 2 || (wide.length >= 3 && wide.length > mineNear) || (lord.hp < lord.maxHp * 0.6 && close >= 1)) {
        cmd.cast(lord, "repel")
      }
    }
  }
}

// 离活着的野怪营地太近（3 格内）就挪到 4 格外最近的格子，免得领主站在营地边上被咬
function safeSpot(p: Pos, camps: { cells: Pos[]; alive: number }[]): Pos {
  const bad = (x: number, y: number): boolean => {
    for (const c of camps) {
      if (c.alive <= 0) continue
      for (const cell of c.cells) if (Math.abs(cell.x - x) + Math.abs(cell.y - y) <= 3) return true
    }
    return false
  }
  if (!bad(p.x, p.y)) return p
  let best: Pos = p
  let bs = 1e9
  for (let dy = -6; dy <= 6; dy++)
    for (let dx = -6; dx <= 6; dx++) {
      const x = p.x + dx
      const y = p.y + dy
      if (!isWalk(x, y) || bad(x, y)) continue
      const sc = Math.abs(dx) + Math.abs(dy)
      if (sc < bs) {
        bs = sc
        best = { x, y }
      }
    }
  return best
}
