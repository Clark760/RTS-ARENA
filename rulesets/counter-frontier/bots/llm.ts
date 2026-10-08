// 大模型试写（最强）：仓库贴着分矿放（工人不用走路就能交货）、两座兵营，看兵出兵、每个兵按克制自己挑目标，守家反击。
// 外部大模型试写的 bot（2026-10-08，D-167）：子代理只读了 PROMPT.md、看不到平台源码和参考 bot 的源码，写了 6 版，
// 当时对 baseline、counter、expand、rush、turtle 各打 20 局全胜。原样收录作为更强的陪练。
// 写它的时候还没有侦察兵，它派一个工人去侦察，侦察兵一直留在家里。
const TT = game.types
const B2_TICK = 450
const TOWER1 = false
const ATTACK_R = 1.5
const ATTACK_MIN = 16
const SYM_K = 1.1
const RETREAT_R = 1.0
const LATE_DEPOT_GOLD = 700
const W = game.width
const H = game.height
const idx = (x: number, y: number): number => y * W + x

function gcost(t: TypeName): number { return TT[t].cost.gold ?? 0 }
function isMil(t: TypeName): boolean { return t === "spearman" || t === "cavalry" || t === "archer" }
function isBld(t: TypeName): boolean { return TT[t].kind === "building" }
function dmgVs(att: TypeName, def: TypeName): number {
  const a = TT[att].attack
  if (!a) return 0
  const v = a.vs as Record<string, number> | undefined
  const m = v && v[def] ? v[def] : 1
  return Math.round(a.damage * m)
}
function walk(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= W || y >= H) return false
  return game.walkable[game.terrain[y][x]] === true
}
function cen(e: { x: number; y: number; w: number; h: number }): Pos {
  return { x: e.x + Math.floor(e.w / 2), y: e.y + Math.floor(e.h / 2) }
}
function md(a: Pos, b: Pos): number { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) }

// ---------------- state ----------------
let ME = -1
let FLIP = false
let MYTEAM = -1
let started = false
let baseId = -1
let baseC: Pos = { x: 0, y: 0 }
let eBaseC: Pos = { x: 0, y: 0 }
let dHome: number[] = []
let dEnemy: number[] = []
let reserved: boolean[] = []
let rally: Pos = { x: 0, y: 0 }
let scoutPoint: Pos = { x: 0, y: 0 }

interface Cluster { ids: number[]; cx: number; cy: number; dh: number; de: number; perp: number }
let clusters: Cluster[] = []
let expansions: Cluster[] = []

interface Seen { id: number; type: TypeName; x: number; y: number; t: number; hp: number }
const eUnits = new Map<number, Seen>()
const eBlds = new Map<number, Seen>()

interface BuildTask { type: TypeName; near: Pos; builder: number; x: number; y: number; placed: boolean; bid: number; done: boolean; tag: string; range: number; helpers: number; placedTick: number; mineIds?: number[] }
const tasks: BuildTask[] = []
const taskTags = new Set<string>()

let mode: "home" | "attack" = "home"
let modeSince = 0
let lastRetreat = -9999
let myMilLost = 0
const clusterEnemySeen = new Map<string, number>()
function lastEnemyNear(c: Cluster): number { return clusterEnemySeen.get(c.cx + "," + c.cy) ?? -9999 }
let enemyMilKilled = 0
let lastStatus = -1000
let scoutId = -1
let scoutsSent = 0
let scoutState = "go"
let scoutWait = 0
let lastScoutLost = -9999
const fleeUntil = new Map<number, number>()
let caps = new Map<number, number>()
let capsTick = -1000

// ---------------- strength model ----------------
function hpOf(t: TypeName): number { return TT[t].maxHp }
function cdOf(t: TypeName): number { const a = TT[t].attack; return a ? a.cooldown : 1 }
// Lanchester square law: power(A vs B) = alpha * |A|^2
function power(A: Record<string, number>, B: Record<string, number>): number {
  let na = 0, nb = 0
  for (const k in A) na += A[k]
  for (const k in B) nb += B[k]
  if (na === 0) return 0
  if (nb === 0) return 1e9
  let s = 0
  for (const ta in A) {
    if (!A[ta]) continue
    for (const tb in B) {
      if (!B[tb]) continue
      s += A[ta] * B[tb] * dmgVs(ta as TypeName, tb as TypeName) / (cdOf(ta as TypeName) * hpOf(tb as TypeName))
    }
  }
  const alpha = s / (na * nb)
  return alpha * na * na
}
function ratio(A: Record<string, number>, B: Record<string, number>): number {
  const pa = power(A, B), pb = power(B, A)
  if (pb <= 0) return 99
  return pa / pb
}
function countTypes(list: { type: TypeName }[]): Record<string, number> {
  const r: Record<string, number> = {}
  for (const e of list) r[e.type] = (r[e.type] || 0) + 1
  return r
}
function total(c: Record<string, number>): number { let n = 0; for (const k in c) n += c[k]; return n }

