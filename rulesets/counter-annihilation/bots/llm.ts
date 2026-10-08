// 大模型试写（最强）：每个兵按克制倍数自己挑目标，按看到的敌兵出克它的兵，用金矿少掉的量估算对方兵力，算好了再进攻。
// 外部大模型试写的 bot（2026-10-08，D-167）：子代理只读了 PROMPT.md、看不到平台源码和参考 bot 的源码，写了 5 版，
// 当时对 baseline、boom、counter、mobile、rush 各打 20 局共 95 胜 5 负。原样收录作为更强的陪练。
// 写它的时候还没有侦察兵，所以它不用侦察兵（侦察兵一直留在家里）。

const W = game.width
const H = game.height
const TY = game.types
const MIL: TypeName[] = ["spearman", "cavalry", "archer"]

function isMil(t: TypeName): boolean {
  return t === "spearman" || t === "cavalry" || t === "archer"
}
function milIdx(t: TypeName): number {
  return t === "spearman" ? 0 : t === "cavalry" ? 1 : t === "archer" ? 2 : -1
}
function cost(t: TypeName): number {
  return TY[t].cost.gold ?? 0
}
function dmgOf(a: TypeName, b: TypeName): number {
  const at = TY[a].attack
  if (!at) return 0
  const m = (at.vs && at.vs[b]) ?? 1
  return Math.round(at.damage * m)
}
function rangeOf(t: TypeName): number {
  const at = TY[t].attack
  return at ? at.range : 0
}

// ---------- 状态 ----------
let inited = false
let me = 0
let myTeam = 0
let baseId = -1
let barracksId = -1
let basePos: Pos = { x: 0, y: 0 }
let enemyBase: Pos = { x: 0, y: 0 }
let dB: number[] = []
let dE: number[] = []
let rally: Pos = { x: 0, y: 0 }
let mode: "defend" | "attack" = "defend"
let producedMil = 0
let spentTotal = 0
let curTick = 0
let enemyMined = 0
let killedMil = 0
let lostMil = 0
interface Mem {
  type: TypeName
  x: number
  y: number
  seen: number
}
const mem = new Map<number, Mem>()

function isEnemyOwner(o: number): boolean {
  return o >= 0 && game.teams[o] !== myTeam
}
function idx(x: number, y: number): number {
  return y * W + x
}
function walkable(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= W || y >= H) return false
  return game.walkable[game.terrain[y][x]] === true
}

function init(view: View): void {
  inited = true
  me = view.me
  myTeam = game.teams[me]
  for (const e of view.entities) {
    if (e.owner !== me) continue
    if (e.type === "base") {
      baseId = e.id
      basePos = { x: e.x, y: e.y }
    } else if (e.type === "barracks") barracksId = e.id
  }
  const eb = view.objectives.enemyBases.find((b) => isEnemyOwner(b.owner)) ?? view.objectives.enemyBases[0]
  enemyBase = { x: eb.x, y: eb.y }
  const base = view.entities.find((e) => e.id === baseId)!
  dB = pathDistances(view, base)
  const cells: Pos[] = []
  for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) cells.push({ x: eb.x + dx, y: eb.y + dy })
  dE = pathDistances(view, cells)
  for (let i = 0; i < W * H; i++) if (dB[i] >= 0 && dE[i] >= 0 && dB[i] + dE[i] < pathD) pathD = dB[i] + dE[i]
  for (const e of view.entities) if (e.type === "goldmine") mineInit.set(e.id, e.amount ?? 0)
  rally = rallyAt(6)
  // 侦察点：对手兵营（和我的中心对称）外面 6 格、靠我这边的一格
  const myBar = view.entities.find((e) => e.id === barracksId)!
  const ebx = W - myBar.x - myBar.w
  const eby = H - myBar.y - myBar.h
  const ebar = { x: ebx, y: eby, w: myBar.w, h: myBar.h }
  let bestW = Infinity
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!walkable(x, y) || dB[idx(x, y)] < 0) continue
      const d = dist({ x, y }, ebar)
      if (d < 5 || d > 7) continue
      const s = dB[idx(x, y)] + Math.abs(d - 6) * 3
      if (s < bestW) {
        bestW = s
        watch = { x, y }
      }
    }
  console.log(`init me=${me} base=(${basePos.x},${basePos.y}) enemy=(${enemyBase.x},${enemyBase.y}) D=${pathD} rally=(${rally.x},${rally.y})`)
}

