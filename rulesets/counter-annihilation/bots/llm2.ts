// 大模型第二轮试写（最强）：枪兵为主（约 55%），对方偏哪种兵就往克它的方向偏；侦察兵待在敌兵视野外盯着，按兰彻斯特平方律算强弱再进攻。
// 外部大模型试写的 bot（2026-10-08，D-168）：子代理只读了 PROMPT.md、看不到平台源码和参考 bot 的源码，写到第 3 版停下，
// 当时对 baseline、mobile、rush 各 20 局全胜，对 boom 17-3、counter 18-2、llm 9-11。原样收录（后来的参考 bot 联赛里它都赢了 llm：枪兵 70 金时 9-1，枪兵 75 金 7-3，再加骑兵 105 金 8-2，是这个规则包里最强的）；
// 它偏枪兵，正好用来测「被反克」：多出弓兵能克它。

const W = game.width
const H = game.height
const TY = game.types
const MIL: TypeName[] = ["spearman", "cavalry", "archer"]
const COUNTER_OF: Record<string, TypeName> = { cavalry: "spearman", archer: "cavalry", spearman: "archer" } // 谁克它

function isMil(t: TypeName): boolean {
  return t === "spearman" || t === "cavalry" || t === "archer"
}
function costOf(t: TypeName): number {
  return TY[t].cost.gold ?? 0
}
function hit(a: TypeName, d: TypeName): number {
  const at = TY[a].attack
  if (!at) return 0
  const v = at.vs ? at.vs[d] : undefined
  return Math.round(at.damage * (v === undefined ? 1 : v))
}
function rangeOf(e: Entity): number {
  if (e.stats && e.stats.attack) return e.stats.attack.range
  const a = TY[e.type].attack
  return a ? a.range : 0
}
function sightOf(t: TypeName): number {
  return TY[t].sight
}
function ix(x: number, y: number): number {
  return y * W + x
}
function walkable(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= W || y >= H) return false
  return game.walkable[game.terrain[y][x]] === true
}
type Box = { x: number; y: number; w: number; h: number }
function center(b: Box): Pos {
  return { x: b.x + Math.floor(b.w / 2), y: b.y + Math.floor(b.h / 2) }
}
function boxCells(b: Box): Pos[] {
  const r: Pos[] = []
  for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) r.push({ x, y })
  return r
}
function md(a: Pos, b: Pos): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
}

// ---------- 状态 ----------
let me = -1
let inited = false
let baseBox: Box = { x: 0, y: 0, w: 3, h: 3 }
let barracksBox: Box = { x: 0, y: 0, w: 2, h: 2 }
let enemyBaseBox: Box = { x: 0, y: 0, w: 3, h: 3 }
let enemyBarracksBox: Box = { x: 0, y: 0, w: 2, h: 2 }
let dBase: number[] = []
let dEnemyBase: number[] = []
let dEnemyBk: number[] = []
let rally: Pos = { x: 0, y: 0 }
let rallyTick = -1000
let enemyBarracksDead = false
let mode: "defend" | "attack" = "defend"
let enemyMilKilledGold = 0
let enemyMinedGold = 0

type Seen = { type: TypeName; x: number; y: number; hp: number; seen: number }
const enemySeen = new Map<number, Seen>()
const enemyWorkerIds = new Set<number>()
const lastTarget = new Map<number, number>()
const lastAmount = new Map<number, number>()
const fleeUntil = new Map<number, number>()
const mineDistCache = new Map<number, number>()
const mineEnemyDistCache = new Map<number, number>()

function isEnemy(view: View, e: Entity): boolean {
  return e.owner >= 0 && e.owner !== me && view.players[e.owner].team !== view.players[me].team
}

