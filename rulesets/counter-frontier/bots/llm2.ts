// 大模型第二轮试写（偏强）：仓库贴着矿放、三座兵营，出兵按小模拟挑「对手多出 30% 克我的兵时最不亏」的那种，侦察兵在对手家外轮换盯着，模拟占优再出击。
// 外部大模型试写的 bot（2026-10-08，D-168）：子代理只读了 PROMPT.md、看不到平台源码和参考 bot 的源码，写到第 3 版停下，
// 当时对 baseline、counter、rush、turtle 各 20 局全胜，对 expand 18-2、llm 4-16。原样收录，强度在 llm 和其余参考 bot 之间（参考 bot 联赛 77%，llm 100%）。

const W = game.width
const H = game.height
const T = game.types
const ME = game.me
const MYTEAM = game.teams[ME]
const MIL: TypeName[] = ["spearman", "cavalry", "archer"]

function isEnemyOwner(o: number): boolean { return o >= 0 && game.teams[o] !== MYTEAM }
function isMil(t: TypeName): boolean { return t === "spearman" || t === "cavalry" || t === "archer" }
function gcost(t: TypeName): number { return T[t].cost.gold ?? 0 }
function vsMult(a: TypeName, b: TypeName): number {
  const at = T[a].attack
  if (!at || !at.vs) return 1
  const m = at.vs[b]
  return m === undefined ? 1 : m
}
function dmgVs(a: TypeName, b: TypeName): number {
  const at = T[a].attack
  return at ? Math.round(at.damage * vsMult(a, b)) : 0
}
function walk(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < W && y < H && game.walkable[game.terrain[y][x]] === true
}
function I(x: number, y: number): number { return y * W + x }
function md(a: Pos, b: Pos): number { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) }
function rectOf(e: Entity): { x: number; y: number; w: number; h: number } { return { x: e.x, y: e.y, w: e.w, h: e.h } }

// ---------------- 状态 ----------------
let inited = false
let baseId = 0
let baseC: Pos = { x: 0, y: 0 }
let eBaseRect = { x: 0, y: 0, w: 3, h: 3 }
let eBaseC: Pos = { x: 0, y: 0 }
let dMy: number[] = []
let dEn: number[] = []
let pathToEnemy: Pos[] = []
let rally: Pos = { x: 0, y: 0 }
let homeRally: Pos = { x: 0, y: 0 }
let scoutPts: Pos[] = []

interface Cluster { id: number; mines: number[]; cx: number; cy: number; dMy: number; dEn: number; total: number }
const clusters: Cluster[] = []
const mineCl = new Map<number, number>()
let expCl: Cluster | null = null
let homeCl: Cluster | null = null
let centerCl: Cluster | null = null

interface Known { type: TypeName; x: number; y: number; seen: number }
const known = new Map<number, Known>() // 看到过、还没确认死掉的敌方实体
const everSeenType: Record<string, number> = { spearman: 0, cavalry: 0, archer: 0 }
const enemyKills: number[] = [] // 我方看到的敌兵死亡时刻
let lastEnemyBaseLook = -9999 // 上次看到对手主基地附近的时刻

interface BuildTask { key: string; type: TypeName; x: number; y: number; worker: number; helpers: number; near: Pos; bid: number; tries: number; done: boolean; margin: number; range: number; prefer: Pos[] }
const builds: BuildTask[] = []
const buildWorkers = new Set<number>()

let mode: "defend" | "attack" = "defend"
let attackStartSize = 0
let retreatUntil = 0
let retreatMoveUntil = 0
let wp = 0
let wpMovedAt = 0
const attackGroup = new Set<number>()
let scoutIdx = 0
let scoutSwitchAt = 0
let scoutReturnAt = 0
let distDrop: number[] = []
let dropKey = ""
let gold = 0
const mineDanger = new Map<number, number>()

// ---------------- 工具 ----------------
function rectTiles(x: number, y: number, w: number, h: number): Pos[] {
  const r: Pos[] = []
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) r.push({ x: xx, y: yy })
  return r
}
function nearestWalkable(p: Pos): Pos {
  const px = Math.max(0, Math.min(W - 1, p.x)), py = Math.max(0, Math.min(H - 1, p.y))
  for (let r = 0; r < 14; r++) {
    for (let dx = -r; dx <= r; dx++) {
      const dy1 = r - Math.abs(dx)
      for (const dy of dy1 === 0 ? [0] : [dy1, -dy1]) {
        const x = px + dx, y = py + dy
        if (walk(x, y) && dMy[I(x, y)] >= 0) return { x, y }
      }
    }
  }
  return { x: px, y: py }
}
// 贴着矩形的、能走的、离 from 最近的格子
function adjCell(rect: { x: number; y: number; w: number; h: number }, from: Pos, occ: Set<number>): Pos {
  let best: Pos = { x: rect.x, y: rect.y - 1 }
  let bd = 1e9
  for (let x = rect.x - 1; x <= rect.x + rect.w; x++) for (let y = rect.y - 1; y <= rect.y + rect.h; y++) {
    if (dist({ x, y }, rect) !== 1 || !walk(x, y) || occ.has(I(x, y))) continue
    const d = md({ x, y }, from)
    if (d < bd) { bd = d; best = { x, y } }
  }
  return best
}

