// 大模型试写（Sonnet 测试员第二轮 60 分钟交的 v6，偏强）：11 个工人、建仓库开分矿、两座兵营不建塔，领主点金；集结够 15 个兵带着领主出门，先清路上的野怪营地再拆对方主基地，敌兵进 9 格全队转打敌兵，家里来敌人全军回防。
const WORKER_TARGET = 11
const GO_SIZE = 15

let mode: "home" | "out" = "home"
let homeInit = false
let pd: number[] = []
let rally: Pos = { x: 0, y: 0 }
let castSpot: Pos | null = null
let lastCastTick = -999
let dd: number[] = []
let lastDropN = 0
let lastDDTick = -999
let expWorker = 0

function walk(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < game.width && y < game.height && !!game.walkable[game.terrain[y][x]]
}

function nearestWalkable(x: number, y: number): Pos {
  for (let r = 0; r < 12; r++) {
    for (let dx = -r; dx <= r; dx++) {
      const dy = r - Math.abs(dx)
      for (const sy of dy === 0 ? [0] : [-1, 1]) {
        const xx = x + dx, yy = y + dy * sy
        if (walk(xx, yy)) return { x: xx, y: yy }
      }
    }
  }
  return { x, y }
}

function centroid(us: Entity[]): Pos {
  let sx = 0, sy = 0
  for (const u of us) { sx += u.x; sy += u.y }
  return { x: Math.round(sx / us.length), y: Math.round(sy / us.length) }
}

