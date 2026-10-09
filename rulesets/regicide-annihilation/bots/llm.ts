// 大模型试写（Sonnet 测试员 60 分钟交的 v8，偏强）：领主站在算好的位置点金让金矿贴着主基地，兵在家吃光环守住，估算对手兵力占 1.4 倍以上或刚挡住一波才带着领主出击。
type P = { x: number; y: number }

let inited = false
let myBase: Entity | null = null
let dBase: number[] = []
let dEnemy: number[] = []
let enemyBasePos: P = { x: 0, y: 0 }
let enemyLordHome: P = { x: 0, y: 0 }
let rally: P = { x: 0, y: 0 }
let lordSpot: P | null = null
let phase: "build" | "attack" = "build"
let castBlockedUntil = 0
let lastLordHp = 500
let produced = 0
let enemyDead = 0
let myDead = 0
let launchArmy = 0
let waveActive = false
let wavePeak = 0
let waveDeaths = 0
let lastRaiderTick = 0

const TARGET_WORKERS = 10
const ATTACK_BIG = 999
const STRONG_RATIO = 1.4
const COUNTER_MIN = 6
const RALLY_D = 6
const MAX_MINE_D = 22

function inMap(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < game.width && y < game.height
}
function walk(x: number, y: number): boolean {
  return inMap(x, y) && !!game.walkable[game.terrain[y][x]]
}
function idx(x: number, y: number): number {
  return y * game.width + x
}
function cdist(x: number, y: number): number {
  return Math.abs(x - (game.width - 1) / 2) + Math.abs(y - (game.height - 1) / 2)
}
const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

function init(view: View) {
  const me = view.me
  myBase = view.entities.find((e) => e.owner === me && e.type === "base") ?? null
  const lord0 = view.entities.find((e) => e.owner === me && e.type === "lord")
  const eb = view.objectives.enemyBases.find((b) => b.owner !== me)
  if (eb) enemyBasePos = { x: eb.x + 1, y: eb.y + 1 }
  if (lord0) enemyLordHome = { x: game.width - 1 - lord0.x, y: game.height - 1 - lord0.y }
  if (myBase) dBase = pathDistances(null, myBase)
  dEnemy = pathDistances(null, enemyBasePos)
  // 集结点：离家 RALLY_D 步、离对手最近的空格
  const occ = new Set<number>()
  for (const e of view.entities) {
    if (game.types[e.type].kind === "unit") continue
    for (let yy = e.y; yy < e.y + e.h; yy++) for (let xx = e.x; xx < e.x + e.w; xx++) occ.add(idx(xx, yy))
  }
  let best: P | null = null
  let bs = 1e9
  for (let y = 0; y < game.height; y++)
    for (let x = 0; x < game.width; x++) {
      if (!walk(x, y) || occ.has(idx(x, y))) continue
      if (dBase[idx(x, y)] !== RALLY_D) continue
      const s = dEnemy[idx(x, y)] * 10 + cdist(x, y)
      if (s < bs) {
        bs = s
        best = { x, y }
      }
    }
  rally = best ?? { x: myBase ? myBase.x + 4 : 10, y: myBase ? myBase.y + 4 : 10 }
  inited = true
}

// 点金落点预测：离领主最近的空地，一样近选离图中心近的
function predictMine(L: P, occAll: Set<number>): P | null {
  let best: P | null = null
  let bd = 1e9
  let bc = 1e9
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) {
      const d = Math.abs(dx) + Math.abs(dy)
      if (d === 0 || d > 3) continue
      const x = L.x + dx
      const y = L.y + dy
      if (!walk(x, y) || occAll.has(idx(x, y))) continue
      const c = (x - (game.width - 1) / 2) ** 2 + (y - (game.height - 1) / 2) ** 2
      if (d < bd || (d === bd && c < bc)) {
        bd = d
        bc = c
        best = { x, y }
      }
    }
  return best
}