function init(view: View): void {
  inited = true
  const base = view.entities.find((e) => e.owner === ME && e.type === "base")!
  baseId = base.id
  baseC = { x: base.x + 1, y: base.y + 1 }
  const eb = view.objectives.enemyBases.find((b) => isEnemyOwner(b.owner))!
  eBaseRect = { x: eb.x, y: eb.y, w: 3, h: 3 }
  eBaseC = { x: eb.x + 1, y: eb.y + 1 }
  dMy = pathDistances(view, base)
  dEn = pathDistances(view, rectTiles(eb.x, eb.y, 3, 3))
  // 从家走到对手家的路
  let cur: Pos | null = null
  let best = 1e9
  for (let x = base.x - 1; x <= base.x + 3; x++) for (let y = base.y - 1; y <= base.y + 3; y++) {
    if (!walk(x, y)) continue
    const d = dEn[I(x, y)]
    if (d >= 0 && dist({ x, y }, base) === 1 && d < best) { best = d; cur = { x, y } }
  }
  while (cur && pathToEnemy.length < 300) {
    pathToEnemy.push(cur)
    const d = dEn[I(cur.x, cur.y)]
    if (d <= 1) break
    let nx: Pos | null = null
    let nb = d
    let nc = 1e9
    for (const c of [{ x: cur.x + 1, y: cur.y }, { x: cur.x - 1, y: cur.y }, { x: cur.x, y: cur.y + 1 }, { x: cur.x, y: cur.y - 1 }]) {
      if (c.x < 0 || c.y < 0 || c.x >= W || c.y >= H) continue
      const v = dEn[I(c.x, c.y)]
      const cc = Math.abs(c.x - (W - 1) / 2) + Math.abs(c.y - (H - 1) / 2)
      if (v >= 0 && (v < nb || (v === nb && cc < nc))) { nb = v; nx = c; nc = cc }
    }
    cur = nx
  }
  homeRally = pickPath((p) => dMy[I(p.x, p.y)] >= 8)
  rally = homeRally

  // 资源点分片
  const mines = view.entities.filter((e) => e.type === "goldmine")
  const seen = new Set<number>()
  for (const m of mines) {
    if (seen.has(m.id)) continue
    const cl: Cluster = { id: clusters.length, mines: [], cx: 0, cy: 0, dMy: 0, dEn: 0, total: 0 }
    const q = [m]
    seen.add(m.id)
    while (q.length) {
      const a = q.pop()!
      cl.mines.push(a.id)
      mineCl.set(a.id, cl.id)
      for (const b of mines) if (!seen.has(b.id) && md(a, b) <= 3) { seen.add(b.id); q.push(b) }
    }
    let sx = 0, sy = 0, dm = 1e9, de = 1e9
    for (const id of cl.mines) {
      const e = mines.find((z) => z.id === id)!
      sx += e.x; sy += e.y; cl.total += e.amount ?? 0
      for (const c of [{ x: e.x + 1, y: e.y }, { x: e.x - 1, y: e.y }, { x: e.x, y: e.y + 1 }, { x: e.x, y: e.y - 1 }]) {
        if (!walk(c.x, c.y)) continue
        const a1 = dMy[I(c.x, c.y)], a2 = dEn[I(c.x, c.y)]
        if (a1 >= 0) dm = Math.min(dm, a1)
        if (a2 >= 0) de = Math.min(de, a2)
      }
    }
    cl.cx = Math.round(sx / cl.mines.length)
    cl.cy = Math.round(sy / cl.mines.length)
    cl.dMy = dm
    cl.dEn = de
    clusters.push(cl)
  }
  let homeBest = 1e9
  for (const c of clusters) if (c.dMy <= 8 && c.dMy < homeBest) { homeBest = c.dMy; homeCl = c }
  let expBest = -1
  for (const c of clusters) {
    if (c.dMy <= 8 || c.dEn < c.dMy + 10) continue
    const s = c.total / (c.dMy + 10)
    if (s > expBest) { expBest = s; expCl = c }
  }
  let cBest = -1
  for (const c of clusters) {
    if (c === expCl || c.dMy <= 8 || c.dEn < c.dMy) continue
    const s = c.total / (c.dMy + 10)
    if (s > cBest) { cBest = s; centerCl = c }
  }
  // 侦察点：离对手主基地 9～10 格，正面和两侧
  const sx = Math.sign(baseC.x - eBaseC.x), sy = Math.sign(baseC.y - eBaseC.y)
  const front = pickPath((p) => dEn[I(p.x, p.y)] <= 10)
  const flankA = nearestWalkable({ x: eBaseC.x + sx * 11, y: eBaseC.y })
  const flankB = nearestWalkable({ x: eBaseC.x, y: eBaseC.y + sy * 11 })
  const diag = nearestWalkable({ x: eBaseC.x + sx * 7, y: eBaseC.y + sy * 6 })
  scoutPts = [diag, flankA, front, flankB]
  console.log(`init P${ME} base=(${base.x},${base.y}) enemy=(${eb.x},${eb.y}) rally=(${rally.x},${rally.y}) exp=${expCl ? expCl.cx + "," + expCl.cy : "none"} center=${centerCl ? centerCl.cx + "," + centerCl.cy : "none"} scout=${scoutPts.map((p) => p.x + "," + p.y).join(" ")}`)
}
function pickPath(pred: (p: Pos) => boolean): Pos {
  for (const p of pathToEnemy) if (pred(p)) return p
  return pathToEnemy[pathToEnemy.length - 1] ?? baseC
}

// ---------------- 交货点、矿 ----------------
function updateDropDist(view: View, drops: Entity[]): void {
  const key = drops.map((d) => d.id).sort().join(",") + "|" + view.entities.filter((e) => e.owner === ME && T[e.type].kind === "building").length
  if (key === dropKey) return
  dropKey = key
  distDrop = pathDistances(view, drops)
}
function mineSlots(m: Entity, blocked: Set<number>): Pos[] {
  const r: Pos[] = []
  for (const c of [{ x: m.x + 1, y: m.y }, { x: m.x - 1, y: m.y }, { x: m.x, y: m.y + 1 }, { x: m.x, y: m.y - 1 }]) {
    if (walk(c.x, c.y) && !blocked.has(I(c.x, c.y))) r.push(c)
  }
  return r
}
function mineTrip(slots: Pos[]): number {
  let best = 1e9
  for (const s of slots) {
    const d = distDrop[I(s.x, s.y)]
    if (d >= 0 && d < best) best = d
  }
  if (best >= 1e9) return 1e9
  return 25 + 2 * Math.max(0, best - 1) * 3 + 2
}

// 仓库放哪：让站在矿边的格子同时贴着仓库
function depotSpot(view: View, cl: Cluster, blocked: Set<number>): Pos[] {
  const mines: Entity[] = []
  for (const id of cl.mines) {
    const e = view.entities.find((z) => z.id === id)
    if (e && (e.amount ?? 0) > 0) mines.push(e)
  }
  if (mines.length === 0) return []
  const mineCells = new Set<number>()
  for (const m of view.entities) if (m.type === "goldmine") mineCells.add(I(m.x, m.y))
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1
  for (const m of mines) { minX = Math.min(minX, m.x); minY = Math.min(minY, m.y); maxX = Math.max(maxX, m.x); maxY = Math.max(maxY, m.y) }
  const cands: { p: Pos; s: number }[] = []
  for (let y = minY - 3; y <= maxY + 2; y++) for (let x = minX - 3; x <= maxX + 2; x++) {
    let ok = true
    const fp = new Set<number>()
    for (let yy = y; yy < y + 2 && ok; yy++) for (let xx = x; xx < x + 2; xx++) {
      if (!walk(xx, yy) || mineCells.has(I(xx, yy)) || blocked.has(I(xx, yy))) { ok = false; break }
      fp.add(I(xx, yy))
    }
    if (!ok) continue
    const rect = { x, y, w: 2, h: 2 }
    let s = 0
    let anyLeft = true
    for (const m of mines) {
      let good = 0, left = 0
      for (const c of [{ x: m.x + 1, y: m.y }, { x: m.x - 1, y: m.y }, { x: m.x, y: m.y + 1 }, { x: m.x, y: m.y - 1 }]) {
        if (!walk(c.x, c.y) || mineCells.has(I(c.x, c.y)) || fp.has(I(c.x, c.y)) || blocked.has(I(c.x, c.y))) continue
        left++
        if (dist(c, rect) === 1) good++
      }
      if (left === 0) anyLeft = false
      s += Math.min(good, 2) * 10 - dist(m, rect)
    }
    if (!anyLeft) continue
    s -= 0.01 * dMy[I(x, y)]
    cands.push({ p: { x, y }, s })
  }
  cands.sort((a, b) => b.s - a.s)
  return cands.slice(0, 6).map((c) => c.p)
}