// ---------------- init ----------------
const towardCache = new Map<number, Pos>()
// a point d steps from my base along a central shortest path toward the enemy (fromEnemy: measured from enemy base)
function towardE(d: number, fromEnemy: boolean): Pos {
  const key = fromEnemy ? -d - 1 : d
  const c = towardCache.get(key)
  if (c) return c
  let best = -1, bv = 1e9
  const vx = eBaseC.x - baseC.x, vy = eBaseC.y - baseC.y
  const len = Math.sqrt(vx * vx + vy * vy)
  for (let k = 0; k < W * H; k++) {
    const i = FLIP ? W * H - 1 - k : k
    const a = fromEnemy ? dEnemy[i] : dHome[i], b = fromEnemy ? dHome[i] : dEnemy[i]
    if (a < 0 || b < 0) continue
    const x = i % W, y = Math.floor(i / W)
    const off = Math.abs((x - baseC.x) * vy - (y - baseC.y) * vx) / len
    const v = Math.abs(a - d) * 3 + b + off * 1.5 + (!fromEnemy && reserved[i] ? 6 : 0)
    if (v < bv) { bv = v; best = i }
  }
  const r = { x: best % W, y: Math.floor(best / W) }
  towardCache.set(key, r)
  return r
}

function init(view: View): void {
  ME = view.me
  MYTEAM = view.players[ME].team
  const base = view.entities.find((e) => e.owner === ME && e.type === "base")!
  baseId = base.id
  baseC = cen(base)
  FLIP = baseC.x * 2 > W
  const eb = view.objectives.enemyBases.find((b) => b.owner !== ME)!
  eBaseC = { x: eb.x + 1, y: eb.y + 1 }
  dHome = pathDistances(view, base)
  dEnemy = pathDistances(view, { x: eBaseC.x, y: eBaseC.y })
  const vx = eBaseC.x - baseC.x, vy = eBaseC.y - baseC.y
  const len = Math.sqrt(vx * vx + vy * vy)
  // clusters of mines
  const mines = view.entities.filter((e) => e.type === "goldmine")
  const used = new Set<number>()
  for (const m of mines) {
    if (used.has(m.id)) continue
    const group = [m]
    used.add(m.id)
    for (let i = 0; i < group.length; i++) {
      for (const o of mines) {
        if (!used.has(o.id) && dist(group[i], o) <= 4) { used.add(o.id); group.push(o) }
      }
    }
    let sx = 0, sy = 0
    for (const g of group) { sx += g.x; sy += g.y }
    const cx = Math.round(sx / group.length), cy = Math.round(sy / group.length)
    let dh = 1e9, de = 1e9
    for (const g of group) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = g.x + dx, y = g.y + dy
        if (!walk(x, y)) continue
        const a = dHome[idx(x, y)], b = dEnemy[idx(x, y)]
        if (a >= 0 && a < dh) dh = a
        if (b >= 0 && b < de) de = b
      }
    }
    const perp = Math.abs((cx - baseC.x) * vy - (cy - baseC.y) * vx) / len
    clusters.push({ ids: group.map((g) => g.id), cx, cy, dh, de, perp })
  }
  clusters.sort((a, b) => a.dh - b.dh)
  // reserved corridors between home mines and base
  reserved = new Array(W * H).fill(false)
  for (const m of mines) {
    if (dist(m, base) > 8) continue
    const pm = pathDistances(view, m)
    let L = 1e9
    for (let i = 0; i < W * H; i++) if (pm[i] > 0 && dHome[i] > 0) L = Math.min(L, pm[i] + dHome[i])
    for (let i = 0; i < W * H; i++) if (pm[i] > 0 && dHome[i] > 0 && pm[i] + dHome[i] <= L + 1) reserved[i] = true
  }
  rally = towardE(9, false)
  scoutPoint = towardE(9, true)
  expansions = clusters.filter((c) => c.dh > 10 && c.dh < c.de).sort((a, b) => (a.dh - a.perp) - (b.dh - b.perp))
  console.log(`init me=${ME} base=${baseC.x},${baseC.y} enemy=${eBaseC.x},${eBaseC.y} rally=${rally.x},${rally.y} scout=${scoutPoint.x},${scoutPoint.y} exp=${expansions.map((c) => `${c.cx},${c.cy}:${c.dh}/${c.de}/${c.perp.toFixed(0)}`).join(" ")}`)
}

const escortCache = new Map<string, Pos>()
function escortPoint(c: Pos): Pos {
  const key = c.x + "," + c.y
  const k = escortCache.get(key)
  if (k) return k
  let best: Pos = c, bv = 1e9
  for (let y = c.y - 4; y <= c.y + 4; y++) for (let x = c.x - 4; x <= c.x + 4; x++) {
    if (!walk(x, y)) continue
    const i = idx(x, y)
    if (dHome[i] < 0 || dEnemy[i] < 0) continue
    const m = Math.abs(x - c.x) + Math.abs(y - c.y)
    if (m > 4) continue
    const v = dEnemy[i] + 3 * Math.abs(m - 3)
    if (v < bv) { bv = v; best = { x, y } }
  }
  escortCache.set(key, best)
  return best
}