function initialize(view: View): void {
  me = view.me
  const mineEnts = view.entities.filter((e) => e.owner === me)
  const base = mineEnts.find((e) => e.type === "base")
  const bk = mineEnts.find((e) => e.type === "barracks")
  if (base) baseBox = { x: base.x, y: base.y, w: base.w, h: base.h }
  if (bk) barracksBox = { x: bk.x, y: bk.y, w: bk.w, h: bk.h }
  const eb = view.objectives.enemyBases[0]
  enemyBaseBox = { x: eb.x, y: eb.y, w: 3, h: 3 }
  enemyBarracksBox = { x: W - barracksBox.x - barracksBox.w, y: H - barracksBox.y - barracksBox.h, w: 2, h: 2 }
  dBase = pathDistances(view, boxCells(baseBox))
  dEnemyBase = pathDistances(null, boxCells(enemyBaseBox))
  dEnemyBk = pathDistances(null, boxCells(enemyBarracksBox))
  for (const e of view.entities) if (TY[e.type].kind === "resource") lastAmount.set(e.id, e.amount ?? 0)
  console.log(`init me=${me} base=(${baseBox.x},${baseBox.y}) eBase=(${eb.x},${eb.y}) eBk=(${enemyBarracksBox.x},${enemyBarracksBox.y})`)
}

// 矿到两边主基地的走路距离（取矿四周能站的格子里最近的）
function mineStandDist(m: Entity, field: number[]): number {
  let best = -1
  const nb = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]
  for (const [dx, dy] of nb) {
    const x = m.x + dx
    const y = m.y + dy
    if (!walkable(x, y)) continue
    const d = field[ix(x, y)]
    if (d >= 0 && (best < 0 || d < best)) best = d
  }
  return best
}
function mineDist(m: Entity): number {
  let c = mineDistCache.get(m.id)
  if (c === undefined) {
    c = mineStandDist(m, dBase)
    mineDistCache.set(m.id, c)
  }
  return c
}
function mineEnemyDist(m: Entity): number {
  let c = mineEnemyDistCache.get(m.id)
  if (c === undefined) {
    c = mineStandDist(m, dEnemyBase)
    mineEnemyDistCache.set(m.id, c)
  }
  return c
}
function posOurSide(p: Pos): boolean {
  const i = ix(p.x, p.y)
  const a = dBase[i]
  const b = dEnemyBase[i]
  return a >= 0 && (b < 0 || a <= b)
}
function mineOurSide(m: Entity): boolean {
  const a = mineDist(m)
  const b = mineEnemyDist(m)
  return a >= 0 && (b < 0 || a < b)
}

// 集结点：挡在正在采的矿里最靠前的那个和敌人之间（离矿 3～4 步），按走路距离算，两边座位对称
function pickRally(front: Pos): Pos {
  const fi = ix(front.x, front.y)
  let fe = dEnemyBase[fi]
  if (fe < 0) fe = 40
  const want = fe - 4
  let best: Pos = front
  let bestS = 1e9
  for (let y = Math.max(0, front.y - 7); y <= Math.min(H - 1, front.y + 7); y++)
    for (let x = Math.max(0, front.x - 7); x <= Math.min(W - 1, front.x + 7); x++) {
      if (!walkable(x, y)) continue
      const i = ix(x, y)
      if (dEnemyBase[i] < 0 || dBase[i] < 0) continue
      const s = Math.abs(dEnemyBase[i] - want) * 2 + md({ x, y }, front) + dBase[i] * 0.01
      if (s < bestS) {
        bestS = s
        best = { x, y }
      }
    }
  return best
}

// ---------- 兵力估算（兰彻斯特平方律，粗略考虑克制和集火、弓兵射程） ----------
type Counts = Record<string, number>
function emptyCounts(): Counts {
  return { spearman: 0, cavalry: 0, archer: 0 }
}
function total(c: Counts): number {
  return c.spearman + c.cavalry + c.archer
}
function power(A: Counts, B: Counts): number {
  let bHp = 0
  for (const t of MIL) bHp += B[t] * TY[t].maxHp
  let dps = 0
  let hp = 0
  for (const t of MIL) {
    const n = A[t]
    if (!n) continue
    const at = TY[t].attack!
    hp += n * TY[t].maxHp * (t === "archer" ? 1.5 : 1)
    let avg = 0
    let best = 0
    if (bHp <= 0) {
      avg = at.damage
      best = at.damage
    } else {
      for (const y of MIL) {
        if (B[y] <= 0) continue
        avg += ((B[y] * TY[y].maxHp) / bHp) * hit(t, y)
        best = Math.max(best, hit(t, y))
      }
    }
    dps += ((n * (0.5 * avg + 0.5 * best)) / at.cooldown) * (t === "archer" ? 1.3 : 1)
  }
  return dps * hp
}
function ratioOf(A: Counts, B: Counts): number {
  const pa = power(A, B)
  const pb = power(B, A)
  if (pb <= 0) return pa > 0 ? 99 : 1
  return pa / pb
}

