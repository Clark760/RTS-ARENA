// 大模型试写（Sonnet 测试员 60 分钟交的 v7，偏强）：两座兵营、不建塔，领主点金让金矿贴着主基地；12 个兵带着领主沿对角线分段推进，领主挑己方兵多、避开敌塔的格子跟着，直扑对方领主开局的角落。
let lordStart: Pos | null = null
let rally: Pos | null = null
let attacking = false
let homePd: number[] | null = null
let lordSpot: Pos | null = null
let loggedCast = 0
let route: Pos[] = []
let routeKey = ''
let routeCost: number[] = []
const knownTowers = new Map<number, Pos>()
let cornerDone = false

const ATTACK_N = 12
const WORKER_TARGET = 14

function inMap(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < game.width && y < game.height
}
function terrOk(x: number, y: number): boolean {
  return inMap(x, y) && !!game.walkable[game.terrain[y][x]]
}
const D4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

export function onTick(view: View, cmd: Commands): void {
  // 单位数（含生产队列）到上限就不再排生产，排了也会被拒
  const own = view.entities.filter((e) => e.owner === view.me)
  let room = game.unitCap > 0 ? game.unitCap - own.filter((e) => game.types[e.type].kind === "unit").length - own.reduce((a, e) => a + (e.queue?.length ?? 0), 0) : Infinity
  const me = view.me
  const W = game.width
  const H = game.height
  const mine = view.entities.filter((e) => e.owner === me)
  const base = mine.find((e) => e.type === "base")
  const lord = mine.find((e) => e.type === "lord")
  if (!base) return
  const enemyBase = view.objectives.enemyBases.find((b) => b.owner !== me)!
  if (!lordStart && lord) lordStart = { x: lord.x, y: lord.y }
  if (!homePd) homePd = pathDistances(null, base)
  if (!rally) {
    let best: Pos | null = null
    let bd = 1e9
    const flip = base.x + 1 > W / 2
    for (let i = 0; i < W * H; i++) {
      const k = flip ? W * H - 1 - i : i
      const x = k % W
      const y = (k - x) / W
      {
        const d = homePd[y * W + x]
        if (d < 8 || d > 10) continue
        const ed = Math.abs(x - enemyBase.x) + Math.abs(y - enemyBase.y)
        if (ed < bd) {
          bd = ed
          best = { x, y }
        }
      }
    }
    rally = best ?? { x: base.x + 1 + (base.x + 1 < W / 2 ? 6 : -6), y: base.y + 1 + (base.y + 1 < H / 2 ? 6 : -6) }
  }

  for (const ev of view.events) {
    if (ev.kind === "rejected" && view.tick < 3000) console.log("REJ", ev.tick, JSON.stringify(ev.command), ev.reason)
    if (ev.kind === "botError") console.log("BOTERR", ev.message)
  }

  for (const ev of view.events) if (ev.kind === "died" && ev.type === "tower") knownTowers.delete(ev.id)
  for (const e of view.entities) if (e.type === "tower" && e.owner >= 0 && e.owner !== me) knownTowers.set(e.id, { x: e.x, y: e.y })

  const workers = mine.filter((e) => e.type === "worker")
  const army = mine.filter((e) => e.type === "soldier" || e.type === "archer")
  const barracks = mine.filter((e) => e.type === "barracks")
  const doneBarracks = barracks.filter((e) => !e.construction)
  const depotsDone = mine.filter((e) => e.type === "depot" && !e.construction)
  const enemies = view.entities.filter((e) => e.owner >= 0 && e.owner !== me)
  const enemyLord = enemies.find((e) => e.type === "lord")
  const enemyFighters = enemies.filter((e) => e.type === "soldier" || e.type === "archer" || e.type === "tower")

  // 占用图（静态 + 所有可见实体）
  const occ = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!terrOk(x, y)) occ[y * W + x] = 1
  for (const e of view.entities)
    for (let dy = 0; dy < e.h; dy++) for (let dx = 0; dx < e.w; dx++) if (inMap(e.x + dx, e.y + dy)) occ[(e.y + dy) * W + e.x + dx] = 1

  const occStatic = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!terrOk(x, y)) occStatic[y * W + x] = 1
  for (const e of view.entities)
    if (game.types[e.type].kind !== "unit")
      for (let dy = 0; dy < e.h; dy++) for (let dx = 0; dx < e.w; dx++) if (inMap(e.x + dx, e.y + dy)) occStatic[(e.y + dy) * W + e.x + dx] = 1

  let gold = view.resources.gold
  const dropoffs: Entity[] = [base, ...depotsDone]
  const pd = pathDistances(view, dropoffs)

  // ---------- 采集 ----------
  const mines = view.entities.filter((e) => e.type === "goldmine" && (e.amount ?? 0) > 0)
  const assigned = new Map<number, number>()
  for (const w of workers) if (w.order?.kind === "gather") assigned.set(w.order.target, (assigned.get(w.order.target) ?? 0) + 1)
  const mineInfo = mines.map((m) => {
    let mp = 1e9
    let slots = 0
    for (const [dx, dy] of D4) {
      const nx = m.x + dx
      const ny = m.y + dy
      if (!terrOk(nx, ny)) continue
      slots++
      const p = pd[ny * W + nx]
      if (p >= 0 && p + 1 < mp) mp = p + 1
    }
    return { m, mp, slots }
  })
  for (const w of workers) {
    if (w.order?.kind !== "idle") continue
    let best: (typeof mineInfo)[0] | null = null
    let bc = 1e9
    for (const mi of mineInfo) {
      if (mi.mp > 16) continue
      const a = assigned.get(mi.m.id) ?? 0
      if (a >= Math.min(4, mi.slots)) continue
      const c = mi.mp + 10 * a
      if (c < bc) {
        bc = c
        best = mi
      }
    }
    if (best) {
      cmd.gather(w, best.m)
      assigned.set(best.m.id, (assigned.get(best.m.id) ?? 0) + 1)
    }
  }

  // ---------- 建造兵营 ----------
  const foundations = mine.filter((e) => e.construction)
  for (const f of foundations) {
    const builders = workers.filter((w) => w.order?.kind === "build" && w.order.target === f.id).length
    if (builders < 2) {
      const free = workers
        .filter((w) => w.order?.kind === "gather" && !w.carrying)
        .sort((a, b) => dist(a, f) - dist(b, f))
      for (let i = 0; i < 2 - builders && i < free.length; i++) cmd.build(free[i], f.type, f.x, f.y)
    }
  }
  const wantBarracks = barracks.length === 0 ? 1 : view.tick > 500 && barracks.length < 2 && doneBarracks.length >= 1 ? 2 : 0
  if (wantBarracks > 0 && foundations.length === 0 && gold >= 150 && view.tick >= 5) {
    const sx = base.x + 1 < W / 2 ? 1 : -1
    const sy = base.y + 1 < H / 2 ? 1 : -1
    const near = { x: base.x + 1 + sx * 5, y: base.y + 1 + sy * 5 }
    const spot = findBuildSpot(view, "barracks", near, 8, 1)
    const cand = workers.filter((w) => w.order?.kind === "gather" && !w.carrying)
    if (spot && cand.length > 0) {
      cand.sort((a, b) => dist(a, spot) - dist(b, spot))
      cmd.build(cand[0], "barracks", spot.x, spot.y)
      if (cand[1]) cmd.build(cand[1], "barracks", spot.x, spot.y)
      gold -= 150
    }
  }

  // ---------- 生产 ----------
  const qWorkers = (base.queue ?? []).filter((q) => q.type === "worker").length
  if (workers.length + qWorkers < WORKER_TARGET && (base.queue?.length ?? 0) < 2 && gold >= 50) {
    room-- > 0 && cmd.produce(base, "worker")
    gold -= 50
  }
  let nSold = army.filter((e) => e.type === "soldier").length
  let nArch = army.filter((e) => e.type === "archer").length
  for (const b of doneBarracks) for (const q of b.queue ?? []) q.type === "soldier" ? nSold++ : nArch++
  const unitCount = mine.filter((e) => game.types[e.type].kind === "unit" && e.type !== "lord").length
  let queued = 0
  for (const b of doneBarracks) {
    if ((b.queue?.length ?? 0) >= 2) continue
    const type: TypeName = nArch * 2 < nSold ? "archer" : "soldier"
    const cost = game.types[type].cost.gold ?? 0
    if (gold >= cost && unitCount + queued < game.unitCap - 1) {
      room-- > 0 && cmd.produce(b, type)
      gold -= cost
      queued++
      type === "archer" ? nArch++ : nSold++
    }
  }

  // ---------- 领主 ----------
  if (lord) {
    const cd = lord.skillCooldowns?.goldmine ?? 0
    const nearHome = dist(lord, base) <= 12
    if (!attacking && nearHome) {
      // 选站位：让预测落点的金矿旁有紧挨基地的站位
      if (!lordSpot || (cd === 0 && (lord.x !== lordSpot.x || lord.y !== lordSpot.y) && view.tick % 50 === 0)) {
        lordSpot = chooseLordSpot(view, lord, base, occ)
      }
      if (lordSpot && (lord.x !== lordSpot.x || lord.y !== lordSpot.y)) {
        cmd.move(lord, lordSpot.x, lordSpot.y)
      } else if (cd === 0) {
        cmd.cast(lord, "goldmine")
        if (loggedCast < 6) {
          console.log("CAST at", lord.x, lord.y, "tick", view.tick)
          loggedCast++
        }
        lordSpot = null
      }
    } else if (!attacking && !nearHome) {
      cmd.move(lord, base.x + 1 + (base.x + 1 < W / 2 ? 3 : -3), base.y + 1 + (base.y + 1 < H / 2 ? 3 : -3))
    }
  }

  // ---------- 军队 ----------
  const threat = enemyFighters.filter((e) => dist(e, base) <= 14 || (lord && dist(e, lord) <= 10))
  if (!attacking && army.length >= ATTACK_N) attacking = true
  if (attacking && army.length < 4) attacking = false

  if (threat.length > 0 && !attacking) {
    const t = threat.reduce((a, b) => (dist(a, base) <= dist(b, base) ? a : b))
    for (const u of army) cmd.attackMove(u, t.x, t.y)
    if (lord && dist(lord, base) > 3) cmd.move(lord, base.x + 1 + (base.x + 1 < W / 2 ? 3 : -3), base.y + 1 + (base.y + 1 < H / 2 ? 3 : -3))
  } else if (attacking) {
    const mirror = lordStart ? { x: W - 1 - lordStart.x, y: H - 1 - lordStart.y } : { x: enemyBase.x, y: enemyBase.y }
    if (!cornerDone && army.some((u) => dist(u, mirror) <= 4) && !enemyLord) cornerDone = true
    const goal: Pos = cornerDone ? { x: enemyBase.x + 1, y: enemyBase.y + 1 } : mirror
    const key = goal.x + "," + goal.y + "|" + [...knownTowers.keys()].join(",")
    if (key !== routeKey) {
      routeKey = key
      routeCost = computeRouteCost(goal, [...knownTowers.values()])
      route = []
      let cur: Pos = { x: rally!.x, y: rally!.y }
      let guard = 0
      while (guard++ < 500) {
        const cc = routeCost[cur.y * W + cur.x]
        if (!isFinite(cc) || cc <= 0) break
        route.push(cur)
        let nb: Pos | null = null
        let nbc = cc
        for (const [dx, dy] of D4) {
          const nx = cur.x + dx
          const ny = cur.y + dy
          if (inMap(nx, ny) && routeCost[ny * W + nx] < nbc) {
            nbc = routeCost[ny * W + nx]
            nb = { x: nx, y: ny }
          }
        }
        if (!nb) break
        cur = nb
      }
      route.push(goal)
    }
    const costs = army
      .map((u) => routeCost[u.y * W + u.x])
      .filter((d) => isFinite(d))
      .sort((a, b) => a - b)
    const medCost = costs.length ? costs[Math.floor(costs.length / 2)] : 1e9
    const tgtCost = medCost - 7
    let wp = route[route.length - 1]
    for (const c of route) {
      if (routeCost[c.y * W + c.x] <= tgtCost) {
        wp = c
        break
      }
    }
    for (const u of army) {
      if (enemyLord && dist(u, enemyLord) <= 12) cmd.attack(u, enemyLord)
      else cmd.attackMove(u, wp.x, wp.y)
    }
    if (lord) {
      // 参考点：周围兵最多的那个兵（并列取离家近的）
      let ref: Entity | null = null
      let rc = -1
      for (const u of army) {
        let c = 0
        for (const v of army) if (dist(u, v) <= 6) c++
        if (c > rc || (c === rc && ref && dist(u, base) < dist(ref, base))) {
          rc = c
          ref = u
        }
      }
      if (ref) {
        const spot = lordSafeWalk(lord, ref, army, enemies, occStatic, homePd)
        if (spot) cmd.move(lord, spot.x, spot.y)
      }
    }
  } else {
    for (const u of army) if (u.order?.kind === "idle" && dist(u, rally) > 3) cmd.attackMove(u, rally.x, rally.y)
  }
}