// ---------------- build spot ----------------
function findSpot(view: View, type: TypeName, near: Pos, maxR: number, margin: number): Pos | null {
  const w = TT[type].w, h = TT[type].h
  const blocked = new Array(W * H).fill(false)
  for (const e of view.entities) {
    if (!(isBld(e.type) || e.type === "goldmine")) continue
    for (let y = e.y - margin; y < e.y + e.h + margin; y++)
      for (let x = e.x - margin; x < e.x + e.w + margin; x++)
        if (x >= 0 && y >= 0 && x < W && y < H) blocked[idx(x, y)] = true
  }
  for (let r = 0; r <= maxR; r++) {
    for (let dx = -r; dx <= r; dx++) {
      const rest = r - Math.abs(dx)
      const dys = rest === 0 ? [0] : [-rest, rest]
      for (const dy of dys) {
        // mirror the search for the bottom-right seat so both seats place buildings the same way
        const x0 = FLIP ? near.x - dx - (w - 1) : near.x + dx, y0 = FLIP ? near.y - dy - (h - 1) : near.y + dy
        let ok = true
        for (let y = y0; y < y0 + h && ok; y++)
          for (let x = x0; x < x0 + w && ok; x++) {
            if (!walk(x, y) || blocked[idx(x, y)] || reserved[idx(x, y)]) ok = false
          }
        if (!ok) continue
        if (canBuild(view, type, x0, y0)) return { x: x0, y: y0 }
      }
    }
  }
  return null
}

// occupancy: terrain walls, buildings, mines (units ignored)
function occGrid(view: View): boolean[] {
  const occ = new Array(W * H).fill(false)
  for (let i = 0; i < W * H; i++) if (!walk(i % W, Math.floor(i / W))) occ[i] = true
  for (const e of view.entities) {
    if (!(isBld(e.type) || e.type === "goldmine")) continue
    for (let y = e.y; y < e.y + e.h; y++) for (let x = e.x; x < e.x + e.w; x++) occ[idx(x, y)] = true
  }
  return occ
}
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
// best place for a depot next to these mines: most mining cells adjacent to the depot, every mine keeps free cells
function depotSpot(view: View, mines: Entity[]): { x: number; y: number; ok: boolean } | null {
  if (mines.length === 0) return null
  const occ = occGrid(view)
  // no building within 1 of other buildings (keep paths)
  const nearBld = new Array(W * H).fill(false)
  for (const e of view.entities) {
    if (!isBld(e.type)) continue
    for (let y = e.y - 1; y < e.y + e.h + 1; y++) for (let x = e.x - 1; x < e.x + e.w + 1; x++) if (x >= 0 && y >= 0 && x < W && y < H) nearBld[idx(x, y)] = true
  }
  let minx = 1e9, maxx = -1, miny = 1e9, maxy = -1
  for (const m of mines) { minx = Math.min(minx, m.x); maxx = Math.max(maxx, m.x); miny = Math.min(miny, m.y); maxy = Math.max(maxy, m.y) }
  const cands: { x: number; y: number; s: number }[] = []
  for (let y0 = miny - 3; y0 <= maxy + 2; y0++) {
    for (let x0 = minx - 3; x0 <= maxx + 2; x0++) {
      let ok = true
      for (let y = y0; y < y0 + 2 && ok; y++) for (let x = x0; x < x0 + 2 && ok; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H || occ[idx(x, y)] || nearBld[idx(x, y)]) ok = false
      }
      if (!ok) continue
      const rect = { x: x0, y: y0, w: 2, h: 2 }
      let s = 0
      for (const m of mines) {
        let free = 0, best = 99
        for (const [dx, dy] of DIRS) {
          const x = m.x + dx, y = m.y + dy
          if (x < 0 || y < 0 || x >= W || y >= H || occ[idx(x, y)]) continue
          if (x >= x0 && x < x0 + 2 && y >= y0 && y < y0 + 2) continue
          free++
          const d = dist({ x, y }, rect)
          if (d < best) best = d
          if (d === 1) s -= 3
        }
        if (free < 2) { ok = false; break }
        s += best * 10 * ((m.amount ?? 400) / 500)
        s -= free
      }
      if (!ok) continue
      cands.push({ x: x0, y: y0, s })
    }
  }
  cands.sort((a, b) => a.s - b.s || (FLIP ? (b.y - a.y) || (b.x - a.x) : (a.y - b.y) || (a.x - b.x)))
  for (let i = 0; i < cands.length && i < 12; i++) {
    const c = cands[i]
    if (canBuild(view, "depot", c.x, c.y)) return { x: c.x, y: c.y, ok: true }
    // not visible yet: walk there first
    let vis = true
    for (let y = c.y; y < c.y + 2 && vis; y++) for (let x = c.x; x < c.x + 2 && vis; x++) if (!visibleCell(view, x, y)) vis = false
    if (!vis) return { x: c.x, y: c.y, ok: false }
  }
  return null
}
function visibleCell(view: View, x: number, y: number): boolean {
  for (const e of view.entities) {
    if (e.owner !== ME) continue
    const s = e.stats?.sight ?? TT[e.type].sight
    if (dist(e, { x, y }) <= s) return true
  }
  return false
}
// mining capacity per mine: free adjacent cells (shared cells count half)
function mineCaps(view: View, mines: Entity[]): Map<number, number> {
  const occ = occGrid(view)
  const owners = new Map<number, number>()
  for (const m of mines) for (const [dx, dy] of DIRS) {
    const x = m.x + dx, y = m.y + dy
    if (x < 0 || y < 0 || x >= W || y >= H || occ[idx(x, y)]) continue
    owners.set(idx(x, y), (owners.get(idx(x, y)) || 0) + 1)
  }
  const caps = new Map<number, number>()
  for (const m of mines) {
    let c = 0
    for (const [dx, dy] of DIRS) {
      const x = m.x + dx, y = m.y + dy
      if (x < 0 || y < 0 || x >= W || y >= H || occ[idx(x, y)]) continue
      c += 1 / (owners.get(idx(x, y)) || 1)
    }
    caps.set(m.id, c)
  }
  return caps
}