function pickLordSpot(view: View, lord: Entity): P | null {
  if (!myBase) return null
  const occAll = new Set<number>()
  for (const e of view.entities) {
    if (e.id === lord.id) continue
    for (let yy = e.y; yy < e.y + e.h; yy++) for (let xx = e.x; xx < e.x + e.w; xx++) occAll.add(idx(xx, yy))
  }
  let best: P | null = null
  let bs = -1e9
  for (let dy = -7; dy <= 7; dy++)
    for (let dx = -7; dx <= 7; dx++) {
      if (Math.abs(dx) + Math.abs(dy) > 7) continue
      const x = myBase.x + 1 + dx
      const y = myBase.y + 1 + dy
      if (!walk(x, y) || occAll.has(idx(x, y))) continue
      const L = { x, y }
      const M = predictMine(L, occAll)
      if (!M) continue
      const dm = dist(M, myBase)
      let seats = 0
      let seatsBase = 0
      for (const [ax, ay] of DIRS) {
        const nx = M.x + ax
        const ny = M.y + ay
        if (!walk(nx, ny) || occAll.has(idx(nx, ny)) || (nx === x && ny === y)) continue
        seats++
        if (dist({ x: nx, y: ny }, myBase) === 1) seatsBase++
      }
      let free = 0
      for (const [ax, ay] of DIRS) {
        const nx = x + ax
        const ny = y + ay
        if (walk(nx, ny) && !occAll.has(idx(nx, ny)) && !(nx === M.x && ny === M.y)) free++
      }
      if (free < 2 || seats < 2) continue
      const s = (dm === 1 ? 6 : dm === 2 ? 3 : 0) + seats + 2 * seatsBase - 0.3 * (Math.abs(x - lord.x) + Math.abs(y - lord.y))
      if (s > bs) {
        bs = s
        best = L
      }
    }
  return best
}

function stepToward(from: P, steps: number): P {
  let cx = from.x
  let cy = from.y
  for (let i = 0; i < steps; i++) {
    let bx = cx
    let by = cy
    let bd = dEnemy[idx(cx, cy)]
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx
      const ny = cy + dy
      if (!walk(nx, ny)) continue
      const d = dEnemy[idx(nx, ny)]
      if (d >= 0 && d < bd) {
        bd = d
        bx = nx
        by = ny
      }
    }
    if (bx === cx && by === cy) break
    cx = bx
    cy = by
  }
  return { x: cx, y: cy }
}

function fleeTile(lord: Entity, threats: Entity[], view: View, anchor: P): P | null {
  const occAll = new Set<number>()
  for (const e of view.entities) {
    if (e.id === lord.id) continue
    for (let yy = e.y; yy < e.y + e.h; yy++) for (let xx = e.x; xx < e.x + e.w; xx++) occAll.add(idx(xx, yy))
  }
  let best: P | null = null
  let bs = -1e9
  for (let dy = -6; dy <= 6; dy++)
    for (let dx = -6; dx <= 6; dx++) {
      const st = Math.abs(dx) + Math.abs(dy)
      if (st > 6) continue
      const x = lord.x + dx
      const y = lord.y + dy
      if (!walk(x, y) || occAll.has(idx(x, y))) continue
      let dm = 99
      for (const t of threats) dm = Math.min(dm, Math.abs(t.x - x) + Math.abs(t.y - y))
      const s = dm * 3 - st * 0.5 - 0.4 * (Math.abs(x - anchor.x) + Math.abs(y - anchor.y))
      if (s > bs) {
        bs = s
        best = { x, y }
      }
    }
  return best
}