// ---------------- 建造 ----------------
function addBuild(key: string, type: TypeName, near: Pos, prefer: Pos[], margin: number, range: number, helpers: number): void {
  builds.push({ key, type, x: -1, y: -1, worker: 0, helpers, near, bid: 0, tries: 0, done: false, margin, range, prefer })
}
function hasBuild(key: string): boolean { return builds.some((b) => b.key === key) }
function buildAlive(key: string): boolean { return builds.some((b) => b.key === key && !b.done) }

// 地基上有什么挡着：'ok' 能放；'unit' 只有单位（等等或让开）；'bad' 建筑、资源、地形
function footprintState(view: View, type: TypeName, x: number, y: number): "ok" | "unit" | "bad" | "fog" {
  const w = T[type].w, h = T[type].h
  if (x < 0 || y < 0 || x + w > W || y + h > H) return "bad"
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (!walk(xx, yy)) return "bad"
  let unit = false
  for (const e of view.entities) {
    if (e.x >= x + w || e.x + e.w <= x || e.y >= y + h || e.y + e.h <= y) continue
    if (T[e.type].kind === "unit") unit = true
    else return "bad"
  }
  const p = buildProblem(view, type, x, y)
  if (p === null) return "ok"
  if (unit) return "unit"
  if (p.indexOf("视野") >= 0) return "fog"
  return "bad"
}

function runBuilds(view: View, cmd: Commands, my: Entity[], workers: Entity[]): number {
  let reserve = 0
  buildWorkers.clear()
  const occ = new Set<number>()
  for (const e of view.entities) if (T[e.type].kind !== "unit") for (const t of rectTiles(e.x, e.y, e.w, e.h)) occ.add(I(t.x, t.y))
  for (const b of builds) {
    if (b.done) continue
    if (b.bid) {
      const be = my.find((e) => e.id === b.bid)
      if (!be) { b.done = true; console.log(`build ${b.key} lost`); continue }
      if (!be.construction) { b.done = true; continue }
      const builders: Entity[] = []
      for (const e of workers) if (e.order?.kind === "build" && e.order.target === be.id) builders.push(e)
      let w = workers.find((e) => e.id === b.worker)
      if (w && !builders.includes(w)) builders.push(w)
      if (builders.length === 0) {
        w = pickWorker(workers.filter((e) => !buildWorkers.has(e.id)), be)
        if (!w) continue
        b.worker = w.id
        builders.push(w)
      }
      while (builders.length < b.helpers + 1) {
        const h = pickWorker(workers.filter((e) => !builders.includes(e) && !buildWorkers.has(e.id)), be)
        if (!h || dist(h, be) > 10) break
        builders.push(h)
      }
      for (const u of builders) {
        buildWorkers.add(u.id)
        if (!(u.order?.kind === "build" && u.order.target === be.id)) cmd.build(u, b.type, be.x, be.y)
      }
      continue
    }
    const cost = gcost(b.type)
    let w = workers.find((e) => e.id === b.worker)
    if (!w) {
      w = pickWorker(workers.filter((e) => !buildWorkers.has(e.id)), b.x >= 0 ? { x: b.x, y: b.y } : b.near)
      if (!w) { reserve += cost; continue }
      b.worker = w.id
    }
    buildWorkers.add(w.id)
    const placed = my.find((e) => e.type === b.type && e.x === b.x && e.y === b.y && e.construction)
    if (placed) { b.bid = placed.id; continue }
    if (b.x < 0) {
      let spot: Pos | null = null
      for (const p of b.prefer) {
        const st = footprintState(view, b.type, p.x, p.y)
        if (st !== "bad") { spot = p; break }
      }
      if (!spot) spot = findBuildSpot(view, b.type, b.near, b.range, b.margin)
      if (!spot) {
        if (md(w, b.near) > 3 && w.order?.kind !== "move") cmd.move(w, b.near.x, b.near.y)
        reserve += cost
        continue
      }
      b.x = spot.x; b.y = spot.y
    }
    const rect = { x: b.x, y: b.y, w: T[b.type].w, h: T[b.type].h }
    const st = footprintState(view, b.type, b.x, b.y)
    const far = dist(w, rect)
    if (st === "ok") {
      if (gold >= cost) {
        cmd.build(w, b.type, b.x, b.y)
        gold -= cost
        b.tries++
      } else {
        reserve += cost
        if (far > 3) {
          const a = adjCell(rect, w, occ)
          if (!(w.order?.kind === "move" && w.order.x === a.x && w.order.y === a.y)) cmd.move(w, a.x, a.y)
        }
      }
      if (b.tries > 6) { console.log(`build ${b.key} (${b.x},${b.y}) keeps failing`); b.x = -1; b.tries = 0; b.prefer = [] }
    } else if (st === "unit" || st === "fog") {
      reserve += cost
      // 走到地基旁边（别站在地基上）
      const inside = w.x >= rect.x && w.x < rect.x + rect.w && w.y >= rect.y && w.y < rect.y + rect.h
      const a = adjCell(rect, w, occ)
      if (inside || far > 1) {
        if (!(w.order?.kind === "move" && w.order.x === a.x && w.order.y === a.y)) cmd.move(w, a.x, a.y)
      } else if (st === "fog" && w.order?.kind === "idle") {
        console.log(`build ${b.key} (${b.x},${b.y}) still fog next to it`)
        b.prefer = b.prefer.filter((p) => !(p.x === b.x && p.y === b.y))
        b.x = -1
      }
    } else {
      reserve += cost
      console.log(`build ${b.key} spot (${b.x},${b.y}) bad: ${buildProblem(view, b.type, b.x, b.y)}`)
      b.prefer = b.prefer.filter((p) => !(p.x === b.x && p.y === b.y))
      b.x = -1
    }
  }
  return reserve
}

function pickWorker(workers: Entity[], near: Pos | Entity): Entity | undefined {
  let best: Entity | undefined
  let bs = 1e9
  for (const w of workers) {
    let s = dist(w, near)
    if (w.carrying) s += 3
    if (w.order?.kind === "build") s += 50
    if (s < bs) { bs = s; best = w }
  }
  return best
}

