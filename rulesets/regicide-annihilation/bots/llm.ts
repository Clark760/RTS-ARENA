// 大模型试写（Sonnet 测试员第二轮 60 分钟交的 v7，偏强）：兵在家门口吃光环守住，领主在家时用造完兵剩下的钱在集结点召唤箭塔（钱够 350、最多 4 座；收录时把原来的点金换成了这个）；600～2600 tick 兵够 16 个就带着领主去清最近的野怪营地（集火，附近来了敌兵马上转去迎战）；击杀价值领先 600、兵够 20 个就反推。
// 参数集中在顶部，方便每版改

const WORKERS_WANT = 9
const FARM_ARMY = 16 // 兵数到这个数且家里没威胁，就去清最近的野怪营地
const FARM_ENABLED = true
const FARM_UNTIL = 2600
const ATTACK_ARMY = 999 // 兵数到这个数去攻击对手（v1 不攻击）
const ARCHER_RATIO = 1 / 3
const RALLY_D = 7 // 步兵集结点离主基地的步数
const ARCHER_D = 5 // 弓手站位
const LORD_D = 3 // 领主站位
const PUSH_LEAD = 600 // 击杀价值领先多少、兵多少以上就反推
const PUSH_ARMY = 20

let inited = false
let baseE: Entity | null = null
let dHome: number[] = []
let dEnemyBase: number[] = []
let rally: Pos = { x: 0, y: 0 }
let lordHome: Pos = { x: 0, y: 0 }
let archerSpot: Pos = { x: 0, y: 0 }
let campDist: number[][] = []
let mode: "home" | "stage" | "fight" | "return" | "push" = "home"
let campIdx = -1
let stagePos: Pos | null = null
let modeSince = 0
let lastCast = -9999
const squad = new Set<number>()
let nextFarm = 0

function isWalk(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= game.width || y >= game.height) return false
  return !!game.walkable[game.terrain[y][x]]
}

function init(view: View): void {
  inited = true
  const mine = view.entities.filter((e) => e.owner === view.me)
  baseE = mine.find((e) => e.type === "base") ?? null
  if (!baseE) return
  const eb = view.objectives.enemyBases[0]
  dHome = pathDistances(null, baseE)
  dEnemyBase = pathDistances(null, { x: eb.x, y: eb.y, w: 3, h: 3 } as unknown as Entity)
  // 集结点：离我方主基地 8 步、离对方主基地最近
  const W = game.width
  let best = 1e9
  let cands: Pos[] = []
  const seatRev = view.me !== 0
  for (let yy = 0; yy < game.height; yy++) {
    for (let xx = 0; xx < game.width; xx++) {
      const x = seatRev ? game.width - 1 - xx : xx
      const y = seatRev ? game.height - 1 - yy : yy
      const i = y * W + x
      if (dHome[i] !== RALLY_D || !isWalk(x, y)) continue
      const d = dEnemyBase[i]
      if (d < 0) continue
      if (d < best) {
        best = d
        cands = [{ x, y }]
      } else if (d === best) cands.push({ x, y })
    }
  }
  rally = cands[0] ?? { x: baseE.x + 6, y: baseE.y + 3 }
  const dR = pathDistances(null, rally)
  let bl = 1e9
  lordHome = { x: baseE.x + 3, y: baseE.y + 1 }
  for (let yy = 0; yy < game.height; yy++) {
    for (let xx = 0; xx < game.width; xx++) {
      const x = seatRev ? game.width - 1 - xx : xx
      const y = seatRev ? game.height - 1 - yy : yy
      const i = y * W + x
      if (dHome[i] !== LORD_D || !isWalk(x, y) || dR[i] < 0) continue
      if (dR[i] < bl) {
        bl = dR[i]
        lordHome = { x, y }
      }
    }
  }
  bl = 1e9
  archerSpot = rally
  for (let yy = 0; yy < game.height; yy++) {
    for (let xx = 0; xx < game.width; xx++) {
      const x = seatRev ? game.width - 1 - xx : xx
      const y = seatRev ? game.height - 1 - yy : yy
      const i = y * W + x
      if (dHome[i] !== ARCHER_D || !isWalk(x, y) || dR[i] < 0) continue
      if (dR[i] < bl) {
        bl = dR[i]
        archerSpot = { x, y }
      }
    }
  }
  for (const c of view.objectives.creepCamps) {
    campDist.push(pathDistances(null, { x: c.x, y: c.y }))
  }
}