// 集结点：在两家之间（近乎）最短的路上，离自家约 R 步
let pathD = Infinity
const rallyCache = new Map<number, Pos>()
function rallyAt(R: number): Pos {
  const c = rallyCache.get(R)
  if (c) return c
  let best = Infinity
  let p: Pos = { x: basePos.x, y: basePos.y }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = idx(x, y)
      if (dB[i] < 0 || dE[i] < 0 || !walkable(x, y)) continue
      if (dB[i] + dE[i] > pathD + 2) continue
      const s = Math.abs(dB[i] - R) * 10 + (dB[i] + dE[i] - pathD)
      if (s < best) {
        best = s
        p = { x, y }
      }
    }
  rallyCache.set(R, p)
  return p
}

// 侦察工人
let watch: Pos = { x: 0, y: 0 }
let scoutId = -1
let scoutNext = 1e9
let scoutArrive = -1
let scoutStart = 0
let lastMilSeen = -1000

// 金矿开局的储量；对手采了多少 = 所有金矿少掉的 − 我采的
const mineInit = new Map<number, number>()
let enemyWorkersSeen = new Set<number>()

// ---------- 小模拟：两支军队（按类型计数）对打，双方都按克制挑目标 ----------
function killsBy(att: number[], def: number[]): number[] {
  const kills = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    let cap = att[i]
    if (cap <= 0) continue
    const order = [0, 1, 2]
      .map((j) => ({ j, eff: dmgOf(MIL[i], MIL[j]) / TY[MIL[j]].maxHp }))
      .sort((a, b) => b.eff - a.eff)
    for (const o of order) {
      const left = def[o.j] - kills[o.j]
      if (left <= 1e-6) continue
      const need = left / o.eff
      const use = Math.min(cap, need)
      kills[o.j] += use * o.eff
      cap -= use
      if (cap <= 1e-9) break
    }
  }
  return kills
}
function armyValue(a: number[]): number {
  return a[0] * cost("spearman") + a[1] * cost("cavalry") + a[2] * cost("archer")
}
function simulate(ours: number[], theirs: number[]): [number, number] {
  let a = ours.slice()
  let b = theirs.slice()
  for (let step = 0; step < 80; step++) {
    const sa = a[0] + a[1] + a[2]
    const sb = b[0] + b[1] + b[2]
    if (sa < 0.05 || sb < 0.05) break
    // 第一步只有弓兵先射（射程 4）
    const aa = step === 0 ? [0, 0, a[2]] : a
    const bb = step === 0 ? [0, 0, b[2]] : b
    const ka = killsBy(aa, b)
    const kb = killsBy(bb, a)
    b = b.map((v, j) => Math.max(0, v - ka[j]))
    a = a.map((v, j) => Math.max(0, v - kb[j]))
  }
  return [armyValue(a), armyValue(b)]
}

// ---------- 敌军估计 ----------
const PRIOR = [1, 1.5, 1]
function enemyEstimate(): number[] {
  const seen = [0, 0, 0]
  for (const m of mem.values()) {
    const k = milIdx(m.type)
    if (k >= 0) seen[k]++
  }
  const seenVal = armyValue(seen)
  // 对手最多能有多少兵：它采到的金 + 开局 200 − 造工人花的 − 被我打死的兵
  const workerSpend = Math.max(200, (enemyWorkersSeen.size - 4) * 50)
  const guessVal = Math.max(0, enemyMined + 200 - workerSpend - killedMil)
  const est = seen.slice()
  if (guessVal > seenVal) {
    const tot = seen[0] + seen[1] + seen[2]
    const comp = tot >= 3 ? seen.map((v) => v / tot) : PRIOR.map((v) => v / 3.2)
    const avg = comp[0] * cost("spearman") + comp[1] * cost("cavalry") + comp[2] * cost("archer")
    const n = (guessVal - seenVal) / avg
    for (let i = 0; i < 3; i++) est[i] += n * comp[i]
  }
  return est
}