// 预测领主 cast 落点：离领主最近的空地，同样近的取离地图中心近的
function predictMine(px: number, py: number, occ: Uint8Array): Pos[] {
  const W = game.width
  const cx = (game.width - 1) / 2
  const cy = (game.height - 1) / 2
  for (let d = 1; d <= 4; d++) {
    let bestScore = 1e9
    let res: Pos[] = []
    for (let dy = -d; dy <= d; dy++) {
      const dx = d - Math.abs(dy)
      for (const sx of dx === 0 ? [0] : [-dx, dx]) {
        const x = px + sx
        const y = py + dy
        if (!inMap(x, y) || occ[y * W + x]) continue
        const s = Math.abs(x - cx) + Math.abs(y - cy)
        if (s < bestScore - 1e-9) {
          bestScore = s
          res = [{ x, y }]
        } else if (Math.abs(s - bestScore) < 1e-9) res.push({ x, y })
      }
    }
    if (res.length) return res
  }
  return []
}

function chooseLordSpot(view: View, lord: Entity, base: Entity, occ: Uint8Array): Pos | null {
  const W = game.width
  let best: Pos | null = null
  let bs = -1e9
  const flip = base.x + 1 > W / 2
  const x0 = base.x - 5
  const y0 = base.y - 5
  const bw = base.w + 10
  const bh = base.h + 10
  for (let i = 0; i < bw * bh; i++) {
    const k = flip ? bw * bh - 1 - i : i
    const x = x0 + (k % bw)
    const y = y0 + Math.floor(k / bw)
    {
      if (!inMap(x, y)) continue
      const own = x === lord.x && y === lord.y
      if (occ[y * W + x] && !own) continue
      // 暂时把领主所站格当空（它会离开的话也是空；站在这里它不算空地）
      const occ2 = occ
      const cands = predictMine(x, y, occ2)
      if (cands.length === 0) continue
      let worst = 1e9
      for (const m of cands) {
        let s = 0
        let free = 0
        for (const [dx, dy] of D4) {
          const nx = m.x + dx
          const ny = m.y + dy
          if (!terrOk(nx, ny) || (occ[ny * W + nx] && !(nx === x && ny === y))) continue
          free++
          const dd = dist({ x: nx, y: ny }, base)
          if (dd <= 1) s += 3
          else if (dd <= 2) s += 1
        }
        if (dist(m, base) <= 1) s -= 2 // 别占基地一圈
        if (free === 0) s -= 50
        if (s < worst) worst = s
      }
      // 领主自己四周要留路
      let lf = 0
      for (const [dx, dy] of D4) {
        const nx = x + dx
        const ny = y + dy
        if (terrOk(nx, ny) && !occ[ny * W + nx]) lf++
      }
      if (lf < 3) worst -= 20
      const score = worst * 10 - (Math.abs(x - lord.x) + Math.abs(y - lord.y)) * 0.3
      if (score > bs) {
        bs = score
        best = { x, y }
      }
    }
  }
  return best
}