// ---------------- 敌情 ----------------
function updateKnown(view: View, myUnits: Entity[]): void {
  for (const ev of view.events) {
    if (ev.kind === "died") {
      const k = known.get(ev.id)
      if (k && isMil(k.type)) enemyKills.push(view.tick)
      known.delete(ev.id)
    }
  }
  for (const e of view.entities) {
    if (!isEnemyOwner(e.owner)) continue
    if (!known.has(e.id) && isMil(e.type)) everSeenType[e.type]++
    known.set(e.id, { type: e.type, x: e.x, y: e.y, seen: view.tick })
  }
  // 建筑：位置在视野里却没看到，就是没了
  for (const [id, k] of known) {
    if (T[k.type].kind === "unit") {
      if (view.tick - k.seen > 1500) known.delete(id)
      continue
    }
    if (k.seen === view.tick) continue
    for (const u of myUnits) {
      if (md(u, k) <= T[u.type].sight - 1) { known.delete(id); break }
    }
  }
  for (const u of myUnits) if (dist(u, eBaseRect) <= T[u.type].sight + 4) lastEnemyBaseLook = view.tick
}
function enemyMilCounts(): Record<string, number> {
  const c: Record<string, number> = { spearman: 0, cavalry: 0, archer: 0 }
  for (const k of known.values()) if (isMil(k.type)) c[k.type]++
  return c
}

// 兰彻斯特式兵力估计：A 打 B 的强度（总血量 × 对 B 的平均每 tick 伤害）
function strength(A: TypeName[], B: TypeName[]): number {
  if (A.length === 0) return 0
  let hpA = 0
  for (const a of A) hpA += T[a].maxHp
  let hpB = 0
  const hpBy: Record<string, number> = {}
  for (const b of B) { hpB += T[b].maxHp; hpBy[b] = (hpBy[b] ?? 0) + T[b].maxHp }
  let dps = 0
  for (const a of A) {
    const at = T[a].attack
    if (!at) continue
    if (hpB === 0) { dps += at.damage / at.cooldown; continue }
    let m = 0
    for (const bt in hpBy) m += (hpBy[bt] / hpB) * dmgVs(a, bt as TypeName)
    dps += m / at.cooldown
  }
  return dps * hpA
}

// ---------------- 按兵种汇总的小模拟（每轮 8 tick，各兵种打自己杀得最快的那类） ----------------
const MHP = MIL.map((t) => T[t].maxHp)
const MCOST = MIL.map((t) => gcost(t))
const DMG = MIL.map((a) => MIL.map((b) => dmgVs(a, b)))
const PRI = MIL.map((_, a) => [0, 1, 2].sort((x, y) => DMG[a][y] / MHP[y] - DMG[a][x] / MHP[x]))
const RANGED = MIL.map((t) => (T[t].attack?.range ?? 1) > 1)
function counts(types: TypeName[]): number[] {
  const c = [0, 0, 0]
  for (const t of types) { const i = MIL.indexOf(t); if (i >= 0) c[i]++ }
  return c
}
function armyValue(c: number[]): number { return c[0] * MCOST[0] + c[1] * MCOST[1] + c[2] * MCOST[2] }
// 返回 A 剩下的价值 − B 剩下的价值；extraB 是对面额外的固定火力（箭塔），按每轮伤害、血量折算
function simFight(A: number[], B: number[], towersB = 0): number {
  const hA = [A[0] * MHP[0], A[1] * MHP[1], A[2] * MHP[2]]
  const hB = [B[0] * MHP[0], B[1] * MHP[1], B[2] * MHP[2]]
  let towerHp = towersB * 450
  for (let r = 0; r < 50; r++) {
    const nA = [0, 1, 2].map((i) => Math.ceil(hA[i] / MHP[i] - 1e-9))
    const nB = [0, 1, 2].map((i) => Math.ceil(hB[i] / MHP[i] - 1e-9))
    const sA = nA[0] + nA[1] + nA[2], sB = nB[0] + nB[1] + nB[2]
    if (sA === 0 || (sB === 0 && towerHp <= 0)) break
    const dA = [0, 0, 0], dB = [0, 0, 0]
    // 前排：对面还有近战兵时，枪兵够不着后排的弓兵，骑兵绕过去打弓兵打折扣
    const meleeB = nB[0] + nB[1], meleeA = nA[0] + nA[1]
    for (let a = 0; a < 3; a++) {
      if (!nA[a] || (r === 0 && !RANGED[a])) continue
      let tgt = -1
      let eff = 1
      for (const b of PRI[a]) {
        if (!nB[b]) continue
        if (b === 2 && meleeB > 0 && !RANGED[a]) {
          if (a === 0) continue
          eff = 0.6
        }
        tgt = b
        break
      }
      if (tgt >= 0) dB[tgt] += nA[a] * DMG[a][tgt] * eff
      else towerHp -= nA[a] * T[MIL[a]].attack!.damage
    }
    for (let b = 0; b < 3; b++) {
      if (!nB[b] || (r === 0 && !RANGED[b])) continue
      for (const a of PRI[b]) {
        if (!nA[a]) continue
        let eff = 1
        if (a === 2 && meleeA > 0 && !RANGED[b]) {
          if (b === 0) continue
          eff = 0.6
        }
        dA[a] += nB[b] * DMG[b][a] * eff
        break
      }
    }
    if (towerHp > 0) {
      // 箭塔每 10 tick 打 12，打最近的；这里平摊到我方最多的兵种
      let a = 0
      for (let i = 1; i < 3; i++) if (nA[i] > nA[a]) a = i
      dA[a] += towersB * 12 * 0.8
    }
    for (let i = 0; i < 3; i++) { hA[i] = Math.max(0, hA[i] - dA[i]); hB[i] = Math.max(0, hB[i] - dB[i]) }
  }
  let v = 0
  for (let i = 0; i < 3; i++) v += (hA[i] / MHP[i]) * MCOST[i] - (hB[i] / MHP[i]) * MCOST[i]
  return v - (towerHp > 0 ? towerHp / 450 * 100 : 0)
}

// 对面的兵：看到的；情报旧或太少时按比例往大里估
function estimateEnemy(myN: number, stale: boolean): number[] {
  const e = enemyMilCounts()
  let c = [e.spearman, e.cavalry, e.archer]
  let tot = c[0] + c[1] + c[2]
  if (tot < 3) {
    const s = everSeenType
    const st = s.spearman + s.cavalry + s.archer
    if (st >= 3) {
      const want = Math.max(tot, 3)
      c = [s.spearman / st * want, s.cavalry / st * want, s.archer / st * want].map((x) => Math.round(x))
    } else c = [1, 1, 1]
    tot = c[0] + c[1] + c[2]
  }
  const floor = stale ? Math.ceil(myN * 0.8) : 0
  if (tot < floor) {
    const k = floor / tot
    c = c.map((x) => Math.round(x * k))
  }
  return c
}