// 看到过的敌兵（活着的按 1 算，死了的按 0.3 算，反映对手的出兵倾向）
const seenDead = [0, 0, 0]
function enemyComp(): number[] {
  const c = [0, 0, 0]
  for (const m of mem.values()) {
    const k = milIdx(m.type)
    if (k >= 0) c[k]++
  }
  for (let i = 0; i < 3; i++) c[i] += 0.3 * seenDead[i]
  return c
}

// 按对手的配比出克它的兵：枪兵 ∝ 对方骑兵，骑兵 ∝ 对方弓兵，弓兵 ∝ 对方枪兵；挑缺得最多的
function chooseUnit(our: number[], ec: number[]): TypeName {
  // 先验：没看到对手的兵时偏向枪兵（防骑兵速攻）；看到的越多先验越轻
  const tot = ec[0] + ec[1] + ec[2]
  const k = Math.max(0.2, 1 - tot / 6)
  // 预判：会看兵出兵的对手会出克我的兵（我的枪兵多 → 它出弓兵……），看到的越少这部分越重
  const r = REACT * Math.max(0.3, 1 - tot / 10)
  const e = [ec[0] + k + r * our[1], ec[1] + CAVPRIOR * k + r * our[2], ec[2] + k + r * our[0]]
  const want = [e[1], e[2], e[0]]
  const wt = want[0] + want[1] + want[2]
  const ot = our[0] + our[1] + our[2] + 1
  let best = 0
  let bestD = -Infinity
  for (let i = 0; i < 3; i++) {
    const d = want[i] / wt - our[i] / ot
    if (d > bestD) {
      bestD = d
      best = i
    }
  }
  return MIL[best]
}

// ---------- 工人 ----------
interface MineInfo {
  e: Entity
  trip: number
  cap: number
  load: number
  safe: boolean
  enemySide: boolean
  slots: number
  walkD: number
}

function mineInfos(view: View, mines: Entity[], enemies: Entity[]): MineInfo[] {
  const res: MineInfo[] = []
  const occupied = new Set<number>()
  for (const e of view.entities) {
    if (TY[e.type].kind === "unit") continue
    for (let dy = 0; dy < e.h; dy++) for (let dx = 0; dx < e.w; dx++) occupied.add(idx(e.x + dx, e.y + dy))
  }
  for (const m of mines) {
    let slots = 0
    let wmin = Infinity
    let emin = Infinity
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const x = m.x + dx
      const y = m.y + dy
      if (!walkable(x, y) || occupied.has(idx(x, y))) continue
      slots++
      const d = dB[idx(x, y)]
      if (d >= 0 && d < wmin) wmin = d
      const de = dE[idx(x, y)]
      if (de >= 0 && de < emin) emin = de
    }
    if (slots === 0 || wmin === Infinity) continue
    const walk = Math.max(0, wmin - 1) * 3
    const trip = 25 + 2 * walk + 4
    let safe = true
    for (const en of enemies) {
      if (isMil(en.type) && dist(en, m) <= 6) {
        safe = false
        break
      }
    }
    res.push({ e: m, trip, cap: Math.max(1, Math.floor((slots * trip) / 25)), load: 0, safe, enemySide: emin < wmin, slots, walkD: wmin })
  }
  return res
}

// ---------- 交战：按克制挑目标 ----------
function threatOf(e: Entity, ourComp: number[]): number {
  // e 打我方军队一下平均能打掉多少价值
  const tot = ourComp[0] + ourComp[1] + ourComp[2]
  if (!TY[e.type].attack) return 0
  if (tot <= 0) return dmgOf(e.type, "worker") / TY.worker.maxHp * cost("worker")
  let s = 0
  for (let i = 0; i < 3; i++) s += (ourComp[i] / tot) * (dmgOf(e.type, MIL[i]) / TY[MIL[i]].maxHp) * cost(MIL[i])
  return s
}