// 领主跟军队的站位：离敌方塔 / 兵远一点，同时让尽量多的己方兵在视野 8 格内（吃光环）
function dangerAt(x: number, y: number, enemies: Entity[]): number {
  let p = 0
  for (const e of enemies) {
    const d = dist({ x, y }, e)
    if (e.type === "tower") {
      if (d <= 7) p += 100 - d * 5
    } else if (e.type === "archer") {
      if (d <= 6) p += 150 - d * 20
    } else if (e.type === "soldier") {
      if (d <= 5) p += 140 - d * 20
    }
  }
  return p
}

function chooseLordFollow(lord: Entity, ref: Entity, army: Entity[], enemies: Entity[], occ: Uint8Array): Pos | null {
  const W = game.width
  let best: Pos | null = null
  let bs = -1e9
  const R = 6
  for (let y = ref.y - R; y <= ref.y + R; y++)
    for (let x = ref.x - R; x <= ref.x + R; x++) {
      if (!inMap(x, y)) continue
      if (Math.abs(x - ref.x) + Math.abs(y - ref.y) > R) continue
      const own = x === lord.x && y === lord.y
      if (occ[y * W + x] && !own) continue
      let cov = 0
      for (const u of army) if (Math.abs(u.x - x) + Math.abs(u.y - y) <= 8) cov++
      const sc = cov * 3 - dangerAt(x, y, enemies) - (Math.abs(x - ref.x) + Math.abs(y - ref.y)) * 0.8 - (Math.abs(x - lord.x) + Math.abs(y - lord.y)) * 0.2
      if (sc > bs) {
        bs = sc
        best = { x, y }
      }
    }
  return best
}