// 出兵（v3）：对方配比均衡时按"枪兵为主"的底子出（试下来对 1:1:1 的对手最好：枪兵便宜、血厚、克骑兵，
// 骑兵专切弓兵，弓兵少放一点免得被骑兵吃）；对方越偏某一种兵，越往"克它"的方向偏
const PRIOR: Counts = { spearman: 0.55, cavalry: 0.25, archer: 0.2 }
function chooseUnit(myC: Counts, enC: Counts): TypeName {
  const et = total(enC)
  const want: Counts = emptyCounts()
  if (et < 1) {
    for (const t of MIL) want[t] = PRIOR[t]
  } else {
    let conc = 0
    for (const t of MIL) conc = Math.max(conc, enC[t] / et)
    const w = Math.max(0, Math.min(0.85, (conc - 0.38) / 0.35))
    for (const t of MIL) want[COUNTER_OF[t]] += (w * enC[t]) / et
    for (const t of MIL) want[t] += (1 - w) * PRIOR[t]
  }
  const mt = total(myC)
  let best: TypeName = "spearman"
  let bestS = -1e9
  for (const t of MIL) {
    const s = want[t] * (mt + 1) - myC[t]
    if (s > bestS) {
      bestS = s
      best = t
    }
  }
  return best
}

// ---------- 目标选择 ----------
function threatOf(e: Entity, myShare: Counts): number {
  if (isMil(e.type)) {
    let s = 0
    for (const t of MIL) s += myShare[t] * hit(e.type, t)
    return Math.max(6, s)
  }
  if (e.type === "worker") return 7
  if (e.type === "scout") return 1
  return 0.3
}