// ---------------- 出兵选择：对面可能针对我再出兵，挑最坏情况下最好的 ----------------
let lastChoiceLog = 0
function chooseUnit(myMil: Record<string, number>, stale: boolean): TypeName {
  const A = [myMil.spearman, myMil.cavalry, myMil.archer]
  const nA = A[0] + A[1] + A[2]
  const B = estimateEnemy(nA, stale)
  const nB = B[0] + B[1] + B[2]
  const scaleB = Math.max(nB, Math.ceil(nA * 0.7), 4)
  const Bs = B.map((x) => x * scaleB / Math.max(1, nB))
  const G = Math.max(150, 0.25 * armyValue(A))
  const k = Math.max(2, Math.round(0.3 * scaleB))
  let best = 0
  let bs = -1e18
  const detail: string[] = []
  for (let x = 0; x < 3; x++) {
    const A2 = A.slice()
    A2[x] += Math.max(1, Math.round(G / MCOST[x]))
    let worst = 1e18
    for (let r = -1; r < 3; r++) {
      const B2 = Bs.map((v) => Math.round(v))
      if (r >= 0) B2[r] += k
      const v = simFight(A2, B2)
      if (v < worst) worst = v
    }
    detail.push(MIL[x] + ":" + Math.round(worst))
    if (worst > bs + 1e-6) { bs = worst; best = x }
  }
  if (tickNow - lastChoiceLog >= 400) {
    lastChoiceLog = tickNow
    console.log(`t${tickNow} choose my=${A.join("/")} enemy=${B.join("/")} ${detail.join(" ")} -> ${MIL[best]}`)
  }
  return MIL[best]
}
let tickNow = 0

// ---------------- 打仗 ----------------
function targetScore(u: Entity, e: Entity, incoming: Map<number, number>): number {
  const at = T[u.type].attack!
  const d = dist(u, e)
  const dmg = Math.max(1, dmgVs(u.type, e.type))
  const inc = incoming.get(e.id) ?? 0
  const hits = Math.ceil(Math.max(1, e.hp - inc) / dmg)
  let value: number
  if (isMil(e.type)) value = gcost(e.type) + 2 * dmgVs(e.type, u.type)
  else if (e.type === "tower") value = e.construction ? 30 : 100
  else if (e.type === "worker") value = 45
  else if (e.type === "scout") value = 12
  else if (e.type === "base") value = 50
  else if (e.type === "barracks") value = e.construction ? 25 : 40
  else value = 20
  const travel = Math.max(0, d - at.range) * T[u.type].moveTicks
  let s = value / (hits * at.cooldown + travel + 8)
  if (inc >= e.hp) s *= 0.3
  return s
}

let rallyFallbackUntil = 0
function onTickImpl(view: View, cmd: Commands): void {
  tickNow = view.tick
  if (!inited) init(view)
  gold = view.resources.gold

  const my: Entity[] = []
  const enemies: Entity[] = []
  for (const e of view.entities) {
    if (e.owner === ME) my.push(e)
    else if (isEnemyOwner(e.owner)) enemies.push(e)
  }
  const base = my.find((e) => e.id === baseId)
  if (!base) return
  const myUnits = my.filter((e) => T[e.type].kind === "unit")
  updateKnown(view, myUnits)
  const workers = my.filter((e) => e.type === "worker")
  const army = my.filter((e) => isMil(e.type))
  const scout = my.find((e) => e.type === "scout")
  const barracks = my.filter((e) => e.type === "barracks")
  const doneBarracks = barracks.filter((e) => !e.construction)
  const drops = my.filter((e) => T[e.type].dropOff && !e.construction)
  const mines = view.entities.filter((e) => e.type === "goldmine" && (e.amount ?? 0) > 0)
  const enemyMil = enemies.filter((e) => isMil(e.type))

  // 矿边有敌兵：标危险
  for (const m of mines) {
    for (const e of enemyMil) if (dist(e, m) <= 7) { mineDanger.set(m.id, view.tick + 200); break }
  }

  // ---------- 建造计划 ----------
  const nWorkers = workers.length + (base.queue ? base.queue.filter((q) => q.type === "worker").length : 0)
  if (!hasBuild("barracks1") && (nWorkers >= 8 || view.tick >= 250)) addBuild("barracks1", "barracks", pathToEnemy[Math.min(5, pathToEnemy.length - 1)] ?? baseC, [], 1, 8, 1)
  if (expCl && !hasBuild("depotExp")) addBuild("depotExp", "depot", { x: expCl.cx, y: expCl.cy }, depotSpot(view, expCl, new Set<number>()), 0, 5, 0)
  if (!hasBuild("barracks2") && nWorkers >= 13) addBuild("barracks2", "barracks", pathToEnemy[Math.min(6, pathToEnemy.length - 1)] ?? baseC, [], 1, 9, 1)
  if (homeCl && !hasBuild("depotHome") && nWorkers >= 10) {
    const blocked = new Set<number>()
    for (const e of my) if (T[e.type].kind === "building") for (const t of rectTiles(e.x - 1, e.y - 1, e.w + 2, e.h + 2)) blocked.add(I(t.x, t.y))
    const spots = depotSpot(view, homeCl, blocked)
    if (spots.length) addBuild("depotHome", "depot", { x: homeCl.cx, y: homeCl.cy }, spots, 0, 4, 0)
  }
  if (!hasBuild("tower1") && nWorkers >= 15 && view.tick >= 800) addBuild("tower1", "tower", homeRally, [], 1, 5, 1)
  if (!hasBuild("barracks3") && nWorkers >= 18 && gold > 250) addBuild("barracks3", "barracks", pathToEnemy[Math.min(7, pathToEnemy.length - 1)] ?? baseC, [], 1, 10, 1)
  // 分矿有敌人来过：补一座塔
  if (expCl && !hasBuild("towerExp") && view.tick > 600) {
    const dep = my.find((e) => e.type === "depot" && md(e, { x: expCl!.cx, y: expCl!.cy }) <= 4)
    if (dep && expCl.mines.some((id) => (mineDanger.get(id) ?? 0) > view.tick)) addBuild("towerExp", "tower", { x: expCl.cx, y: expCl.cy }, [], 1, 4, 1)
  }
  // 家门口和分矿快采完了：去中间开矿（附近没敌人、有兵时）
  if (centerCl && !hasBuild("depotCenter") && view.tick > 1200 && army.length >= 8) {
    let left = 0
    for (const m of mines) {
      const c = mineCl.get(m.id)
      if ((homeCl && c === homeCl.id) || (expCl && c === expCl.id)) left += m.amount ?? 0
    }
    const danger = centerCl.mines.some((id) => (mineDanger.get(id) ?? 0) > view.tick)
    if (left < 1400 && !danger) {
      addBuild("depotCenter", "depot", { x: centerCl.cx, y: centerCl.cy }, depotSpot(view, centerCl, new Set<number>()), 0, 5, 0)
    }
  }
  const reserve = runBuilds(view, cmd, my, workers)
  // 中间的仓库建好了：集结点挪过去守矿
  const cdep = centerCl ? my.find((e) => e.type === "depot" && md(e, { x: centerCl!.cx, y: centerCl!.cy }) <= 5) : undefined
  if (cdep && !cdep.construction && view.tick >= rallyFallbackUntil) {
    let bp = rally
    let bd = 1e9
    for (const p of pathToEnemy) {
      const d = md(p, cdep)
      if (d < bd && dMy[I(p.x, p.y)] <= dEn[I(p.x, p.y)]) { bd = d; bp = p }
    }
    rally = bp
  } else rally = homeRally

  // ---------- 生产 ----------
  updateDropDist(view, drops)
  let safeGold = 0
  for (const m of mines) {
    const c = mineCl.get(m.id)
    const cl = c === undefined ? null : clusters[c]
    if (cl && cl.dEn >= cl.dMy) safeGold += m.amount ?? 0
  }
  const targetWorkers = safeGold > 1500 ? 20 : safeGold > 600 ? 14 : 8
  const myMil: Record<string, number> = { spearman: 0, cavalry: 0, archer: 0 }
  for (const a of army) myMil[a.type]++
  for (const b of doneBarracks) for (const q of b.queue ?? []) if (isMil(q.type)) myMil[q.type]++
  let uc = myUnits.length + (base.queue?.length ?? 0) + doneBarracks.reduce((s, b) => s + (b.queue?.length ?? 0), 0)

  const threatHome = homeThreat(enemyMil, my)
  if ((base.queue?.length ?? 0) === 0 && nWorkers < targetWorkers && uc < game.unitCap) {
    const needArmyFirst = threatHome > 0 && army.length < 3
    const res = doneBarracks.length === 0 ? reserve : Math.min(reserve, 100)
    if (!needArmyFirst && gold - res >= 50) {
      cmd.produce(base, "worker")
      gold -= 50
      uc++
    }
  }
  for (const b of doneBarracks) {
    if ((b.queue?.length ?? 0) >= 1) continue
    if (uc >= game.unitCap) break
    const t = chooseUnit(myMil, view.tick - lastEnemyBaseLook > 400)
    const c = gcost(t)
    const keep = reserve + (nWorkers < Math.min(targetWorkers, 13) && threatHome === 0 ? 50 : 0)
    if (gold - keep >= c) {
      cmd.produce(b, t)
      gold -= c
      myMil[t]++
      uc++
    }
  }

  runWorkers(view, cmd, workers, mines, enemyMil, army)
  if (scout) runScout(view, cmd, scout, enemies)
  runArmy(view, cmd, army, enemies, my, threatHome)
}