function dangerHard(x: number, y: number, enemies: Entity[]): boolean {
  for (const e of enemies) {
    const d = dist({ x, y }, e)
    if (e.type === "tower" && d <= 7) return true
    if (e.type === "archer" && d <= 6) return true
    if (e.type === "soldier" && d <= 4) return true
  }
  return false
}

// 领主安全走位：在窗口里做带代价的最短路（危险格代价高），挑得分最高的格子，只走前 5 步
function lordSafeWalk(lord: Entity, ref: Entity, army: Entity[], enemies: Entity[], occS: Uint8Array, hp: number[]): Pos | null {
  const W = game.width
  const R = 14
  const near = enemies.filter((e) => (e.type === "tower" || e.type === "archer" || e.type === "soldier") && dist(e, lord) <= R + 8)
  const cost = new Map<number, number>()
  const parent = new Map<number, number>()
  const key = (x: number, y: number) => y * W + x
  const start = key(lord.x, lord.y)
  cost.set(start, 0)
  const queue: number[] = [start]
  const hardCache = new Map<number, boolean>()
  const hard = (x: number, y: number) => {
    const k = key(x, y)
    let v = hardCache.get(k)
    if (v === undefined) {
      v = dangerHard(x, y, near)
      hardCache.set(k, v)
    }
    return v
  }
  let qi = 0
  let guard = 0
  while (qi < queue.length && guard++ < 6000) {
    const k = queue[qi++]
    const cx = k % W
    const cy = (k - cx) / W
    const c = cost.get(k)!
    for (const [dx, dy] of D4) {
      const nx = cx + dx
      const ny = cy + dy
      if (!inMap(nx, ny) || occS[key(nx, ny)]) continue
      if (Math.abs(nx - lord.x) + Math.abs(ny - lord.y) > R) continue
      const nk = key(nx, ny)
      const nc = c + 1 + (hard(nx, ny) ? 6 : 0)
      const old = cost.get(nk)
      if (old === undefined || nc < old) {
        cost.set(nk, nc)
        parent.set(nk, k)
        queue.push(nk)
      }
    }
  }
  let best = -1
  let bs = -1e9
  for (const [k, c] of cost) {
    const x = k % W
    const y = (k - x) / W
    if (Math.abs(x - ref.x) + Math.abs(y - ref.y) > 7) continue
    let cov = 0
    for (const u of army) if (Math.abs(u.x - x) + Math.abs(u.y - y) <= 7) cov++
    const ahead = Math.max(0, hp[key(x, y)] - hp[key(ref.x, ref.y)])
    const sc = cov * 5 - dangerAt(x, y, near) - (hard(x, y) ? 200 : 0) - (Math.abs(x - ref.x) + Math.abs(y - ref.y)) * 0.3 - c * 0.15 - ahead * 0.8
    if (sc > bs) {
      bs = sc
      best = k
    }
  }
  if (best < 0 || best === start) return null
  // 回溯路径，取离起点 5 步处
  const path: number[] = []
  let cur = best
  while (cur !== start && parent.has(cur)) {
    path.push(cur)
    cur = parent.get(cur)!
  }
  path.reverse()
  const wpk = path[Math.min(path.length - 1, 4)]
  return { x: wpk % W, y: (wpk - (wpk % W)) / W }
}