// ---------- 主循环 ----------
export function onTick(view: View, cmd: Commands): void {
  if (!inited) {
    initialize(view)
    inited = true
  }
  const tick = view.tick

  for (const ev of view.events) {
    if (ev.kind === "died" && ev.owner !== me && ev.owner >= 0) {
      const s = enemySeen.get(ev.id)
      if (s && isMil(s.type)) enemyMilKilledGold += costOf(s.type)
      else if (isMil(ev.type)) enemyMilKilledGold += costOf(ev.type)
      enemySeen.delete(ev.id)
      enemyWorkerIds.delete(ev.id)
      if (ev.type === "barracks") enemyBarracksDead = true
    } else if (ev.kind === "rejected") {
      console.log(`rejected t${ev.tick} ${ev.command.kind}: ${ev.reason}`)
    } else if (ev.kind === "botError") {
      console.log(`botError ${ev.message}`)
    }
  }

  const mine: Entity[] = []
  const enemies: Entity[] = []
  const mines: Entity[] = []
  const allMines: Entity[] = []
  for (const e of view.entities) {
    if (e.owner === me) mine.push(e)
    else if (TY[e.type].kind === "resource") {
      allMines.push(e)
      if ((e.amount ?? 0) > 0) mines.push(e)
    } else if (isEnemy(view, e)) enemies.push(e)
  }
  for (const e of enemies) {
    if (TY[e.type].kind === "unit") enemySeen.set(e.id, { type: e.type, x: e.x, y: e.y, hp: e.hp, seen: tick })
    if (e.type === "worker") enemyWorkerIds.add(e.id)
  }
  const base = mine.find((e) => e.type === "base")
  const barracks = mine.find((e) => e.type === "barracks")
  const workers = mine.filter((e) => e.type === "worker")
  const army = mine.filter((e) => isMil(e.type))
  const scout = mine.find((e) => e.type === "scout")

  if (!enemyBarracksDead && !enemies.some((e) => e.type === "barracks")) {
    const c = center(enemyBarracksBox)
    if (mine.some((u) => TY[u.type].kind === "unit" && dist(u, c) <= TY[u.type].sight - 1)) enemyBarracksDead = true
  }

  // 对方采了多少：对方那半边的矿少掉的都算对方的；我方这边的矿，只有我的工人没在采、却少了，才算对方的
  const myGatherTargets = new Set<number>()
  for (const w of workers) if (w.order && w.order.kind === "gather") myGatherTargets.add(w.order.target)
  for (const m of allMines) {
    const prev = lastAmount.get(m.id) ?? 0
    const cur = m.amount ?? 0
    const delta = prev - cur
    if (delta > 0) {
      if (!mineOurSide(m)) enemyMinedGold += myGatherTargets.has(m.id) ? delta * 0.5 : delta
      else if (!myGatherTargets.has(m.id)) enemyMinedGold += delta
    }
    lastAmount.set(m.id, cur)
  }

  // 敌方兵力：看到过、没看到死的兵；看太久没见到的打折
  const enC = emptyCounts()
  for (const [, s] of enemySeen) if (isMil(s.type)) enC[s.type] += tick - s.seen < 1500 ? 1 : 0.5
  const myC = emptyCounts()
  for (const u of army) myC[u.type] += 1
  const myTot = Math.max(1, total(myC))
  const myShare: Counts = emptyCounts()
  for (const t of MIL) myShare[t] = total(myC) > 0 ? myC[t] / myTot : 1 / 3

  const enemyMil = enemies.filter((e) => isMil(e.type))
  const enemyMilNear = (p: Pos | Entity, r: number) => enemyMil.filter((e) => dist(e, p) <= r)

  // ---------- 威胁 ----------
  const homeThreat = enemies
    .filter(
      (e) =>
        (isMil(e.type) || e.type === "worker") &&
        (dist(e, baseBox) <= 10 || dist(e, barracksBox) <= 8 || workers.some((w) => dist(w, e) <= 6 && posOurSide(w)))
    )
    .filter((e) => isMil(e.type) || dist(e, baseBox) <= 8)
  const underThreat = homeThreat.length > 0

  // ---------- 生产 ----------
  let gold = view.resources.gold
  const ourMinesGold = mines.filter((m) => mineOurSide(m)).reduce((s, m) => s + (m.amount ?? 0), 0)
  const homeMinesGold = mines.filter((m) => mineDist(m) >= 0 && mineDist(m) <= 8).reduce((s, m) => s + (m.amount ?? 0), 0)
  let targetWorkers = homeMinesGold > 500 ? 11 : 14
  if (ourMinesGold < 1200) targetWorkers = 10
  if (ourMinesGold < 500) targetWorkers = 6
  if (tick > 3800) targetWorkers = 0
  const bq = base && base.queue ? base.queue.length : 0
  const kq = barracks && barracks.queue ? barracks.queue.length : 0
  const wantWorker = !!base && bq === 0 && workers.length + bq < targetWorkers
  const queuedC = emptyCounts()
  for (const t of MIL) queuedC[t] = myC[t]
  if (barracks && barracks.queue) for (const q of barracks.queue) if (isMil(q.type)) queuedC[q.type] += 1
  const nextUnit = chooseUnit(queuedC, enC)
  const workersFirst = workers.length < 8 && !underThreat
  if (wantWorker && workersFirst && gold >= 50) {
    cmd.produce(base!, "worker")
    gold -= 50
  }
  if (barracks && kq < (gold >= 220 ? 2 : 1) && gold >= costOf(nextUnit) && army.length + kq < 46) {
    cmd.produce(barracks, nextUnit)
    gold -= costOf(nextUnit)
  }
  if (wantWorker && !workersFirst && gold >= 50 && (kq > 0 || gold >= 50 + costOf(nextUnit))) {
    cmd.produce(base!, "worker")
    gold -= 50
  }

  // ---------- 工人 ----------
  const dangerMine = new Set<number>()
  for (const m of mines) {
    for (const [, s] of enemySeen) {
      if (!isMil(s.type) || tick - s.seen > 150) continue
      if (md(s, m) <= 7) {
        dangerMine.add(m.id)
        break
      }
    }
  }
  const mineCount = new Map<number, number>()
  for (const w of workers) if (w.order && w.order.kind === "gather") mineCount.set(w.order.target, (mineCount.get(w.order.target) ?? 0) + 1)
  const mineIds = new Set(mines.map((m) => m.id))
  const armyCenter = centroid(army)
  for (const w of workers) {
    // 避险：附近有敌兵、我方兵不够，就往主基地或军队跑
    const near = enemyMilNear(w, 5)
    if (near.length > 0) {
      const friends = army.filter((u) => dist(u, w) <= 6).length
      if (friends < near.length + 1) {
        const dest = pickFleeDest(w, near, armyCenter)
        const o = w.order
        if (!o || o.kind !== "move" || o.x !== dest.x || o.y !== dest.y) cmd.move(w, dest.x, dest.y)
        fleeUntil.set(w.id, tick + 20)
        continue
      }
    }
    const o = w.order
    if ((fleeUntil.get(w.id) ?? 0) > tick && o && o.kind === "move") continue
    let need = !o || o.kind === "idle" || o.kind === "move"
    if (o && o.kind === "gather" && !mineIds.has(o.target)) need = true
    if (o && o.kind === "gather" && dangerMine.has(o.target) && !w.carrying) need = true
    if (!need) continue
    let best: Entity | null = null
    let bestS = 1e9
    for (const m of mines) {
      const dm = mineDist(m)
      if (dm < 0) continue
      if (!mineOurSide(m) && !(mode === "attack" && total(enC) < 2)) continue
      const c = mineCount.get(m.id) ?? 0
      let s = dm + 4 * Math.max(0, c - 1) + (c >= 5 ? 100 : 0)
      if (dangerMine.has(m.id)) s += 200
      if (s < bestS) {
        bestS = s
        best = m
      }
    }
    if (best && dangerMine.has(best.id) && base) {
      // 没有安全的矿：回主基地旁边等
      if (dist(w, base) > 2) cmd.move(w, base.x + 1, base.y + 1)
      continue
    }
    if (best) {
      if (o && o.kind === "gather" && o.target === best.id) continue
      if (o && o.kind === "gather") mineCount.set(o.target, (mineCount.get(o.target) ?? 1) - 1)
      cmd.gather(w, best)
      mineCount.set(best.id, (mineCount.get(best.id) ?? 0) + 1)
    }
  }

  // ---------- 集结点：挡在采矿的地方前面 ----------
  if (tick - rallyTick >= 50) {
    rallyTick = tick
    let front: Pos = center(baseBox)
    let frontE = 1e9
    for (const [id, c] of mineCount) {
      if (c <= 0) continue
      const m = mines.find((x) => x.id === id)
      if (!m || !mineOurSide(m)) continue
      const de = mineEnemyDist(m)
      if (de >= 0 && de < frontE) {
        frontE = de
        front = { x: m.x, y: m.y }
      }
    }
    const bkE = dEnemyBase[ix(barracksBox.x, barracksBox.y)]
    if (bkE >= 0 && bkE < frontE) front = { x: barracksBox.x, y: barracksBox.y }
    rally = pickRally(front)
  }

  // ---------- 侦察兵：躲在敌兵视野外盯着（每次只在身边 4 步内挑最安全又最靠近对方兵营的格子，不会穿过敌兵） ----------
  if (scout) {
    const danger: { p: Pos; r: number }[] = []
    for (const e of enemies) {
      if (isMil(e.type)) danger.push({ p: e, r: sightOf(e.type) + 2 })
      else if (e.type === "worker") danger.push({ p: e, r: 3 })
    }
    for (const [id, s] of enemySeen) {
      if (!isMil(s.type) || tick - s.seen > 60 || tick - s.seen === 0) continue
      if (enemies.some((e) => e.id === id)) continue
      danger.push({ p: s, r: sightOf(s.type) + 1 })
    }
    const scoreCell = (x: number, y: number): number => {
      const i = ix(x, y)
      const dk = dEnemyBk[i]
      if (dk < 0) return -1e9
      let s = -Math.abs(dk - 8) * 2
      for (const d of danger) {
        const m = md(d.p, { x, y })
        if (m < d.r) s -= (d.r - m) * 10
      }
      const db = dist({ x, y }, enemyBaseBox)
      if (db < 8) s -= (8 - db) * 2
      return s
    }
    let bx = scout.x
    let by = scout.y
    let bs = scoreCell(scout.x, scout.y) + 0.5
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const r = Math.abs(dx) + Math.abs(dy)
        if (r === 0 || r > 4) continue
        const x = scout.x + dx
        const y = scout.y + dy
        if (!walkable(x, y)) continue
        const s = scoreCell(x, y) - r * 0.05
        if (s > bs) {
          bs = s
          bx = x
          by = y
        }
      }
    if (bx !== scout.x || by !== scout.y) {
      const o = scout.order
      if (!o || o.kind !== "move" || o.x !== bx || o.y !== by) cmd.move(scout, bx, by)
    } else if (scout.order && scout.order.kind !== "idle") cmd.stop(scout)
  }

  // ---------- 进攻 / 防守 ----------
  // 估计看不到的敌兵：对方采到的金子 - 工人开销 - 已杀的兵
  const enWorkers = Math.max(11, enemyWorkerIds.size)
  const seenTot = total(enC)
  let avgCost = 82
  if (seenTot > 0) avgCost = (enC.spearman * 70 + enC.cavalry * 100 + enC.archer * 75) / seenTot
  const goldEstUnits = Math.max(0, (200 + enemyMinedGold - 50 * (enWorkers - 4) - 40 - enemyMilKilledGold) / avgCost)
  const estTot = Math.max(seenTot, goldEstUnits)
  const enEst: Counts = emptyCounts()
  for (const t of MIL) enEst[t] = seenTot > 0 ? (enC[t] * estTot) / seenTot : estTot / 3
  const ratio = ratioOf(myC, enEst)
  const myScore = view.players[me].score
  let enScore = 0
  for (const p of view.players) if (p.id !== me) enScore = Math.max(enScore, p.score)
  const latePush = tick > 4300 && myScore <= enScore + 100 && army.length >= 6
  if (mode === "defend") {
    if ((army.length >= 8 && ratio >= 1.8) || army.length >= 32 || (enemyBarracksDead && army.length >= 3) || latePush) {
      mode = "attack"
      console.log(`t${tick} 进攻 army=${army.length} ratio=${ratio.toFixed(2)} est=${fmt(enEst)} seen=${fmt(enC)} my=${fmt(myC)}`)
    }
  } else {
    if (!latePush && !enemyBarracksDead && ((ratio < 1.15 && army.length < 32) || army.length < 4)) {
      mode = "defend"
      console.log(`t${tick} 回防 army=${army.length} ratio=${ratio.toFixed(2)} est=${fmt(enEst)} seen=${fmt(enC)} my=${fmt(myC)}`)
    }
  }

  let goal: Pos = rally
  let goalField: number[] | null = null
  if (underThreat) {
    let t0 = homeThreat[0]
    for (const t of homeThreat) if (dist(t, baseBox) < dist(t0, baseBox)) t0 = t
    goal = { x: t0.x, y: t0.y }
  } else if (mode === "attack") {
    if (!enemyBarracksDead) {
      goal = center(enemyBarracksBox)
      goalField = dEnemyBk
    } else {
      goal = center(enemyBaseBox)
      goalField = dEnemyBase
    }
  }

  // 进攻时成团走：太靠前的等一等；掉在很后面的先去追大部队
  const holdAhead = new Set<number>()
  const stragglers = new Set<number>()
  let groupPos: Pos | null = null
  if (goalField && army.length > 1) {
    const ds = army
      .map((u) => ({ u, d: goalField![ix(u.x, u.y)] }))
      .filter((a) => a.d >= 0)
      .sort((a, b) => a.d - b.d)
    if (ds.length > 0) {
      const med = ds[Math.floor(ds.length / 2)].d
      const core = ds.filter((a) => a.d <= med + 12)
      const anchor = core[Math.floor(core.length * 0.6)].d
      for (const a of ds) {
        if (a.d < anchor - 3 && a.d > 7) holdAhead.add(a.u.id)
        if (a.d > med + 12) stragglers.add(a.u.id)
      }
      groupPos = centroid(core.map((a) => a.u))
    }
  }

  // 撤退：防守状态下离家很远的兵，除非敌人贴脸，否则先往回走
  const retreating = mode === "defend" && !underThreat

  // 战场：我军附近、家附近看得到的敌人（侦察兵只在贴脸时打）
  const battle = enemies.filter((e) => {
    if (TY[e.type].kind === "building") return mode === "attack"
    if (homeThreat.includes(e)) return true
    if (e.type === "scout") return army.some((u) => dist(u, e) <= 2)
    return army.some((u) => dist(u, e) <= 9)
  })

  // v3：交战距离。防守时不冲出去追：只和"快碰上"的敌人打（双方射程里大的那个 + 2），让对方走过来；
  // 附近我方明显占优（局部兵力比 ≥ 1.5）或者在家门口、或者在进攻，才放开追
  const localC = emptyCounts()
  const localE = emptyCounts()
  const battleMil = battle.filter((e) => isMil(e.type))
  for (const u of army) if (battleMil.some((e) => dist(u, e) <= 12)) localC[u.type] += 1
  for (const e of battleMil) localE[e.type] += 1
  const localRatio = ratioOf(localC, localE)
  const chase = mode === "attack" || underThreat || localRatio >= 1.5
  const engageDist = (u: Entity, e: Entity): number => {
    if (chase) return 14
    if (!isMil(e.type)) return 6
    return Math.max(rangeOf(u), rangeOf(e)) + 2
  }

  const assigned = new Map<number, number>()
  const sortedArmy = army.slice().sort((a, b) => nearestDist(a, battle) - nearestDist(b, battle))
  const arriveR = 2 + Math.floor(army.length / 6)
  for (const u of sortedArmy) {
    const o = u.order
    const evade = evadeMove(u, enemyMil, army)
    if (evade) {
      if (!o || o.kind !== "move" || o.x !== evade.x || o.y !== evade.y) cmd.move(u, evade.x, evade.y)
      continue
    }
    const farFromHome = dBase[ix(u.x, u.y)] > 0 && dBase[ix(u.x, u.y)] > dBase[ix(rally.x, rally.y)] + 8
    if (retreating && farFromHome && nearestDist(u, enemyMil) > 2) {
      if (!o || o.kind !== "move" || o.x !== rally.x || o.y !== rally.y) cmd.move(u, rally.x, rally.y)
      continue
    }
    let best: Entity | null = null
    let bestS = 0
    const cur = lastTarget.get(u.id)
    for (const e of battle) {
      const d = dist(u, e)
      if (d > engageDist(u, e)) continue
      const isBuilding = TY[e.type].kind === "building"
      const h = hit(u.type, e.type)
      if (h <= 0) continue
      let s: number
      if (isBuilding) s = e.type === "barracks" ? 0.6 : 0.4
      else s = threatOf(e, myShare) * Math.min(1, h / Math.max(1, e.hp))
      s = s / (1 + 0.3 * Math.max(0, d - rangeOf(u)))
      if (u.type === "cavalry" && e.type === "spearman" && e.hp > 40) s *= 0.4
      const a = assigned.get(e.id) ?? 0
      if (!isBuilding && a >= e.hp) s *= 0.35
      if (cur === e.id) s *= 1.25
      if (s > bestS) {
        bestS = s
        best = e
      }
    }
    if (best) {
      assigned.set(best.id, (assigned.get(best.id) ?? 0) + hit(u.type, best.type))
      lastTarget.set(u.id, best.id)
      if (!o || o.kind !== "attack" || o.target !== best.id) cmd.attack(u, best)
      continue
    }
    lastTarget.delete(u.id)
    if (holdAhead.has(u.id)) {
      if (o && o.kind !== "idle") cmd.stop(u)
      continue
    }
    let g = goal
    if (stragglers.has(u.id) && groupPos) g = groupPos
    if (!goalField && !underThreat && md(u, g) <= arriveR) {
      if (o && o.kind === "attackMove" && md(u, g) <= 1) cmd.stop(u)
      continue
    }
    if (!o || o.kind !== "attackMove" || o.x !== g.x || o.y !== g.y) cmd.attackMove(u, g.x, g.y)
  }

  if (tick % 250 === 0) {
    console.log(
      `t${tick} gold=${view.resources.gold} wk=${workers.length} my=${fmt(myC)} seen=${fmt(enC)} est=${estTot.toFixed(1)} enMined=${enemyMinedGold} mode=${mode} ratio=${ratio.toFixed(2)} rally=(${rally.x},${rally.y}) scout=${scout ? scout.x + "," + scout.y : "dead"}`
    )
  }
}