function engage(units: Entity[], enemies: Entity[], cmd: Commands, ourComp: number[], radius: number): Set<number> {
  const engaged = new Set<number>()
  if (enemies.length === 0) return engaged
  const planned = new Map<number, number>()
  const wAtk = new Map<number, number>()
  const threat = new Map<number, number>()
  for (const e of enemies) threat.set(e.id, threatOf(e, ourComp))
  // 弓兵、骑兵先挑（它们的目标最挑剔），枪兵后挑
  const order = units.slice().sort((a, b) => {
    const pa = a.type === "cavalry" ? 0 : a.type === "archer" ? 1 : 2
    const pb = b.type === "cavalry" ? 0 : b.type === "archer" ? 1 : 2
    return pa - pb
  })
  for (const u of order) {
    const rng = rangeOf(u.type)
    const mt = TY[u.type].moveTicks
    let best: Entity | null = null
    let bestS = 0
    for (const e of enemies) {
      const d = dist(u, e)
      if (d > radius) continue
      const isBld = TY[e.type].kind === "building"
      const dmg = dmgOf(u.type, e.type)
      if (dmg <= 0) continue
      // 工人：只打身边的（骑兵可以追远一点），每个工人最多两个人打，免得全军被工人带着跑
      if (e.type === "worker") {
        const g = d - rng
        if (g > (u.type === "cavalry" ? 6 : 2)) continue
        if ((wAtk.get(e.id) ?? 0) >= 2) continue
      }
      let val: number
      if (isBld) val = e.type === "barracks" ? 0.6 : 0.3
      else {
        // dmg/hp × (造价 + 3×威胁)，hp 用扣掉别人这一轮已经要打的之后
        const left = Math.max(0, e.hp - (planned.get(e.id) ?? 0))
        val = (dmg / e.maxHp) * (cost(e.type) + 3 * (threat.get(e.id) ?? 0)) * (1 + FOCUS * (1 - left / e.maxHp))
        if (left <= 0) val *= 0.25
        if (e.type === "worker") val *= 0.6
      }
      const gap = Math.max(0, d - rng)
      let s = val / (1 + (gap * mt) / 6)
      if (u.order && u.order.kind === "attack" && u.order.target === e.id) s *= 1.3
      if (s > bestS) {
        bestS = s
        best = e
      }
    }
    if (best) {
      engaged.add(u.id)
      cmd.attack(u, best)
      const gap = Math.max(0, dist(u, best) - rng)
      if (gap * mt <= 6) planned.set(best.id, (planned.get(best.id) ?? 0) + dmgOf(u.type, best.type))
      if (best.type === "worker") wAtk.set(best.id, (wAtk.get(best.id) ?? 0) + 1)
    }
  }
  return engaged
}

let lastLog = -1000
const FOCUS = 1.0
const REACT = 0.5
const CAVPRIOR = 2.0