// 路线代价：到目标的最短代价，偏离地图对角线略加价（让路线走中间而不是贴边穿过对手的分矿），已知敌塔 7 格内大幅加价
function computeRouteCost(goal: Pos, towers: Pos[]): number[] {
  const W = game.width
  const H = game.height
  const cost: number[] = new Array(W * H).fill(Infinity)
  const step = new Float64Array(W * H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!terrOk(x, y)) {
        step[y * W + x] = -1
        continue
      }
      const dev = Math.abs(x / (W - 1) - y / (H - 1)) * 20
      let c = 1 + 0.01 * dev
      for (const t of towers) if (Math.abs(x - t.x) + Math.abs(y - t.y) <= 7) c += 6
      step[y * W + x] = c
    }
  cost[goal.y * W + goal.x] = 0
  const queue: number[] = [goal.y * W + goal.x]
  let qi = 0
  let guard = 0
  while (qi < queue.length && guard++ < 60000) {
    const k = queue[qi++]
    const cx = k % W
    const cy = (k - cx) / W
    const c = cost[k]
    for (const [dx, dy] of D4) {
      const nx = cx + dx
      const ny = cy + dy
      if (!inMap(nx, ny)) continue
      const nk = ny * W + nx
      if (step[nk] < 0) continue
      const nc = c + step[k >= 0 ? nk : nk]
      if (nc < cost[nk] - 1e-9) {
        cost[nk] = nc
        queue.push(nk)
      }
    }
  }
  return cost
}