function homeThreat(enemyMil: Entity[], my: Entity[]): number {
  let v = 0
  const blds = my.filter((e) => T[e.type].kind === "building")
  for (const e of enemyMil) {
    for (const b of blds) {
      if (dist(e, b) <= 9) { v += gcost(e.type); break }
    }
  }
  return v
}

function runWorkers(view: View, cmd: Commands, workers: Entity[], mines: Entity[], enemyMil: Entity[], army: Entity[]): void {
  const blocked = new Set<number>()
  for (const e of view.entities) if (T[e.type].kind === "building") for (const t of rectTiles(e.x, e.y, e.w, e.h)) blocked.add(I(t.x, t.y))
  interface MI { m: Entity; cap: number; trip: number; n: number; danger: boolean }
  const info = new Map<number, MI>()
  for (const m of mines) {
    const slots = mineSlots(m, blocked)
    if (slots.length === 0) continue
    const trip = mineTrip(slots)
    if (trip >= 1e9) continue
    let danger = (mineDanger.get(m.id) ?? 0) > view.tick
    const cl = mineCl.get(m.id)
    const c = cl === undefined ? null : clusters[cl]
    if (c && c.dEn < c.dMy - 2) danger = true
    const cap = Math.min(slots.length, trip > 45 ? slots.length : Math.max(2, slots.length - 1)) + (trip > 50 ? 1 : 0)
    info.set(m.id, { m, cap, trip, n: 0, danger })
  }
  const free: Entity[] = []
  for (const w of workers) {
    if (buildWorkers.has(w.id)) continue
    // 躲兵：附近有敌兵、自己的兵不够
    let threat: Entity | null = null
    let td = 1e9
    for (const e of enemyMil) {
      const d = dist(e, w)
      if (d <= 5 && d < td) { td = d; threat = e }
    }
    if (threat) {
      let mineN = 0, theirN = 0
      for (const a of army) if (dist(a, w) <= 7) mineN++
      for (const e of enemyMil) if (dist(e, w) <= 7) theirN++
      if (mineN < theirN) {
        const dx = Math.sign(w.x - threat.x), dy = Math.sign(w.y - threat.y)
        let p = nearestWalkable({ x: w.x + dx * 6, y: w.y + dy * 6 })
        if (md(threat, baseC) > 8) p = nearestWalkable({ x: baseC.x + Math.sign(rally.x - baseC.x) * -1, y: baseC.y + 2 })
        if (!(w.order?.kind === "move")) cmd.move(w, p.x, p.y)
        continue
      }
    }
    const o = w.order
    if (o && o.kind === "gather") {
      const mi = info.get(o.target)
      if (mi && !mi.danger && mi.n < mi.cap + 1) { mi.n++; continue }
    }
    free.push(w)
  }
  for (const w of free) {
    let best: MI | null = null
    let bs = 1e9
    for (const mi of info.values()) {
      let s = mi.trip + md(w, mi.m) * 0.5
      if (mi.n >= mi.cap) s += 60 + 30 * (mi.n - mi.cap)
      if (mi.danger) s += 300
      if (s < bs) { bs = s; best = mi }
    }
    if (best) {
      best.n++
      const o = w.order
      if (!(o && o.kind === "gather" && o.target === best.m.id)) cmd.gather(w, best.m)
    }
  }
}