function fmt(c: Counts): string {
  return `s${c.spearman.toFixed(0)}/c${c.cavalry.toFixed(0)}/a${c.archer.toFixed(0)}`
}
function centroid(list: Entity[]): Pos | null {
  if (list.length === 0) return null
  let x = 0
  let y = 0
  for (const e of list) {
    x += e.x
    y += e.y
  }
  return { x: Math.round(x / list.length), y: Math.round(y / list.length) }
}
function nearestDist(u: Entity, list: Entity[]): number {
  let b = 1e9
  for (const e of list) b = Math.min(b, dist(u, e))
  return b
}
function pickFleeDest(w: Entity, threats: Entity[], armyCenter: Pos | null): Pos {
  const home = center(baseBox)
  const cands: Pos[] = [home]
  if (armyCenter) cands.push(armyCenter)
  let best = home
  let bestS = -1e9
  for (const c of cands) {
    let s = 0
    for (const t of threats) s += Math.min(8, md(t, c)) - md(t, w) * 0.2
    s -= md(w, c) * 0.3
    if (s > bestS) {
      bestS = s
      best = c
    }
  }
  return best
}
// 骑兵躲枪兵、弓兵躲骑兵和贴脸的枪兵（冷却没好时），往自己的兵那边退
function evadeMove(u: Entity, enemyMil: Entity[], army: Entity[]): Pos | null {
  // v3：弓兵不躲了（骑兵比弓兵快，躲也躲不掉，只会少打几下）；骑兵只在贴着枪兵、附近 5 格又没有别的可打时退开
  let danger: Entity[] = []
  if (u.type === "cavalry") {
    danger = enemyMil.filter((e) => e.type === "spearman" && dist(e, u) <= 1 && e.hp > 40)
    if (enemyMil.some((e) => e.type !== "spearman" && dist(e, u) <= 5)) return null
  }
  if (danger.length === 0) return null
  const guards = army.filter((a) => a.type === (u.type === "archer" ? "spearman" : "archer") || a.type === "spearman")
  let best: Pos | null = null
  let bestS = -1e9
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) {
      if (Math.abs(dx) + Math.abs(dy) > 3) continue
      const x = u.x + dx
      const y = u.y + dy
      if (!walkable(x, y)) continue
      let dmin = 1e9
      for (const d of danger) dmin = Math.min(dmin, md(d, { x, y }))
      let g = 0
      for (const a of guards) if (a.id !== u.id && md(a, { x, y }) <= 3) g += 1
      const s = Math.min(dmin, 5) * 3 + Math.min(g, 3) - dBase[ix(x, y)] * 0.05
      if (s > bestS) {
        bestS = s
        best = { x, y }
      }
    }
  if (!best || (best.x === u.x && best.y === u.y)) return null
  return best
}