export function onTick(view: View, cmd: Commands): void {
  // 单位数（含生产队列）到上限就不再排生产，排了也会被拒
  const own = view.entities.filter((e) => e.owner === view.me)
  let room = game.unitCap > 0 ? game.unitCap - own.filter((e) => game.types[e.type].kind === "unit").length - own.reduce((a, e) => a + (e.queue?.length ?? 0), 0) : Infinity
  if (!inited) init(view)
  const me = view.me
  const tick = view.tick
  const mine = view.entities.filter((e) => e.owner === me)
  const base = mine.find((e) => e.type === "base")
  const barracks = mine.find((e) => e.type === "barracks")
  const lord = mine.find((e) => e.type === "lord")
  const workers = mine.filter((e) => e.type === "worker")
  const army = mine.filter((e) => e.type === "soldier" || e.type === "archer")
  const enemies = view.entities.filter((e) => e.owner >= 0 && e.owner !== me)
  const enemyLord = enemies.find((e) => e.type === "lord")
  const enemyCombat = enemies.filter((e) => e.type === "soldier" || e.type === "archer")

  for (const ev of view.events) {
    if (ev.kind === "rejected") {
      console.log("被拒", tick, JSON.stringify(ev.command), ev.reason)
      if (ev.command.kind === "cast") castBlockedUntil = tick + 40
    }
    if (ev.kind === "botError") console.log("botError", ev.message)
  }

  // ---------- 经济：生产 ----------
  let gold = view.resources.gold
  if (base) {
    const q = base.queue ?? []
    const queuedW = q.filter((x) => x.type === "worker").length
    if (workers.length + queuedW < TARGET_WORKERS && q.length < 2 && gold >= 50) {
      room-- > 0 && cmd.produce(base, "worker")
      gold -= 50
    }
  }
  if (barracks) {
    const q = barracks.queue ?? []
    const nSold = army.filter((e) => e.type === "soldier").length + q.filter((x) => x.type === "soldier").length
    const nArch = army.filter((e) => e.type === "archer").length + q.filter((x) => x.type === "archer").length
    const t: TypeName = nArch < nSold ? "archer" : "soldier"
    const c = game.types[t].cost.gold ?? 80
    if (q.length < 2 && gold >= c) {
      room-- > 0 && cmd.produce(barracks, t)
      gold -= c
    }
  }

  // ---------- 经济：工人分配 ----------
  const mines = view.entities.filter((e) => e.type === "goldmine" && (e.amount ?? 0) > 0)
  const occ = new Set<number>()
  for (const e of view.entities) {
    if (game.types[e.type].kind === "unit") continue
    for (let yy = e.y; yy < e.y + e.h; yy++) for (let xx = e.x; xx < e.x + e.w; xx++) occ.add(idx(xx, yy))
  }
  const load = new Map<number, number>()
  for (const w of workers) if (w.order?.kind === "gather") load.set(w.order.target, (load.get(w.order.target) ?? 0) + 1)
  const seatsOf = (m: Entity) => {
    let s = 0
    for (const [ax, ay] of DIRS) if (walk(m.x + ax, m.y + ay) && !occ.has(idx(m.x + ax, m.y + ay))) s++
    return s
  }
  for (const w of workers) {
    const o = w.order
    const needs = !o || o.kind === "idle" || (o.kind === "gather" && !mines.some((m) => m.id === o.target))
    if (!needs) continue
    let best: Entity | null = null
    let bs = 1e9
    for (const m of mines) {
      const d = dBase[idx(m.x, m.y)]
      if (d < 0 || d > MAX_MINE_D) continue
      const l = load.get(m.id) ?? 0
      if (l >= seatsOf(m)) continue
      const s = d + l * 1.5
      if (s < bs) {
        bs = s
        best = m
      }
    }
    if (best) {
      cmd.gather(w, best)
      load.set(best.id, (load.get(best.id) ?? 0) + 1)
    }
  }

  // ---------- 军队 + 领主 ----------
  if (!lord) return
  if (lord.hp < lastLordHp) console.log("领主掉血", tick, lord.hp, "at", lord.x, lord.y)
  lastLordHp = lord.hp
  if (!lordSpot || tick % 100 === 0) {
    const s = pickLordSpot(view, lord)
    if (s) lordSpot = s
  }
  const homeAnchor: P = lordSpot ?? { x: myBase?.x ?? 3, y: myBase?.y ?? 3 }

  // 袭扰家里的敌人
  const raiders = enemyCombat.filter((e) => (myBase && dist(e, myBase) <= 14) || dist(e, lord) <= 10)

  // 来犯的一波：记峰值和死了几个；打赢以后趁对方没兵马上反攻
  for (const ev of view.events) {
    const isArmy = ev.kind !== "rejected" && "type" in ev && (ev.type === "soldier" || ev.type === "archer")
    if (ev.kind === "created" && isArmy) produced++
    if (ev.kind === "died" && isArmy) {
      if (ev.owner === me) myDead++
      else if (ev.owner >= 0) {
        enemyDead++
        waveDeaths++
      }
    }
  }
  const estEnemy = Math.max(0, produced - enemyDead)
  const myScore = view.objectives.killValue[me] ?? 0
  let enemyScore = 0
  for (let i = 0; i < view.objectives.killValue.length; i++) if (i !== me) enemyScore = Math.max(enemyScore, view.objectives.killValue[i])
  if (raiders.length > 0) {
    waveActive = true
    wavePeak = Math.max(wavePeak, raiders.length)
    lastRaiderTick = tick
  } else if (waveActive && tick - lastRaiderTick >= 30) {
    waveActive = false
    if (phase === "build" && army.length >= COUNTER_MIN && waveDeaths >= wavePeak * 0.5 && army.length >= estEnemy) {
      phase = "attack"
      launchArmy = army.length
      console.log("反攻", tick, "兵", army.length, "来犯峰值", wavePeak, "击杀", waveDeaths)
    }
    wavePeak = 0
    waveDeaths = 0
  }
  if (phase === "build") {
    const strong = army.length >= 8 && army.length >= STRONG_RATIO * Math.max(estEnemy, 6)
    // 收进参考 bot 时改了一处：快到时间上限时不领先就孤注一掷（原来只在落后时，碰上不出门的对手会拖成平局）
    const lateAllIn = tick >= 4800 && myScore <= enemyScore && army.length >= 10
    if ((strong || lateAllIn || army.length >= ATTACK_BIG) && raiders.length === 0) {
      phase = "attack"
      launchArmy = army.length
      console.log("出击", tick, "兵", army.length, "估计对手", estEnemy, "比分", myScore, enemyScore)
    }
  } else {
    if (army.length <= Math.max(3, Math.floor(launchArmy * 0.4))) {
      phase = "build"
      console.log("撤回", tick, "兵", army.length)
    }
  }

  // 威胁领主的敌人
  const lordThreat = enemyCombat.filter((e) => dist(e, lord) <= 5)

  if (phase === "build") {
    let sx0 = 0
    let sy0 = 0
    for (const a of army) {
      sx0 += a.x
      sy0 += a.y
    }
    const cen: P = army.length ? { x: Math.round(sx0 / army.length), y: Math.round(sy0 / army.length) } : homeAnchor
    if (raiders.length > 0) {
      // 守家：领主带着兵一起动。队伍散了先聚拢，聚拢了再冲敌人；领主始终待在队伍中心
      let tx = 0
      let ty = 0
      for (const r of raiders) {
        tx += r.x
        ty += r.y
      }
      const tgt = { x: Math.round(tx / raiders.length), y: Math.round(ty / raiders.length) }
      let spread = 0
      for (const a of army) spread = Math.max(spread, dist(a, cen))
      const gather = spread > 6 && dist(cen, tgt) > 9
      for (const a of army) {
        if (gather) {
          if (dist(a, cen) > 2) cmd.attackMove(a, cen.x, cen.y)
        } else cmd.attackMove(a, tgt.x, tgt.y)
      }
      if (lordThreat.length > 0 && army.length < 5) {
        const f = fleeTile(lord, lordThreat, view, homeAnchor)
        if (f) cmd.move(lord, f.x, f.y)
      } else if (army.length > 0 && dist(lord, cen) > 2) {
        cmd.move(lord, cen.x, cen.y)
      } else if (army.length === 0 && lordSpot && dist(lord, lordSpot) > 0) {
        cmd.move(lord, lordSpot.x, lordSpot.y)
      }
    } else {
      for (const a of army) {
        if (dist(a, rally) > 3 && (a.order?.kind === "idle" || a.order?.kind === "move" || !a.order)) cmd.attackMove(a, rally.x, rally.y)
      }
      // 领主：回点金位、冷却好了就点
      if (lordSpot) {
        if (dist(lord, lordSpot) > 0) cmd.move(lord, lordSpot.x, lordSpot.y)
        else if ((lord.skillCooldowns?.goldmine ?? 0) === 0 && tick >= castBlockedUntil) cmd.cast(lord, "goldmine")
      }
    }
  } else {
    // 推进：整队走路点，路点在最后 1/4 以外的兵前方 6 步，保持队形紧凑；领主走在队伍中心
    const sorted = [...army].sort((a, b) => dEnemy[idx(b.x, b.y)] - dEnemy[idx(a.x, a.y)])
    const ref = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.25))]
    let wp: P = enemyBasePos
    if (ref && dEnemy[idx(ref.x, ref.y)] > 9) wp = stepToward(ref, 6)
    for (const a of army) {
      if (enemyLord && dist(a, enemyLord) <= (game.types[a.type].attack?.range ?? 1) + 1) {
        cmd.attack(a, enemyLord)
        continue
      }
      const o = a.order
      if (!o || o.kind !== "attackMove" || o.x !== wp.x || o.y !== wp.y) cmd.attackMove(a, wp.x, wp.y)
    }
    let sx = 0
    let sy = 0
    for (const a of army) {
      sx += a.x
      sy += a.y
    }
    const c: P = army.length ? { x: Math.round(sx / army.length), y: Math.round(sy / army.length) } : homeAnchor
    if (lordThreat.length > 0) {
      const f = fleeTile(lord, lordThreat, view, c)
      if (f) cmd.move(lord, f.x, f.y)
    } else if (dist(lord, c) > 2) {
      cmd.move(lord, c.x, c.y)
    }
  }
}