function runScout(view: View, cmd: Commands, s: Entity, enemies: Entity[]): void {
  // 危险：敌兵在它的视野 +1 以内、箭塔 6 以内、工人 2 以内
  const threats: Entity[] = []
  for (const e of enemies) {
    const d = dist(e, s)
    if (isMil(e.type) && d <= T[e.type].sight + 1) threats.push(e)
    else if (e.type === "tower" && d <= 6) threats.push(e)
    else if (e.type === "worker" && d <= 2) threats.push(e)
  }
  let damaged = false
  for (const ev of view.events) if (ev.kind === "damaged" && ev.id === s.id) damaged = true
  if (threats.length || damaged) {
    // 周围 6 格里找离威胁最远的格子（偏向自己家）
    let best: Pos = { x: s.x, y: s.y }
    let bs = -1e9
    for (let dx = -6; dx <= 6; dx++) for (let dy = -6; dy <= 6; dy++) {
      if (Math.abs(dx) + Math.abs(dy) > 6) continue
      const x = s.x + dx, y = s.y + dy
      if (!walk(x, y) || dMy[I(x, y)] < 0) continue
      let mind = 99
      for (const t of threats) mind = Math.min(mind, dist({ x, y }, t))
      if (threats.length === 0) mind = 0
      const sc = mind * 10 - dMy[I(x, y)] * 0.5 + (dist({ x, y }, eBaseRect) >= 7 ? 5 : 0)
      if (sc > bs) { bs = sc; best = { x, y } }
    }
    cmd.move(s, best.x, best.y)
    scoutReturnAt = view.tick + 40
    return
  }
  if (view.tick < scoutReturnAt) return
  if (view.tick >= scoutSwitchAt) {
    scoutIdx = (scoutIdx + 1) % scoutPts.length
    scoutSwitchAt = view.tick + 120
  }
  const p = scoutPts[scoutIdx]
  if (!(s.x === p.x && s.y === p.y) && !(s.order?.kind === "move" && s.order.x === p.x && s.order.y === p.y)) cmd.move(s, p.x, p.y)
}

function recentKills(tick: number, window: number): number {
  let n = 0
  for (const t of enemyKills) if (tick - t <= window) n++
  return n
}