export function onTick(view: View, cmd: Commands): void {
  const me = view.me
  const ents = view.entities
  const mine = ents.filter((e) => e.owner === me)
  const base = mine.find((e) => e.type === "base")
  if (!base) return
  const lord = mine.find((e) => e.type === "lord")
  const workers = mine.filter((e) => e.type === "worker")
  const army = mine.filter((e) => e.type === "soldier" || e.type === "archer")
  const barracks = mine.filter((e) => e.type === "barracks")
  const doneBarracks = barracks.filter((e) => !e.construction)
  const mirrored = base.x > game.width / 2
  const dir = mirrored ? -1 : 1
  const eb = view.objectives.enemyBases[0]
  const enemyBase: Pos = { x: eb.x + 1, y: eb.y + 1 }
  const enemies = ents.filter((e) => e.owner >= 0 && e.owner !== me)
  const enemyCombat = enemies.filter((e) => e.type === "soldier" || e.type === "archer")
  const enemyLord = enemies.find((e) => e.type === "lord")
  const creeps = ents.filter((e) => e.owner === -1 && e.type === "creep")
  const resources = ents.filter((e) => game.types[e.type].kind === "resource" && (e.amount ?? 0) > 0)
  let gold = view.resources.gold

  if (!homeInit) {
    homeInit = true
    pd = pathDistances(null, base)
    rally = nearestWalkable(base.x + 1 + dir * 10, base.y + 1 + dir * 10)
  }

  // ---------- 经济：工人 ----------
  const dropoffs = mine.filter((e) => e.type === "base" || (e.type === "depot" && !e.construction))
  if (dropoffs.length !== lastDropN || view.tick - lastDDTick >= 150) {
    dd = pathDistances(view, dropoffs)
    lastDropN = dropoffs.length
    lastDDTick = view.tick
  }
  const mineDD = (r: Entity): number => {
    let m = 999
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = r.x + dx, y = r.y + dy
      if (x < 0 || y < 0 || x >= game.width || y >= game.height) continue
      const v = dd[y * game.width + x]
      if (v >= 0 && v + 1 < m) m = v + 1
    }
    return m
  }
  const assigned = new Map<number, number>()
  for (const w of workers) {
    if (w.order?.kind === "gather") assigned.set(w.order.target, (assigned.get(w.order.target) ?? 0) + 1)
  }
  const nearCamp = (p: Pos, d: number) => view.objectives.creepCamps.some((cp) => dist(p, { x: cp.x, y: cp.y }) <= d)
  const mdOf = new Map<number, number>()
  for (const r of resources) mdOf.set(r.id, mineDD(r))
  for (const w of workers) {
    if (w.order?.kind !== "idle") continue
    let best: Entity | null = null
    let bs = 1e9
    for (const pass of [0, 1]) {
      for (const r of resources) {
        const md = mdOf.get(r.id)!
        if (md > 26) continue
        if (pass === 0 && nearCamp(r, 6)) continue
        const s = md + 4 * (assigned.get(r.id) ?? 0) + 0.25 * dist(w, r)
        if (s < bs) { bs = s; best = r }
      }
      if (best) break
    }
    if (best) {
      cmd.gather(w, best)
      assigned.set(best.id, (assigned.get(best.id) ?? 0) + 1)
    }
  }

  // ---------- 扩张：到分矿建仓库 ----------
  const nearAmount = resources.filter((r) => (mdOf.get(r.id) ?? 999) <= 10).reduce((a, r) => a + (r.amount ?? 0), 0)
  const depots = mine.filter((e) => e.type === "depot")
  const depotFoundation = depots.find((d) => d.construction)
  if (depotFoundation) {
    const helpers = workers.filter((w) => w.order?.kind === "build" && w.order.target === depotFoundation.id)
    if (helpers.length < 2) {
      const w = workers.filter((x) => x.order?.kind === "gather" && !x.carrying).sort((a, c) => dist(a, depotFoundation) - dist(c, depotFoundation))[0]
      if (w && dist(w, depotFoundation) <= 14) cmd.build(w, "depot", depotFoundation.x, depotFoundation.y)
    }
    expWorker = 0
  } else if (view.tick > 500 && nearAmount < 900 && depots.length < 2 && gold >= 100) {
    let tgt: Entity | null = null
    let ts = 1e9
    for (const r of resources) {
      if ((mdOf.get(r.id) ?? 0) <= 10) continue
      if (nearCamp(r, 8)) continue
      const s = (pd[r.y * game.width + r.x] ?? 999) - (r.amount ?? 0) / 100
      if (s < ts) { ts = s; tgt = r }
    }
    if (tgt) {
      let w = workers.find((x) => x.id === expWorker)
      if (!w) {
        w = workers.filter((x) => x.order?.kind !== "build" && !x.carrying).sort((a, c) => dist(a, tgt!) - dist(c, tgt!))[0]
        if (w) expWorker = w.id
      }
      if (w) {
        const cluster = resources.filter((r) => dist(r, tgt!) <= 4)
        const cc = { x: Math.round(cluster.reduce((a, r) => a + r.x, 0) / cluster.length), y: Math.round(cluster.reduce((a, r) => a + r.y, 0) / cluster.length) }
        const spot = findBuildSpot(view, "depot", cc, 5, 0)
        if (spot) {
          cmd.build(w, "depot", spot.x, spot.y)
          gold -= 100
          expWorker = 0
        } else {
          const p = nearestWalkable(cc.x, cc.y)
          if (dist(w, p) > 1) cmd.move(w, p.x, p.y)
        }
      }
    }
  }

  // ---------- 建造：兵营 ----------
  const wantBarracks = workers.length >= 8 && view.tick > 500 ? 2 : 1
  if (barracks.length < wantBarracks && gold >= 150) {
    const near = { x: base.x + 1 + dir * 6, y: base.y + 1 + dir * 6 }
    const spot = findBuildSpot(view, "barracks", near, 8, 1)
    if (spot) {
      const n = barracks.length === 0 ? 3 : 2
      const cands = workers.filter((w) => w.order?.kind !== "build" && !w.carrying).sort((a, b) => dist(a, spot) - dist(b, spot))
      const pick = cands.slice(0, n)
      if (pick.length > 0) {
        for (const w of pick) cmd.build(w, "barracks", spot.x, spot.y)
        gold -= 150
      }
    }
  }
  // 帮忙建没建好的兵营
  for (const b of barracks) {
    if (!b.construction) continue
    const helpers = workers.filter((w) => w.order?.kind === "build" && w.order.target === b.id)
    if (helpers.length < 2) {
      const w = workers.filter((x) => x.order?.kind === "gather" && !x.carrying).sort((a, c) => dist(a, b) - dist(c, b))[0]
      if (w && dist(w, b) < 12) cmd.build(w, "barracks", b.x, b.y)
    }
  }

  // ---------- 生产 ----------
  const workerQ = (base.queue ?? []).length
  const nWorkers = workers.length + workerQ
  const workerTarget = WORKER_TARGET + 4 * depots.filter((d) => !d.construction).length
  if (nWorkers < workerTarget && workerQ < 2 && gold >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }
  const soldiers = army.filter((e) => e.type === "soldier").length
  const archers = army.filter((e) => e.type === "archer").length
  let qS = 0, qA = 0
  for (const b of barracks) for (const q of b.queue ?? []) { if (q.type === "soldier") qS++; else qA++ }
  for (const b of doneBarracks) {
    if ((b.queue ?? []).length >= 2) continue
    const wantArcher = archers + qA < (soldiers + qS) * 0.7
    const t: TypeName = wantArcher ? "archer" : "soldier"
    const c = game.types[t].cost.gold ?? 0
    const saving = barracks.length < wantBarracks && doneBarracks.length >= 1
    if (gold >= c + (saving ? 150 : 0)) {
      cmd.produce(b, t)
      gold -= c
      if (t === "soldier") qS++; else qA++
    }
  }

  // ---------- 领主 ----------
  const atHome = lord ? dist(lord, base) <= 8 : false
  if (lord) {
    const cd = lord.skillCooldowns?.goldmine ?? 0
    if (mode === "home" || army.length === 0) {
      if (!castSpot || view.tick % 100 === 0) castSpot = pickCastSpot(view, base, dir)
      if (castSpot) {
        if (lord.x !== castSpot.x || lord.y !== castSpot.y) {
          if (cd <= 60 || army.length < 3) cmd.move(lord, castSpot.x, castSpot.y)
        }
        if (cd === 0 && lord.x === castSpot.x && lord.y === castSpot.y && view.tick - lastCastTick >= 5) {
          cmd.cast(lord, "goldmine")
          lastCastTick = view.tick
          castSpot = null
        }
      }
    }
  }

  // ---------- 军队 ----------
  const nearBaseEnemies = enemies.filter((e) => e.type !== "worker" && dist(e, base) <= 10)
  const workerHarass = enemies.filter((e) => e.type === "worker" && dist(e, base) <= 10)
  if (mode === "home" && army.filter((u) => dist(u, rally) <= 8).length >= GO_SIZE) mode = "out"
  if (mode === "out" && army.length < 4) mode = "home"

  const c = army.length > 0 ? centroid(army) : null
  const homeSpot = { x: base.x + 1 + dir * 3, y: base.y + 1 + dir * 3 }

  if (nearBaseEnemies.length > 0 || workerHarass.length > 0) {
    const foes = nearBaseEnemies.length > 0 ? nearBaseEnemies : workerHarass
    const t = foes.reduce((a, b) => (dist(a, base) <= dist(b, base) ? a : b))
    for (const u of army) cmd.attackMove(u, t.x, t.y)
    if (lord && !atHome) cmd.move(lord, homeSpot.x, homeSpot.y)
  } else if (mode === "home" || !c) {
    for (const u of army) {
      if (dist(u, rally) > 3 && u.order?.kind !== "attackMove") cmd.attackMove(u, rally.x, rally.y)
    }
  } else {
    // 出击
    const foesNear = enemyCombat.filter((e) => army.some((u) => dist(u, e) <= 9) || (lord != null && dist(lord, e) <= 8))
    let target: Pos = enemyBase
    let campTarget: { x: number; y: number } | null = null
    let bestS = 1e9
    for (const camp of view.objectives.creepCamps) {
      if (camp.alive <= 0) continue
      const s = (pd[camp.y * game.width + camp.x] ?? 999) + (camp.size === 2 ? 10 : 0)
      if (s < bestS) { bestS = s; campTarget = camp }
    }
    if (campTarget && army.length < 18) target = { x: campTarget.x, y: campTarget.y }

    if (foesNear.length > 0) {
      const t = foesNear.reduce((a, b) => (dist(a, c) <= dist(b, c) ? a : b))
      if (enemyLord && army.filter((u) => dist(u, enemyLord) <= 5).length >= 4) {
        for (const u of army) {
          if (dist(u, enemyLord) <= 6) cmd.attack(u, enemyLord)
          else cmd.attackMove(u, t.x, t.y)
        }
      } else {
        for (const u of army) cmd.attackMove(u, t.x, t.y)
      }
    } else if (enemyLord && army.some((u) => dist(u, enemyLord) <= 6)) {
      const near = army.filter((u) => dist(u, enemyLord) <= 7)
      for (const u of near) cmd.attack(u, enemyLord)
      for (const u of army) if (!near.includes(u)) cmd.attackMove(u, enemyLord.x, enemyLord.y)
    } else if (campTarget && target.x === campTarget.x && target.y === campTarget.y) {
      const campCreeps = creeps.filter((e) => dist(e, target) <= 6)
      const closeToCamp = army.filter((u) => dist(u, target) <= 7).length
      if (campCreeps.length > 0 && closeToCamp >= Math.min(army.length, 6) * 0.7) {
        const t = campCreeps.reduce((a, b) => (dist(a, c) - a.hp / 100 <= dist(b, c) - b.hp / 100 ? a : b))
        for (const u of army) cmd.attack(u, t)
      } else {
        const lead = army.reduce((a, b) => (dist(a, target) <= dist(b, target) ? a : b))
        for (const u of army) {
          if (u === lead || dist(u, target) > 9 || closeToCamp >= army.length * 0.7) cmd.attackMove(u, target.x, target.y)
          else if (dist(u, lead) <= 3 && dist(lead, target) <= 9) cmd.stop(u)
          else cmd.attackMove(u, target.x, target.y)
        }
      }
    } else {
      const dc = dist(c, target)
      for (const u of army) {
        if (dist(u, c) > 5 && dist(u, c) <= 12 && dist(u, target) < dc - 2 && dist(u, target) > 10) cmd.stop(u)
        else cmd.attackMove(u, target.x, target.y)
      }
    }

    // 领主：战斗时站在队伍中间，行军时在后面 3 格
    if (lord) {
      const fighting = foesNear.length > 0
      const back = fighting ? 1 : 3
      const hdx = base.x + 1 - c.x, hdy = base.y + 1 - c.y
      const hl = Math.max(1, Math.abs(hdx) + Math.abs(hdy))
      const want = nearestWalkable(Math.round(c.x + (hdx / hl) * back), Math.round(c.y + (hdy / hl) * back))
      if (dist(lord, want) > 2) cmd.move(lord, want.x, want.y)
      const threats = enemyCombat.filter((e) => dist(e, lord) <= 6)
      const guards = army.filter((u) => dist(u, lord) <= 6).length
      if (threats.length > guards + 1 || lord.hp < 200) cmd.move(lord, homeSpot.x, homeSpot.y)
    }
  }
}

function pickCastSpot(view: View, base: Entity, dir: number): Pos | null {
  const occ = new Set<number>()
  for (const e of view.entities) {
    if (e.type === "lord") continue
    for (let yy = e.y; yy < e.y + e.h; yy++) for (let xx = e.x; xx < e.x + e.w; xx++) occ.add(yy * game.width + xx)
  }
  const free = (x: number, y: number) => walk(x, y) && !occ.has(y * game.width + x)
  let best: Pos | null = null
  let bs = 1e9
  for (let y = base.y - 3; y <= base.y + 6; y++) {
    for (let x = base.x - 3; x <= base.x + 6; x++) {
      if (!free(x, y)) continue
      const d = dist({ x, y }, base)
      if (d < 1 || d > 4) continue
      let nf = 0
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (free(x + dx, y + dy)) nf++
      if (nf < 3) continue
      const s = d * 2 + (dir > 0 ? -(x + y) : (x + y)) * 0.1 - nf
      if (s < bs) { bs = s; best = { x, y } }
    }
  }
  return best
}