function centroid(us: Entity[]): Pos {
  let sx = 0
  let sy = 0
  for (const u of us) {
    sx += u.x
    sy += u.y
  }
  return { x: Math.round(sx / us.length), y: Math.round(sy / us.length) }
}

export function onTick(view: View, cmd: Commands): void {
  if (!inited) init(view)
  const me = view.me
  const my = view.entities.filter((e) => e.owner === me)
  const base = my.find((e) => e.type === "base")
  const bar = my.find((e) => e.type === "barracks")
  const lord = my.find((e) => e.type === "lord")
  const workers = my.filter((e) => e.type === "worker")
  const army = my.filter((e) => e.type === "soldier" || e.type === "archer")
  const enemies = view.entities.filter((e) => e.owner >= 0 && e.owner !== me)
  const creeps = view.entities.filter((e) => e.type === "creep")
  const t = view.tick
  if (!base || !baseE) return

  // ---------- 威胁判断 ----------
  const homeRef: Pos[] = [base]
  if (bar) homeRef.push(bar)
  if (lord) homeRef.push(lord)
  const wasField = mode === "stage" || mode === "fight" || mode === "return"
  let fieldPos: Pos | null = null
  if (wasField) {
    const sqa = army.filter((u) => squad.has(u.id))
    if (sqa.length > 0) fieldPos = centroid(sqa)
  }
  const threats = enemies.filter(
    (e) =>
      (e.type === "soldier" || e.type === "archer" || e.type === "lord") &&
      (homeRef.some((h) => dist(e, h) <= 10) || (fieldPos !== null && dist(e, fieldPos) <= 12))
  )
  const raiders = enemies.filter((e) => e.type === "worker" && dist(e, base) <= 10)

  // ---------- 经济：生产 ----------
  let gold = view.resources.gold
  const unitCount = my.filter((e) => game.types[e.type].kind === "unit").length + (base.queue?.length ?? 0) + (bar?.queue?.length ?? 0)
  const wQ = (base.queue ?? []).filter((q) => q.type === "worker").length
  const wTotal = workers.length + wQ
  let cap = game.unitCap - unitCount
  if (bar && bar.queue !== undefined) {
    const qlen = bar.queue.length
    const wantQ = gold >= 300 ? 3 : 2
    const soldiersN = army.filter((e) => e.type === "soldier").length
    const archersN = army.filter((e) => e.type === "archer").length
    if (qlen < wantQ && cap > 0) {
      const archersQ = bar.queue.filter((q) => q.type === "archer").length
      const type: TypeName = archersN + archersQ < (soldiersN + archersN + bar.queue.length) * ARCHER_RATIO ? "archer" : "soldier"
      const c = game.types[type].cost.gold ?? 0
      if (gold >= c) {
        cmd.produce(bar, type)
        gold -= c
        cap--
      }
    }
  }
  if (base.queue !== undefined && wTotal < WORKERS_WANT && cap > 0 && (base.queue?.length ?? 0) < 2 && gold >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }

  // ---------- 经济：采集分配 ----------
  const mines = view.entities.filter((e) => e.type === "goldmine" && (e.amount ?? 0) > 0)
  const load = new Map<number, number>()
  for (const w of workers) {
    if (w.order?.kind === "gather") load.set(w.order.target, (load.get(w.order.target) ?? 0) + 1)
  }
  for (const w of workers) {
    const go = w.order
    if (go && go.kind === "gather" && mines.some((m) => m.id === go.target)) continue
    let bestM: Entity | null = null
    let bestC = 1e9
    for (const m of mines) {
      const dh = dist(m, base)
      if (dh > 30) continue
      const l = load.get(m.id) ?? 0
      const c = dh * 3 + l * (l >= 4 ? 100 : l >= 3 ? 20 : 6) + dist(m, w) * 0.5
      if (c < bestC) {
        bestC = c
        bestM = m
      }
    }
    if (!bestM) {
      // 家附近没矿了：去最近的
      for (const m of mines) {
        const c = dist(m, w)
        if (c < bestC) {
          bestC = c
          bestM = m
        }
      }
    }
    if (bestM) {
      cmd.gather(w, bestM)
      load.set(bestM.id, (load.get(bestM.id) ?? 0) + 1)
    }
  }

  // ---------- 模式切换 ----------
  const homeThreat = threats.length > 0 || raiders.length >= 2
  const camps = view.objectives.creepCamps
  if (homeThreat && mode !== "home") {
    if (wasField) nextFarm = t + 400
    mode = "home"
    modeSince = t
    squad.clear()
  }
  const enemyScore = view.players[1 - me]?.score ?? 0
  if (mode === "home" && !homeThreat && t > 1500 && army.length >= PUSH_ARMY && view.players[me].score - enemyScore >= PUSH_LEAD) {
    mode = "push"
    modeSince = t
  }
  if (mode === "home" && FARM_ENABLED && !homeThreat && t >= nextFarm && t >= 600 && t < FARM_UNTIL && army.length >= FARM_ARMY && lord) {
    // 选最近且还有活野怪的营地
    let bi = -1
    let bd = 1e9
    for (let i = 0; i < camps.length; i++) {
      const c = camps[i]
      if (c.alive === 0) continue
      const d = dHome[c.y * game.width + c.x] - (c.size >= 3 ? 4 : 0)
      if (dHome[c.y * game.width + c.x] >= 0 && d < bd) {
        bd = d
        bi = i
      }
    }
    if (bi >= 0) {
      campIdx = bi
      // 集结点：离营地 5 步、离我方家最近
      const cd = campDist[bi]
      let bs = 1e9
      let sp: Pos | null = null
      for (let y = 0; y < game.height; y++) {
        for (let x = 0; x < game.width; x++) {
          const i = y * game.width + x
          if (cd[i] === 5 && isWalk(x, y) && dHome[i] >= 0 && dHome[i] < bs) {
            bs = dHome[i]
            sp = { x, y }
          }
        }
      }
      if (sp) {
        stagePos = sp
        mode = "stage"
        modeSince = t
        squad.clear()
        for (const u of army) squad.add(u.id)
      }
    }
  }

  // ---------- 领主 ----------
  if (lord) {
    const cd = lord.skillCooldowns?.tower ?? 1
    let lordTarget: Pos | null = null
    // 召唤箭塔（D-192 收录时改）：在家、没威胁、造完兵还剩 350 以上就走到步兵集结点 3 格内，在集结点放一座，最多 4 座
    const towers = my.filter((e) => e.type === "tower").length
    if (mode === "home" && cd === 0 && t - lastCast > 20 && !homeThreat && gold >= 350 && towers < 4) {
      if (Math.abs(lord.x - rally.x) + Math.abs(lord.y - rally.y) <= 3) {
        cmd.cast(lord, "tower", rally)
        gold -= 250
        lastCast = t
      } else lordTarget = rally
    }
    if (!lordTarget) {
      if (mode === "home") {
        lordTarget = lordHome
        if (homeThreat && army.length > 0) {
          const cc = centroid(army)
          let rear = army[0]
          for (const u of army) if (dist(u, cc) < dist(rear, cc)) rear = u
          lordTarget = { x: rear.x, y: rear.y }
        }
      } else if (army.length > 0) {
        const pool = (mode === "push" ? army : army.filter((u) => squad.has(u.id)))
        const arr = pool.length > 0 ? pool : army
        let rear = arr[0]
        for (const u of arr) if (dHome[u.y * game.width + u.x] < dHome[rear.y * game.width + rear.x]) rear = u
        lordTarget = { x: rear.x, y: rear.y }
      }
    }
    if (lordTarget && dist(lord, lordTarget) > 1) cmd.move(lord, lordTarget.x, lordTarget.y)
  }

  // ---------- 军队 ----------
  const inField = mode === "stage" || mode === "fight" || mode === "return"
  const sq = inField ? army.filter((u) => squad.has(u.id)) : army
  if (inField) {
    for (const u of army) {
      if (squad.has(u.id)) continue
      const spot = u.type === "archer" ? archerSpot : rally
      if (dist(u, spot) > 2 && u.order?.kind !== "move") cmd.move(u, spot.x, spot.y)
    }
  }
  if (mode === "home") {
    if (homeThreat) {
      const all = [...threats, ...raiders]
      // 最近的威胁
      const refP: Pos = fieldPos ?? (army.length > 0 ? centroid(army) : base)
      let tgt = all[0]
      for (const e of all) if (dist(e, refP) < dist(tgt, refP)) tgt = e
      const eLord = enemies.find((e) => e.type === "lord")
      for (const u of army) {
        if (eLord && dist(u, eLord) <= (u.type === "archer" ? 5 : 3)) cmd.attack(u, eLord)
        else cmd.attackMove(u, tgt.x, tgt.y)
      }
    } else {
      for (const u of army) {
        const spot = u.type === "archer" ? archerSpot : rally
        if (dist(u, spot) > 2 && u.order?.kind !== "move") cmd.move(u, spot.x, spot.y)
      }
    }
  } else if (mode === "push") {
    const eb = view.objectives.enemyBases[0]
    const eLord = enemies.find((e) => e.type === "lord")
    for (const u of army) {
      if (eLord && dist(u, eLord) <= (u.type === "archer" ? 5 : 3)) cmd.attack(u, eLord)
      else cmd.attackMove(u, eb.x + 1, eb.y + 1)
    }
    if (army.length < 10) {
      mode = "home"
      modeSince = t
    }
  } else if (mode === "stage" && stagePos) {
    for (const u of sq) if (dist(u, stagePos) > 2) cmd.attackMove(u, stagePos.x, stagePos.y)
    const near = sq.filter((u) => dist(u, stagePos!) <= 4).length
    if ((near >= sq.length * 0.9 && lord && dist(lord, stagePos) <= 6) || t - modeSince > 300) {
      mode = "fight"
      modeSince = t
    }
  } else if (mode === "fight") {
    const c = camps[campIdx]
    if (!c || c.alive === 0) {
      mode = "return"
      modeSince = t
    } else {
      const cr = creeps.filter((e) => dist(e, { x: c.x, y: c.y }) <= 9)
      if (cr.length === 0) {
        // 还没看见：往营地走
        for (const u of sq) cmd.attackMove(u, c.x, c.y)
      } else {
        const cen = sq.length > 0 ? centroid(sq) : { x: c.x, y: c.y }
        let tgt = cr[0]
        for (const e of cr) {
          if (e.hp < tgt.hp || (e.hp === tgt.hp && dist(e, cen) < dist(tgt, cen))) tgt = e
        }
        for (const u of sq) cmd.attack(u, tgt)
      }
    }
    if (sq.length < 6) {
      mode = "return"
      modeSince = t
    }
    if (t - modeSince > 900) {
      mode = "return"
      modeSince = t
    }
  } else if (mode === "return") {
    for (const u of sq) {
      const spot = u.type === "archer" ? archerSpot : rally
      if (dist(u, spot) > 3) cmd.attackMove(u, spot.x, spot.y)
    }
    if (sq.every((u) => dist(u, rally) <= 8) || t - modeSince > 300) {
      mode = "home"
      modeSince = t
      nextFarm = t + 100
      squad.clear()
    }
  }

  if (t % 500 === 0) {
    console.log(`t=${t} mode=${mode} army=${army.length} workers=${workers.length} gold=${view.resources.gold} lordCD=${lord?.skillCooldowns?.tower} score=${view.players[me].score}`)
  }
}