function runArmy(view: View, cmd: Commands, army: Entity[], enemies: Entity[], my: Entity[], threatHome: number): void {
  if (army.length === 0) { mode = "defend"; return }
  const A = counts(army.map((a) => a.type))
  const vA = armyValue(A)
  // 情报旧了就往大里估：至少按我方兵力的 0.8 算
  const stale = view.tick - lastEnemyBaseLook > 400
  const estB = estimateEnemy(army.length, stale)
  const known0 = enemyMilCounts()
  const nKnown = known0.spearman + known0.cavalry + known0.archer
  const simAll = simFight(A, estB)

  if (mode === "defend") {
    const kills = recentKills(view.tick, 400)
    const big = army.length >= 12 && simAll >= 0.45 * vA
    const counter = army.length >= 9 && kills >= 6 && simAll >= 0.3 * vA
    const huge = army.length >= 28 && simAll >= 0.15 * vA
    const capped = army.length >= 36
    const myScore = view.players[ME].score
    let theirScore = 0
    for (const p of view.players) if (p.id !== ME && p.score > theirScore) theirScore = p.score
    const late = view.tick >= 6500 && army.length >= 10 && myScore <= theirScore && simAll >= -0.1 * vA
    if (view.tick >= retreatUntil && (big || counter || huge || capped || late) && threatHome === 0) {
      mode = "attack"
      attackGroup.clear()
      for (const a of army) attackGroup.add(a.id)
      attackStartSize = army.length
      let cx = 0, cy = 0
      for (const a of army) { cx += a.x; cy += a.y }
      cx /= army.length; cy /= army.length
      let bi = 0, bd = 1e9
      for (let i = 0; i < pathToEnemy.length; i++) { const d = md(pathToEnemy[i], { x: cx, y: cy }); if (d < bd) { bd = d; bi = i } }
      wp = bi
      wpMovedAt = view.tick
      console.log(`t${view.tick} ATTACK army=${A.join("/")} est=${estB.join("/")} sim=${Math.round(simAll)} known=${nKnown} stale=${stale} kills=${kills}`)
    }
  } else {
    if (threatHome > 0) {
      const nearEnemyBase = army.filter((a) => dist(a, eBaseRect) <= 12).length
      if (nearEnemyBase < army.length / 2) {
        mode = "defend"
        console.log(`t${view.tick} back to defend (home threat ${threatHome})`)
      }
    }
    const grp = army.filter((a) => attackGroup.has(a.id))
    if (grp.length < Math.max(4, attackStartSize * 0.35)) {
      mode = "defend"; retreatUntil = view.tick + 300; retreatMoveUntil = view.tick + 40
      console.log(`t${view.tick} attack group shrank to ${grp.length}, retreat`)
    }
  }

  const relevant = enemies.filter((e) => T[e.type].kind !== "resource")
  // 局部兵力：队伍中心 12 格内的双方兵和箭塔
  const localSim = (grp: Entity[]): { v: number; my: number; en: number; towers: number } => {
    let cx = 0, cy = 0
    for (const a of grp) { cx += a.x; cy += a.y }
    cx /= Math.max(1, grp.length); cy /= Math.max(1, grp.length)
    const c = { x: cx, y: cy }
    const enT: TypeName[] = []
    let towers = 0
    for (const e of relevant) {
      if (md(e, c) > 12) continue
      if (isMil(e.type)) enT.push(e.type)
      else if (e.type === "tower" && !e.construction) towers++
    }
    const mine = grp.filter((a) => md(a, c) <= 12).map((a) => a.type)
    return { v: simFight(counts(mine), counts(enT), towers), my: mine.length, en: enT.length, towers }
  }
  // 已经接战（5 格内有敌兵）就别退：慢的兵转身跑只会被弓兵白打
  const inContact = (us: Entity[]): boolean => {
    for (const a of us) for (const e of relevant) if (isMil(e.type) && dist(a, e) <= 5) return true
    return false
  }
  if (mode === "attack") {
    const grp = army.filter((a) => attackGroup.has(a.id))
    const ls = localSim(grp)
    const v = armyValue(counts(grp.map((a) => a.type)))
    const contact = inContact(grp)
    if ((ls.en >= 3 || ls.towers >= 2) && ((!contact && ls.v < -0.1 * v) || ls.v < -0.7 * v)) {
      mode = "defend"
      retreatUntil = view.tick + 300
      retreatMoveUntil = view.tick + (contact ? 25 : 40)
      console.log(`t${view.tick} RETREAT local my=${ls.my} en=${ls.en} towers=${ls.towers} sim=${Math.round(ls.v)} contact=${contact}`)
    }
  } else if (rally !== homeRally && view.tick >= retreatMoveUntil) {
    // 前出的集结点：大批敌军过来、还没接战、打不过就退回家门口
    const near = army.filter((a) => md(a, rally) <= 10)
    if (near.length > 0 && !inContact(near)) {
      const ls = localSim(near)
      if (ls.en >= 4 && ls.v < 0) {
        rallyFallbackUntil = view.tick + 400
        rally = homeRally
        retreatMoveUntil = view.tick + 30
        console.log(`t${view.tick} forward rally unsafe (my=${ls.my} en=${ls.en} sim=${Math.round(ls.v)}), fall back`)
      }
    }
  }

  // 回家路上先跑，不打
  if (mode === "defend" && view.tick < retreatMoveUntil) {
    for (const u of army) if (!(u.order?.kind === "move" && u.order.x === rally.x && u.order.y === rally.y)) cmd.move(u, rally.x, rally.y)
    return
  }

  const myBlds = my.filter((e) => T[e.type].kind === "building")
  const homeish = (e: Entity): boolean => {
    if (md(e, rally) <= 16 || md(e, baseC) <= 20) return true
    for (const b of myBlds) if (dist(e, b) <= 10) return true
    return false
  }
  const incoming = new Map<number, number>()
  const meleeOn = new Map<number, number>()
  const engaged = new Set<number>()
  const fightSpots: Pos[] = []
  for (const u of army) {
    const at = T[u.type].attack!
    const inGroup = mode === "attack" && attackGroup.has(u.id)
    const reach = inGroup ? 9 : 8
    let best: Entity | null = null
    let bs = -1
    for (const e of relevant) {
      const d = dist(u, e)
      if (d > reach) continue
      if (!inGroup && d > at.range) {
        // 守家：不去拆远处的建筑，不追出家太远（近处的一定还手）
        if (T[e.type].kind === "building") continue
        if (d > 4 && !homeish(e)) continue
      }
      let s = targetScore(u, e, incoming)
      // 近战围一个目标最多 4 个人，已经有 3 个在打就换一个
      if (at.range <= 1 && d > 1 && (meleeOn.get(e.id) ?? 0) >= 3) s *= 0.4
      if (s > bs) { bs = s; best = e }
    }
    if (best) {
      engaged.add(u.id)
      if (dist(u, best) <= at.range + 2) incoming.set(best.id, (incoming.get(best.id) ?? 0) + dmgVs(u.type, best.type))
      if (at.range <= 1) meleeOn.set(best.id, (meleeOn.get(best.id) ?? 0) + 1)
      if (isMil(best.type) || best.type === "tower") fightSpots.push({ x: best.x, y: best.y })
      if (!(u.order?.kind === "attack" && u.order.target === best.id)) cmd.attack(u, best)
    }
  }
  // 没接上敌的兵：附近有人在打就过去帮忙
  const nearestFight = (u: Entity, r: number): Pos | null => {
    let bp: Pos | null = null
    let bd = r + 1
    for (const p of fightSpots) { const d = md(u, p); if (d < bd) { bd = d; bp = p } }
    return bp
  }

  // 威胁位置
  let threatPos: Pos | null = null
  if (threatHome > 0) {
    let td = 1e9
    for (const e of enemies) {
      if (!isMil(e.type)) continue
      const d = md(e, baseC)
      if (d < td) { td = d; threatPos = { x: e.x, y: e.y } }
    }
  }

  if (mode === "attack") {
    const grp = army.filter((a) => attackGroup.has(a.id))
    // 新兵：在集结点凑够 3 个再去追大部队
    const fresh = army.filter((a) => !attackGroup.has(a.id))
    let gx = 0, gy = 0
    for (const a of grp) { gx += a.x; gy += a.y }
    gx = Math.round(gx / Math.max(1, grp.length)); gy = Math.round(gy / Math.max(1, grp.length))
    for (const f of fresh) if (md(f, { x: gx, y: gy }) <= 8) attackGroup.add(f.id)
    const atRally = fresh.filter((f) => md(f, rally) <= 5)
    const sendFresh = atRally.length >= 3
    // 路点前进：七成的兵到了路点附近就往前挪
    const goal = pathToEnemy[Math.min(wp, pathToEnemy.length - 1)]
    const near = grp.filter((a) => md(a, goal) <= 5).length
    if (wp < pathToEnemy.length - 1 && (near >= grp.length * 0.7 || (view.tick - wpMovedAt > 80 && near >= grp.length * 0.4))) {
      wp = Math.min(pathToEnemy.length - 1, wp + 4)
      wpMovedAt = view.tick
    }
    const atEnd = wp >= pathToEnemy.length - 1
    const tgt = atEnd ? eBaseC : goal
    for (const u of army) {
      if (engaged.has(u.id)) continue
      const nf = nearestFight(u, 12)
      if (nf && (attackGroup.has(u.id) || md(u, rally) <= 6)) {
        if (!(u.order?.kind === "attackMove" && md(u.order, nf) <= 2)) cmd.attackMove(u, nf.x, nf.y)
        continue
      }
      if (attackGroup.has(u.id)) {
        if (!(u.order?.kind === "attackMove" && u.order.x === tgt.x && u.order.y === tgt.y)) cmd.attackMove(u, tgt.x, tgt.y)
      } else if (sendFresh && md(u, rally) <= 5) {
        if (!(u.order?.kind === "attackMove" && u.order.x === gx && u.order.y === gy)) cmd.attackMove(u, gx, gy)
      } else if (!(u.order?.kind === "attackMove" && md(u.order, { x: gx, y: gy }) <= 3)) {
        if (md(u, rally) > 3 && !(u.order?.kind === "attackMove" && u.order.x === rally.x && u.order.y === rally.y)) cmd.attackMove(u, rally.x, rally.y)
      }
    }
    return
  }

  const goal = threatPos ?? rally
  for (const u of army) {
    if (engaged.has(u.id)) continue
    const nf = nearestFight(u, 14)
    if (nf) {
      if (!(u.order?.kind === "attackMove" && md(u.order, nf) <= 2)) cmd.attackMove(u, nf.x, nf.y)
      continue
    }
    if (threatPos) {
      if (!(u.order?.kind === "attackMove" && md(u.order, goal) <= 2)) cmd.attackMove(u, goal.x, goal.y)
    } else if (md(u, goal) > 3) {
      if (!((u.order?.kind === "attackMove" || u.order?.kind === "move") && u.order.x === goal.x && u.order.y === goal.y)) cmd.attackMove(u, goal.x, goal.y)
    }
  }
}

export function onTick(view: View, cmd: Commands): void {
  onTickImpl(view, cmd)
  if (view.tick % 500 === 0) {
    const e = enemyMilCounts()
    console.log(`t${view.tick} gold=${view.resources.gold} mode=${mode} enemy sp${e.spearman} cav${e.cavalry} arc${e.archer} lastLook=${lastEnemyBaseLook}`)
  }
}