export function onTick(view: View, cmd: Commands): void {
  if (!inited) init(view)
  const tick = view.tick
  curTick = tick
  let gold = view.resources.gold

  for (const ev of view.events) {
    if (ev.kind === "died") {
      if (isEnemyOwner(ev.owner)) {
        if (isMil(ev.type)) {
          killedMil += cost(ev.type)
          seenDead[milIdx(ev.type)]++
        }
        mem.delete(ev.id)
      } else if (ev.owner === me && isMil(ev.type)) lostMil += cost(ev.type)
    } else if (ev.kind === "created") {
      if (isMil(ev.type)) producedMil += cost(ev.type)
      spentTotal += cost(ev.type)
    } else if (ev.kind === "rejected") {
      console.log(`rejected ${JSON.stringify(ev.command)}: ${ev.reason}`)
    } else if (ev.kind === "botError") {
      console.log(`botError ${ev.message}`)
    }
  }

  const mine: Entity[] = []
  const enemies: Entity[] = []
  const mines: Entity[] = []
  for (const e of view.entities) {
    if (e.type === "goldmine") {
      if ((e.amount ?? 0) > 0) mines.push(e)
    } else if (e.owner === me) mine.push(e)
    else if (isEnemyOwner(e.owner)) enemies.push(e)
  }
  for (const e of enemies) {
    if (isMil(e.type)) mem.set(e.id, { type: e.type, x: e.x, y: e.y, seen: tick })
    else if (e.type === "worker") enemyWorkersSeen.add(e.id)
  }

  const base = mine.find((e) => e.id === baseId)
  const barracks = mine.find((e) => e.id === barracksId)
  const workers = mine.filter((e) => e.type === "worker")
  const army = mine.filter((e) => isMil(e.type))

  // 对手采了多少金：金矿一共少掉的 − 我交了的 − 我工人手上带着的
  {
    const cur = new Map<number, number>()
    for (const m of mines) cur.set(m.id, m.amount ?? 0)
    let depleted = 0
    for (const [id, a0] of mineInit) depleted += a0 - (cur.get(id) ?? 0)
    let queued = 0
    for (const b of [base, barracks]) if (b && b.queue) for (const q of b.queue) queued += cost(q.type)
    let carry = 0
    for (const w of workers) if (w.carrying) carry += w.carrying.amount
    const ourMined = gold + spentTotal + queued - 200
    enemyMined = Math.max(0, depleted - ourMined - carry)
  }

  const ourComp = [0, 0, 0]
  for (const u of army) ourComp[milIdx(u.type)]++
  const queuedComp = ourComp.slice()
  if (barracks && barracks.queue) for (const q of barracks.queue) if (isMil(q.type)) queuedComp[milIdx(q.type)]++
  const est = enemyEstimate()

  // ---------- 生产 ----------
  const queuedWorkers = base && base.queue ? base.queue.length : 0
  const workerTarget = (tick < 1100 ? 11 : 15) + (scoutId >= 0 ? 1 : 0)
  const nW = workers.length + queuedWorkers
  const wantWorker = base && nW < workerTarget && (!base.queue || base.queue.length === 0)
  let reserve = 0
  const doWorker = () => {
    if (wantWorker && base && gold >= cost("worker") + reserve) {
      cmd.produce(base, "worker")
      gold -= cost("worker")
    }
  }
  if (nW < 10) doWorker()
  if (barracks && (!barracks.queue || barracks.queue.length === 0)) {
    const t = chooseUnit(queuedComp, enemyComp())
    if (gold >= cost(t)) {
      cmd.produce(barracks, t)
      gold -= cost(t)
      console.log(`produce ${t} our=${queuedComp.join("/")} est=${est.map((v) => v.toFixed(1)).join("/")}`)
    } else reserve = cost(t)
  }
  if (nW >= 10) doWorker()

  // ---------- 工人 ----------
  const infos = mineInfos(view, mines, enemies)
  const byId = new Map<number, MineInfo>()
  for (const m of infos) byId.set(m.e.id, m)
  for (const w of workers) {
    if (w.order && w.order.kind === "gather") {
      const m = byId.get(w.order.target)
      if (m) m.load++
    }
  }
  // 矿的"代价"：往返时间 × (1 + 已有人数/能站的格数)，人越多越不划算，这样会摊到各个矿上
  const mineCost = (m: MineInfo, w: Entity, extra: number) => m.trip * (1 + (m.load + extra) / m.slots) + dist(w, m.e) * 0.5
  const allowed = (m: MineInfo) => m.safe && (!m.enemySide || mode === "attack")
  // 工人躲敌兵：4 格内有敌兵、3 格内没有自己的兵，就往最近的自己的兵跑（没有兵就往远离敌人的方向跑）
  const enemyMilVis = enemies.filter((e) => isMil(e.type))
  // 侦察：派一个工人去对手兵营外面看它出什么兵，看 250 tick 回来采矿，过 500 tick 再去
  if (enemyMilVis.length > 0) lastMilSeen = tick
  let scout = workers.find((w) => w.id === scoutId)
  if (scoutId >= 0 && !scout) {
    scoutId = -1
    scoutNext = tick + 450
  }
  // 到了侦察点看 60 tick、或者看到了敌兵（会触发躲避）、或者走太久，就回去采矿
  const scoutThreat = scout ? enemyMilVis.some((e) => dist(e, scout!) <= 6) : false
  if (scout && ((scoutArrive >= 0 && tick > scoutArrive + 60) || scoutThreat || tick > scoutStart + 400)) {
    scoutId = -1
    scout = undefined
    scoutNext = tick + 450
  }
  if (!scout && tick >= scoutNext && tick - lastMilSeen > 300 && tick < 3000 && mode === "defend" && workers.length >= 10) {
    const cand = workers.filter((w) => !w.carrying).sort((a, b) => dE[idx(a.x, a.y)] - dE[idx(b.x, b.y)])
    if (cand.length) {
      scout = cand[0]
      scoutId = scout.id
      scoutArrive = -1
      scoutStart = tick
    }
  }
  if (scout && scoutArrive < 0 && dist(scout, watch) <= 1) scoutArrive = tick
  const fleeing = new Set<number>()
  for (const w of workers) {
    let ne: Entity | null = null
    let nd = 5
    for (const e of enemyMilVis) {
      const d = dist(w, e)
      if (d < nd) {
        nd = d
        ne = e
      }
    }
    if (!ne) continue
    let guard = false
    let near: Entity | null = null
    let neard = 16
    for (const u of army) {
      const d = dist(w, u)
      if (d <= 3) guard = true
      if (d < neard && dist(u, ne) >= 2) {
        neard = d
        near = u
      }
    }
    if (guard) continue
    fleeing.add(w.id)
    if (near) cmd.move(w, near.x, near.y)
    else {
      const sx = Math.sign(w.x - ne.x)
      const sy = Math.sign(w.y - ne.y)
      let tx = Math.max(0, Math.min(W - 1, w.x + sx * 4))
      let ty = Math.max(0, Math.min(H - 1, w.y + sy * 4))
      if (!walkable(tx, ty)) {
        tx = basePos.x + 1
        ty = basePos.y + 1
      }
      cmd.move(w, tx, ty)
    }
  }
  if (scout && !fleeing.has(scout.id)) cmd.move(scout, watch.x, watch.y)
  for (const w of workers) {
    if (fleeing.has(w.id) || w.id === scoutId) continue
    let need = !w.order || w.order.kind === "idle" || w.order.kind === "move"
    if (w.order && w.order.kind === "gather") {
      const m = byId.get(w.order.target)
      if (!m) need = true
      else if (!m.safe && !w.carrying) need = true
    }
    if (!need) continue
    let best: MineInfo | null = null
    let bestS = Infinity
    for (const m of infos) {
      if (!allowed(m)) continue
      const s = mineCost(m, w, 0)
      if (s < bestS) {
        bestS = s
        best = m
      }
    }
    if (best) {
      if (w.order && w.order.kind === "gather") {
        const old = byId.get(w.order.target)
        if (old) old.load--
      }
      cmd.gather(w, best.e)
      best.load++
    } else if (w.order && w.order.kind !== "idle" && base) {
      cmd.move(w, basePos.x + 1, basePos.y + 3)
    }
  }
  // 每次最多调一个工人：从最挤的矿调到明显更划算的矿
  {
    let worstW: Entity | null = null
    let worstM: MineInfo | null = null
    let worstR = 1
    for (const w of workers) {
      if (!w.order || w.order.kind !== "gather" || w.carrying || fleeing.has(w.id)) continue
      const m = byId.get(w.order.target)
      if (!m) continue
      const r = m.load / m.slots
      if (r > worstR) {
        worstR = r
        worstW = w
        worstM = m
      }
    }
    if (worstW && worstM) {
      const cur = worstM.trip * (1 + (worstM.load - 1) / worstM.slots)
      let best: MineInfo | null = null
      let bestS = cur * 0.8
      for (const m of infos) {
        if (m === worstM || !allowed(m)) continue
        const s = m.trip * (1 + m.load / m.slots) + dist(worstW, m.e) * 0.5
        if (s < bestS) {
          bestS = s
          best = m
        }
      }
      if (best) {
        cmd.gather(worstW, best.e)
        worstM.load--
        best.load++
      }
    }
  }

  // ---------- 军队 ----------
  // 威胁：靠近我方基地或工人的敌兵
  const threats: Entity[] = []
  for (const e of enemies) {
    if (!TY[e.type].attack) continue
    const de = dB[idx(e.x, e.y)]
    let near = de >= 0 && de <= 14
    if (!near)
      for (const w of workers)
        if (w.id !== scoutId && dist(w, e) <= 5 && dE[idx(w.x, w.y)] > 12) {
          near = true
          break
        }
    if (near) threats.push(e)
  }

  const [r0, r1] = simulate(ourComp, est)
  const ourVal = armyValue(ourComp)
  if (mode === "defend") {
    if (army.length >= 6 && r0 > r1 && r0 >= ourVal * 0.4) mode = "attack"
  } else {
    if (army.length < 3 || r0 < r1 * 0.8) mode = "defend"
  }
  // 集结点跟着工人走：工人去了中间的矿，集结点就往前挪到矿前面
  {
    let far = 0
    for (const w of workers) {
      if (!w.order || w.order.kind !== "gather") continue
      const m = byId.get(w.order.target)
      if (!m) continue
      const d = m.walkD
      if (d > far) far = d
    }
    rally = rallyAt(Math.max(6, Math.min(13, far + 1)))
  }

  let engagedSet = new Set<number>()
  if (threats.length > 0) {
    const tc = { x: 0, y: 0 }
    for (const t of threats) {
      tc.x += t.x
      tc.y += t.y
    }
    tc.x = Math.round(tc.x / threats.length)
    tc.y = Math.round(tc.y / threats.length)
    engagedSet = engage(army, threats.concat(enemies.filter((e) => isMil(e.type))), cmd, ourComp, 12)
    for (const u of army) {
      if (engagedSet.has(u.id)) continue
      cmd.attackMove(u, tc.x, tc.y)
    }
  } else {
    engagedSet = engage(army, enemies.filter((e) => TY[e.type].kind === "unit"), cmd, ourComp, 12)
    let free = army.filter((u) => !engagedSet.has(u.id))
    if (mode === "attack") {
      // 对手有骑兵时留两个枪兵看家（防骑兵绕过来杀工人）
      const cavThreat = est[1] >= 0.8
      if (cavThreat && army.length >= 8) {
        const home = rallyAt(6)
        const sp = free.filter((u) => u.type === "spearman").sort((a, b) => dB[idx(a.x, a.y)] - dB[idx(b.x, b.y)])
        const guards = sp.slice(0, 2)
        for (const g of guards) if (dist(g, home) > 2) cmd.attackMove(g, home.x, home.y)
        const gs = new Set(guards.map((g) => g.id))
        free = free.filter((u) => !gs.has(u.id))
      }
      const ebEnt = enemies.find((e) => e.type === "base")
      const ebar = enemies.find((e) => e.type === "barracks")
      const ds = free.map((u) => dE[idx(u.x, u.y)]).filter((d) => d >= 0).sort((a, b) => a - b)
      const med = ds.length ? ds[Math.floor(ds.length / 2)] : 0
      for (const u of free) {
        const d = dE[idx(u.x, u.y)]
        if (ebar && dist(u, ebar) <= 10) cmd.attack(u, ebar)
        else if (ebEnt && dist(u, ebEnt) <= 10) cmd.attack(u, ebEnt)
        else if (d >= 0 && d < med - 4 && d > 8) cmd.stop(u)
        else cmd.attackMove(u, enemyBase.x + 1, enemyBase.y + 1)
      }
    } else {
      for (const u of free) {
        if (dist(u, rally) <= 3 && (!u.order || u.order.kind === "idle")) continue
        if (dist(u, rally) <= 2) continue
        cmd.attackMove(u, rally.x, rally.y)
      }
    }
  }

  if (tick - lastLog >= 250) {
    lastLog = tick
    console.log(
      `t${tick} gold=${view.resources.gold} W=${workers.length} army=${ourComp.join("/")} est=${est.map((v) => v.toFixed(1)).join("/")} sim=${r0.toFixed(0)}:${r1.toFixed(0)} mode=${mode} threats=${threats.length} prod=${producedMil} kill=${killedMil} lost=${lostMil}`,
    )
  }
}