// ---------------- main ----------------
export function onTick(view: View, cmd: Commands): void {
  if (!started) { init(view); started = true }
  const tick = view.tick
  let gold = view.resources.gold
  const mine: Entity[] = []
  const enemies: Entity[] = []
  const goldmines: Entity[] = []
  for (const e of view.entities) {
    if (e.type === "goldmine") { if ((e.amount ?? 0) > 0) goldmines.push(e); continue }
    if (e.owner === ME) mine.push(e)
    else if (e.owner >= 0 && view.players[e.owner].team !== MYTEAM) enemies.push(e)
  }
  // memory of enemies
  for (const e of enemies) {
    const s: Seen = { id: e.id, type: e.type, x: e.x, y: e.y, t: tick, hp: e.hp }
    if (isBld(e.type)) eBlds.set(e.id, s)
    else eUnits.set(e.id, s)
  }
  let scoutHit = false
  for (const ev of view.events) {
    if (ev.kind === "died") {
      eUnits.delete(ev.id); eBlds.delete(ev.id)
      if (isMil(ev.type) && !ev.removed) {
        if (ev.owner === ME) myMilLost += gcost(ev.type)
        else if (ev.owner >= 0 && view.players[ev.owner].team !== MYTEAM) enemyMilKilled += gcost(ev.type)
      }
    }
    else if (ev.kind === "rejected") console.log(`rejected ${JSON.stringify(ev.command)} ${ev.reason}`)
    else if (ev.kind === "botError") console.log(`botError ${ev.message}`)
    else if (ev.kind === "damaged" && ev.id === scoutId) scoutHit = true
  }
  for (const [id, s] of eUnits) if (tick - s.t > 2500) eUnits.delete(id)

  const base0 = mine.find((e) => e.id === baseId)
  if (!base0) return
  const base: Entity = base0
  const workers = mine.filter((e) => e.type === "worker")
  const army = mine.filter((e) => isMil(e.type))
  const barracks = mine.filter((e) => e.type === "barracks")
  const depots = mine.filter((e) => e.type === "depot")
  const doneBarracks = barracks.filter((b) => !b.construction)
  const dropoffs = mine.filter((e) => TT[e.type].dropOff && !e.construction)
  let unitCount = mine.filter((e) => TT[e.type].kind === "unit").length +
    mine.reduce((s, b) => s + (b.queue ? b.queue.length : 0), 0)
  const enemyMil = enemies.filter((e) => isMil(e.type))

  // enemy army estimate (seen, not known dead)
  const eArmy: Seen[] = []
  for (const s of eUnits.values()) if (isMil(s.type)) eArmy.push(s)
  const eComp = countTypes(eArmy)
  const myComp = countTypes(army)

  // threats: enemy military near my stuff
  const homeThreats: Entity[] = []
  for (const e of enemyMil) {
    const d = dHome[idx(e.x, e.y)]
    if (d >= 0 && d <= 16) { homeThreats.push(e); continue }
    let near = false
    for (const dp of depots) if (dist(dp, e) <= 8) { near = true; break }
    if (!near) for (const w of workers) if (w.id !== scoutId && dist(w, e) <= 6) { near = true; break }
    if (near) homeThreats.push(e)
  }

  // ---------------- scout ----------------
  // peek at the enemy base, back off as soon as enemy soldiers are close, come back later
  let scout = workers.find((w) => w.id === scoutId)
  if (!scout && scoutId >= 0) { scoutId = -1; lastScoutLost = tick }
  if (!scout && scoutsSent < 3 && ((scoutsSent === 0 && tick >= 450) || (scoutsSent > 0 && tick - lastScoutLost >= 600 && total(eComp) < 6))) {
    let best: Entity | null = null, bd = 1e9
    for (const w of workers) {
      if (w.carrying || (w.order && w.order.kind === "build") || tasks.some((t) => !t.done && t.builder === w.id)) continue
      const d = dist(w, scoutPoint)
      if (d < bd) { bd = d; best = w }
    }
    if (best) { scout = best; scoutId = best.id; scoutsSent++; scoutState = "go"; cmd.move(best, scoutPoint.x, scoutPoint.y) }
  }
  if (scout) {
    let danger = false
    for (const e of enemies) {
      if (!isMil(e.type) && e.type !== "tower") continue
      const rng = (TT[e.type].attack?.range ?? 1) + 3
      if (dist(scout, e) <= rng) { danger = true; break }
    }
    if (scout.hp <= 16) {
      if (scoutState !== "home") { scoutState = "home"; cmd.move(scout, baseC.x, baseC.y + 3) }
      if (dist(scout, base) <= 5) { scoutId = -1; lastScoutLost = tick; scout = undefined }
    } else if ((scoutHit || danger) && scoutState === "go") {
      scoutState = "back"; scoutWait = tick + 120
      const bp = towardE(20, true)
      cmd.move(scout, bp.x, bp.y)
    } else if (scoutState === "go" && scout.order && scout.order.kind === "idle" && dist(scout, scoutPoint) > 2) {
      cmd.move(scout, scoutPoint.x, scoutPoint.y)
    } else if (scoutState === "back" && tick >= scoutWait) {
      scoutState = "go"; cmd.move(scout, scoutPoint.x, scoutPoint.y)
    }
  }

  // ---------------- build planning ----------------
  for (const c of clusters) if (enemyMil.some((e) => md(e, { x: c.cx, y: c.cy }) <= 12)) clusterEnemySeen.set(c.cx + "," + c.cy, tick)
  let reserve = 0
  const nWorkers = workers.length
  function addTask(tag: string, type: TypeName, near: Pos, range: number, helpers: number, mineIds?: number[]): void {
    if (taskTags.has(tag)) return
    taskTags.add(tag)
    tasks.push({ type, near, builder: -1, x: -1, y: -1, placed: false, bid: -1, done: false, tag, range, helpers, placedTick: -1, mineIds })
  }
  const homeCl = clusters[0]
  // opening: natural depot first (zero-walk mining), barracks, second barracks, then a depot at the home mine row
  if (expansions[0]) addTask("depot1", "depot", { x: expansions[0].cx, y: expansions[0].cy }, 5, 0, expansions[0].ids)
  addTask("barracks1", "barracks", towardE(5, false), 8, 1)
  if (tick >= B2_TICK && nWorkers >= 9 && doneBarracks.length >= 1) addTask("barracks2", "barracks", towardE(7, false), 8, 0)
  if (tick >= 400 && homeCl && homeCl.ids.length >= 2) addTask("depot0", "depot", { x: homeCl.cx, y: homeCl.cy }, 4, 0, homeCl.ids)
  if (TOWER1 && tick >= 800 && doneBarracks.length >= 1) addTask("tower1", "tower", { x: Math.round((homeCl.cx * 2 + rally.x) / 3), y: Math.round((homeCl.cy * 2 + rally.y) / 3) }, 5, 0)
  if (tick >= 1400 && nWorkers >= 14 && doneBarracks.length >= 2 && view.resources.gold >= 250) addTask("barracks3", "barracks", towardE(9, false), 8, 0)
  // remaining gold in safe mines (home + natural)
  let safeGold = 0
  for (const g of goldmines) {
    if (dist(g, base) <= 8 || (expansions[0] && expansions[0].ids.includes(g.id))) safeGold += g.amount ?? 0
  }
  // when the safe mines run low: depot at the best remaining uncovered cluster (ours first, the enemy's late in the game)
  if (safeGold < LATE_DEPOT_GOLD) {
    let bestC: Cluster | null = null, bs = 1e9
    for (const c of clusters) {
      if (c.dh <= 10) continue
      let rem = 0
      for (const g of goldmines) if (c.ids.includes(g.id)) rem += g.amount ?? 0
      if (rem < 300) continue
      if (taskTags.has("depotX" + c.cx + "," + c.cy) || (expansions[0] && c === expansions[0])) continue
      let covered = false
      for (const d of depots) if (md(cen(d), { x: c.cx, y: c.cy }) <= 6) covered = true
      if (covered) continue
      if (tick - lastEnemyNear(c) <= 300) continue
      if (c.dh >= c.de && tick < 3500) continue
      const s = c.dh - 0.4 * c.de - rem / 200
      if (s < bs) { bs = s; bestC = c }
    }
    const pending = tasks.some((t) => !t.done && t.tag.startsWith("depotX"))
    if (tick % 250 === 0) console.log(`t${tick} safeGold=${safeGold} depotX best=${bestC ? bestC.cx + "," + bestC.cy : "none"} pending=${pending} clusters=${clusters.filter((c) => c.dh > 10).map((c) => `${c.cx},${c.cy}:${c.dh}/${c.de}/seen${tick - lastEnemyNear(c)}`).join(" ")}`)
    if (bestC && !pending) addTask("depotX" + bestC.cx + "," + bestC.cy, "depot", { x: bestC.cx, y: bestC.cy }, 5, 0, bestC.ids)
  }

  const busy = new Set<number>()
  if (scoutId >= 0) busy.add(scoutId)
  let activeUnplaced = 0
  for (const t of tasks) {
    if (t.done) continue
    if (t.placed) {
      if (t.bid < 0) {
        const b0 = mine.find((e) => e.type === t.type && e.x === t.x && e.y === t.y)
        if (b0) t.bid = b0.id
        else if (tick - t.placedTick > 15) { t.placed = false; console.log(`t${tick} ${t.tag} placement lost, retry`) }
      }
      if (t.bid >= 0) {
        const b = mine.find((e) => e.id === t.bid)
        if (!b) { t.placed = false; t.bid = -1 } // destroyed: retry
        else if (!b.construction) { t.done = true; continue }
      }
    }
    if (!t.placed) {
      // depots whose mines are gone are not needed any more
      if (t.mineIds && !goldmines.some((g) => t.mineIds!.includes(g.id))) { t.done = true; continue }
      if (t.tag.startsWith("depotX")) {
        let guards = 0
        for (const u of army) if (md(u, t.near) <= 9) guards++
        const hot = enemyMil.some((e) => md(e, t.near) <= 9)
        if (hot || ((clusterEnemySeen.get(t.near.x + "," + t.near.y) ?? -9999) > tick - 200 && guards < 5)) { t.builder = -1; continue }
      }
      if (activeUnplaced >= 1) { t.builder = -1; continue }
      if (gold < gcost(t.type) - 40) { t.builder = -1; continue }
      activeUnplaced++
      reserve += gcost(t.type)
    }
    let bu = workers.find((w) => w.id === t.builder && w.id !== scoutId)
    if (!bu) {
      let best: Entity | null = null, bd = 1e9
      const target = t.placed ? { x: t.x, y: t.y } : t.near
      for (const w of workers) {
        if (busy.has(w.id)) continue
        if ((fleeUntil.get(w.id) || 0) > tick) continue
        const d = dist(w, target) + (w.carrying ? 3 : 0)
        if (d < bd) { bd = d; best = w }
      }
      if (!best) continue
      bu = best
      t.builder = bu.id
    }
    busy.add(bu.id)
    if (t.placed) {
      if (bu.order?.kind !== "build" || bu.order.target !== t.bid) cmd.build(bu, t.type, t.x, t.y)
      if (t.helpers > 0) {
        const hs = workers.filter((w) => !busy.has(w.id)).sort((a, b) => dist(a, { x: t.x, y: t.y }) - dist(b, { x: t.x, y: t.y })).slice(0, t.helpers)
        for (const hw of hs) { busy.add(hw.id); if (hw.order?.kind !== "build") cmd.build(hw, t.type, t.x, t.y) }
      }
      continue
    }
    if (gold < gcost(t.type)) {
      if (dist(bu, t.near) > 5 && !(bu.order && bu.order.kind === "move" && bu.order.x === t.near.x && bu.order.y === t.near.y)) cmd.move(bu, t.near.x, t.near.y)
      continue
    }
    let spot: Pos | null = null
    if (t.mineIds) {
      const ms = goldmines.filter((g) => t.mineIds!.includes(g.id))
      const ds = depotSpot(view, ms)
      if (ds && !ds.ok) {
        if (!(bu.order && bu.order.kind === "move" && bu.order.x === ds.x && bu.order.y === ds.y)) cmd.move(bu, ds.x, ds.y)
        continue
      }
      spot = ds
    } else spot = findSpot(view, t.type, t.near, t.range, 1)
    if (spot) {
      cmd.build(bu, t.type, spot.x, spot.y)
      t.x = spot.x; t.y = spot.y; t.placed = true; t.bid = -1; t.placedTick = tick
      gold -= gcost(t.type)
      reserve -= gcost(t.type)
      console.log(`t${tick} place ${t.tag} at ${spot.x},${spot.y}`)
      if (t.helpers > 0) {
        const hs = workers.filter((w) => !busy.has(w.id)).sort((a, b) => dist(a, spot!) - dist(b, spot!)).slice(0, t.helpers)
        for (const hw of hs) { busy.add(hw.id); cmd.build(hw, t.type, spot.x, spot.y) }
      }
    } else if (dist(bu, t.near) > 2) {
      if (!(bu.order && bu.order.kind === "move" && bu.order.x === t.near.x && bu.order.y === t.near.y)) cmd.move(bu, t.near.x, t.near.y)
    } else if (tick % 100 === 0) console.log(`no spot for ${t.tag} near ${t.near.x},${t.near.y}`)
  }

  // ---------------- worker safety ----------------
  for (const w of workers) {
    if (w.id === scoutId) continue
    let nd = 0
    let tx = 0, ty = 0
    for (const e of enemyMil) if (dist(w, e) <= 5) { nd++; tx += e.x; ty += e.y }
    if (nd === 0) continue
    let friends = 0
    for (const u of army) if (dist(u, w) <= 6) friends++
    if (friends >= nd) continue
    const tp = { x: tx / nd, y: ty / nd }
    let best: Entity = base, bv = -1e9
    for (const d of dropoffs) {
      const v = md(cen(d), tp) - 0.3 * dist(w, d)
      if (v > bv) { bv = v; best = d }
    }
    const c = cen(best)
    fleeUntil.set(w.id, tick + 40)
    busy.add(w.id)
    if (!(w.order && w.order.kind === "move" && w.order.x === c.x && w.order.y === c.y)) cmd.move(w, c.x, c.y)
  }

  // ---------------- mining ----------------
  if (tick - capsTick >= 100 || caps.size === 0) { caps = mineCaps(view, goldmines); capsTick = tick }
  const assigned = new Map<number, number>()
  for (const w of workers) if (w.order?.kind === "gather") assigned.set(w.order.target, (assigned.get(w.order.target) || 0) + 1)
  const mineInfo = goldmines.map((m) => {
    let dd = 1e9
    for (const d of dropoffs) dd = Math.min(dd, dist(m, d))
    let danger = false
    for (const e of enemyMil) if (dist(m, e) <= 6) { danger = true; break }
    const cap = Math.max(1, Math.round((caps.get(m.id) ?? 3) * (dd <= 2 ? 1.2 : 1.5)))
    return { m, dd, danger, cap }
  }).filter((x) => x.dd <= 10)
  const mineScore = (w: Entity, mi: { m: Entity; dd: number; cap: number }, a: number): number => {
    const over = a >= mi.cap ? 20 + (a - mi.cap) * 10 : 0
    return mi.dd * 2 + a * 1.5 + over + dist(w, mi.m) * 0.15
  }
  for (const w of workers) {
    if (busy.has(w.id)) continue
    if ((fleeUntil.get(w.id) || 0) > tick) continue
    const o = w.order
    let need = !o || o.kind === "idle" || o.kind === "move"
    if (o && o.kind === "gather" && !goldmines.some((g) => g.id === o.target)) need = true
    if (!need) continue
    let best: Entity | null = null, bs = 1e9
    for (const mi of mineInfo) {
      if (mi.danger) continue
      const s = mineScore(w, mi, assigned.get(mi.m.id) || 0)
      if (s < bs) { bs = s; best = mi.m }
    }
    if (best) {
      cmd.gather(w, best)
      assigned.set(best.id, (assigned.get(best.id) || 0) + 1)
    } else if (o && o.kind !== "idle" && o.kind !== "move") cmd.stop(w)
  }
  // rebalance: move a worker from an over-capacity mine to a better free one
  if (tick % 25 === 0) {
    for (const mi of mineInfo) {
      let a = assigned.get(mi.m.id) || 0
      if (a <= mi.cap) continue
      for (const w of workers) {
        if (a <= mi.cap) break
        if (w.order?.kind !== "gather" || w.order.target !== mi.m.id || w.carrying) continue
        let tgt: { m: Entity; dd: number; cap: number } | null = null, ts = 1e9
        for (const x of mineInfo) {
          if (x.danger || x === mi) continue
          const ax = assigned.get(x.m.id) || 0
          if (ax >= x.cap) continue
          const s = mineScore(w, x, ax)
          if (s < ts) { ts = s; tgt = x }
        }
        if (!tgt) break
        cmd.gather(w, tgt.m)
        assigned.set(tgt.m.id, (assigned.get(tgt.m.id) || 0) + 1)
        a--
        assigned.set(mi.m.id, a)
      }
    }
  }
  let mineSlots = 0
  for (const mi of mineInfo) if (!mi.danger) mineSlots += mi.cap
  // count depots under construction as future slots
  for (const t of tasks) if (t.type === "depot" && t.placed && !t.done && t.mineIds) mineSlots += 6
  const workerTarget = Math.min(depots.length >= 3 ? 24 : 20, Math.max(8, mineSlots + 1))

  // ---------------- production ----------------
  const threatN = homeThreats.length
  const queuedMil = (): number => { let n = 0; for (const b of barracks) if (b.queue) n += b.queue.length; return n }
  const minArmy = tick < 350 ? 0 : Math.floor((tick - 350) / 75)
  const armyFirst = army.length + queuedMil() < minArmy || threatN > 0
  const avail = (): number => gold - reserve
  const wantWorker = nWorkers < workerTarget && unitCount < game.unitCap && !(threatN > army.length)

  function chooseType(): TypeName {
    const es = eComp.spearman || 0, ec = eComp.cavalry || 0, ea = eComp.archer || 0
    const tot = es + ec + ea
    let fS = 0.45, fA = 0.35, fC = 0.2
    if (tot >= 2) {
      const cS = ec / tot, cA = es / tot, cC = ea / tot
      const k = Math.min(0.8, 0.4 + tot * 0.05)
      fS = k * cS + (1 - k) * 0.4; fA = k * cA + (1 - k) * 0.35; fC = k * cC + (1 - k) * 0.25
    }
    const n = army.length + queuedMil() + 1
    const cnt = (t: TypeName): number => (myComp[t] || 0) + queuedType(t)
    const def: [TypeName, number][] = [["spearman", fS * n - cnt("spearman")], ["archer", fA * n - cnt("archer")], ["cavalry", fC * n - cnt("cavalry")]]
    def.sort((a, b) => b[1] - a[1])
    return def[0][0]
  }
  function queuedType(t: TypeName): number {
    let n = 0
    for (const b of barracks) if (b.queue) for (const q of b.queue) if (q.type === t) n++
    return n
  }
  function produceWorker(): void {
    if (!wantWorker) return
    if (base.queue && base.queue.length > 0) return
    if (avail() < 50) return
    cmd.produce(base, "worker"); gold -= 50; unitCount++
  }
  function produceArmy(): void {
    for (const b of doneBarracks) {
      const ql = b.queue ? b.queue.length : 0
      if (ql >= 1) continue
      if (unitCount >= game.unitCap) break
      const t = chooseType()
      if (avail() >= gcost(t)) {
        cmd.produce(b, t); gold -= gcost(t); unitCount++
        myComp[t] = (myComp[t] || 0) + 1
      }
    }
  }
  if (armyFirst) { produceArmy(); produceWorker() } else { produceWorker(); produceArmy() }

  // ---------------- army ----------------
  const focus = new Map<number, number>()
  const engaged = new Set<number>()
  function valueOf(e: Entity): number {
    if (isMil(e.type)) return gcost(e.type)
    if (e.type === "worker") return 25
    if (e.type === "base") return mode === "attack" ? 900 : 100
    if (e.type === "tower") return 200
    if (e.type === "barracks") return 150
    return 80
  }
  function pickTarget(u: Entity): Entity | null {
    const a = TT[u.type].attack!
    let best: Entity | null = null, bs = -1
    const cur = u.order && u.order.kind === "attack" ? u.order.target : -1
    for (const e of enemies) {
      const d = dist(u, e)
      if (d > 10) continue
      if (mode === "home") {
        const dh = dHome[idx(e.x, e.y)]
        if (dh > 24 && d > a.range) continue
      }
      const dm = dmgVs(u.type, e.type)
      if (dm <= 0) continue
      const hits = Math.max(1, Math.ceil(e.hp / dm))
      const steps = Math.max(0, d - a.range)
      let s = valueOf(e) / hits / (1 + steps * TT[u.type].moveTicks / 12)
      const f = focus.get(e.id) || 0
      if (f > 0 && f < hits) s *= 1.15
      if (e.id === cur) s *= 1.25
      if (s > bs) { bs = s; best = e }
    }
    return best
  }
  for (const u of army) {
    let near = false
    for (const e of enemies) if (dist(u, e) <= 9) { near = true; break }
    if (!near) continue
    const t = pickTarget(u)
    if (!t) continue
    engaged.add(u.id)
    focus.set(t.id, (focus.get(t.id) || 0) + 1)
    if (!(u.order && u.order.kind === "attack" && u.order.target === t.id)) cmd.attack(u, t)
  }

  // mode switching
  const myN = army.length
  let myVal = 0
  for (const u of army) myVal += gcost(u.type)
  let knownVal = 0
  for (const s of eArmy) knownVal += gcost(s.type)
  const knownN = total(eComp)
  // both sides spend about the same on army; what we killed more than we lost is missing on their side
  const symVal = (myVal + myMilLost - enemyMilKilled) * SYM_K
  const estVal = Math.max(knownVal, symVal)
  const avgCost = knownN > 0 ? knownVal / knownN : 80
  const estN = Math.max(knownN, estVal / avgCost)
  const estComp: Record<string, number> = {}
  if (knownN > 0) for (const k in eComp) estComp[k] = eComp[k] * estN / knownN
  else { estComp.spearman = estN / 3; estComp.archer = estN / 3; estComp.cavalry = estN / 3 }
  const r = ratio(myComp, estComp)
  if (mode === "home") {
    const cool = tick - lastRetreat < 400 && myN < 24
    const late = tick > 6000 && myN >= 14 && r >= 1.0
    const ecoDead = mineInfo.length === 0 && gold < 70 && myN >= 5 && r >= 1.0
    const chance = myN >= 8 && r >= 2.2
    if (!cool && ((myN >= ATTACK_MIN && r >= ATTACK_R) || myN >= 32 || unitCount >= game.unitCap - 1 || late || chance || ecoDead)) {
      mode = "attack"; modeSince = tick
      console.log(`t${tick} ATTACK army=${myN} r=${r.toFixed(2)} known=${JSON.stringify(eComp)} est=${estN.toFixed(1)} lost=${myMilLost} killed=${enemyMilKilled}`)
    }
  } else {
    if (myN < 6) { mode = "home"; modeSince = tick; lastRetreat = tick; console.log(`t${tick} RETREAT small army`) }
    else {
      let cx = 0, cy = 0
      for (const u of army) { cx += u.x; cy += u.y }
      cx /= myN; cy /= myN
      const localE = enemies.filter((e) => (isMil(e.type) || e.type === "tower") && Math.abs(e.x - cx) + Math.abs(e.y - cy) <= 14)
      const localM = army.filter((u) => Math.abs(u.x - cx) + Math.abs(u.y - cy) <= 12)
      const lr = ratio(countTypes(localM), countTypes(localE))
      if (localE.length >= 3 && lr < RETREAT_R) { mode = "home"; modeSince = tick; lastRetreat = tick; console.log(`t${tick} RETREAT lr=${lr.toFixed(2)} local=${JSON.stringify(countTypes(localE))}`) }
    }
  }
  let defendPos: Pos | null = null
  if (threatN > 0) {
    let sx = 0, sy = 0
    for (const e of homeThreats) { sx += e.x; sy += e.y }
    defendPos = { x: Math.round(sx / threatN), y: Math.round(sy / threatN) }
  }

  // escort a far depot (pending or working) with the waiting army
  let rallyNow = rally
  for (const t of tasks) {
    if (!t.tag.startsWith("depotX") || !t.mineIds) continue
    if (!goldmines.some((g) => t.mineIds!.includes(g.id))) continue
    if (enemyMilKilled >= 600 || tick >= 2600) rallyNow = escortPoint(t.near)
  }
  const prog: number[] = army.map((u) => dEnemy[idx(u.x, u.y)]).filter((v) => v >= 0).sort((a, b) => a - b)
  const median = prog.length ? prog[Math.floor(prog.length / 2)] : 0
  for (const u of army) {
    if (engaged.has(u.id)) continue
    const ue = dEnemy[idx(u.x, u.y)]
    if (defendPos && (mode === "home" || (threatN >= 3 && median > 14))) {
      if (!(u.order && u.order.kind === "attackMove" && u.order.x === defendPos.x && u.order.y === defendPos.y)) cmd.attackMove(u, defendPos.x, defendPos.y)
      continue
    }
    if (mode === "home") {
      if (dist(u, rallyNow) > 3) {
        if (!(u.order && u.order.kind === "move" && u.order.x === rallyNow.x && u.order.y === rallyNow.y)) cmd.move(u, rallyNow.x, rallyNow.y)
      }
    } else {
      if (ue >= 0 && ue < median - 5) {
        if (u.order && u.order.kind !== "idle") cmd.stop(u)
      } else {
        if (!(u.order && u.order.kind === "attackMove" && u.order.x === eBaseC.x && u.order.y === eBaseC.y)) cmd.attackMove(u, eBaseC.x, eBaseC.y)
      }
    }
  }

  if (tick - lastStatus >= 500) {
    lastStatus = tick
    console.log(`t${tick} gold=${view.resources.gold} w=${nWorkers}/${workerTarget} army=${JSON.stringify(myComp)} known=${JSON.stringify(eComp)} mode=${mode} r=${r.toFixed(2)} mines=${mineInfo.length}`)
  }
}
