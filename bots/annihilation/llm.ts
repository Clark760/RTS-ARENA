// 外部大模型试写的 bot（2026-10-06）：子代理只读了 PROMPT.md、看不到引擎源码和其他示例，迭代 2 轮写成，
// 对 rush、boom 都是 10:0。原样收录作为更强的基准；里面"矿不在视野里先走过去"的处理是当时规则下的绕法，
// 现在资源点始终可见（D-110），那段不会再触发。

// 歼灭 bot：经济 + 兵营持续出兵，家门口防守，攒够兵后集体进攻敌方主基地。

const W = game.width
const H = game.height
const ME = game.me

// ---------- 记忆 ----------
interface MineInfo { id: number; x: number; y: number; amount: number }
const mines = new Map<number, MineInfo>()
const workerMine = new Map<number, number>() // 工人 id -> 金矿 id
let mode: "defend" | "attack" = "defend"
let rally: Pos | null = null
let stage: Pos | null = null
let lastThreatTick = -9999
let attackWaves = 0

function walkable(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= W || y >= H) return false
  return game.walkable[game.terrain[y][x]] === true
}

function center(e: Entity): Pos {
  return { x: e.x + Math.floor(e.w / 2), y: e.y + Math.floor(e.h / 2) }
}

function nearestWalkable(p: Pos, blocked: Set<number>): Pos {
  for (let r = 0; r < 10; r++) {
    for (let dx = -r; dx <= r; dx++) {
      const dy1 = r - Math.abs(dx)
      for (const dy of dy1 === 0 ? [0] : [dy1, -dy1]) {
        const x = p.x + dx, y = p.y + dy
        if (walkable(x, y) && !blocked.has(y * W + x)) return { x, y }
      }
    }
  }
  return p
}

function isCombat(t: TypeName): boolean {
  return t === "soldier" || t === "archer"
}

export function onTick(view: View, cmd: Commands): void {
  const ents = view.entities
  const mine: Entity[] = []
  const enemies: Entity[] = []
  const blocked = new Set<number>()
  let base: Entity | null = null
  let barracks: Entity | null = null
  let enemyBase: Entity | null = null
  let enemyBarracks: Entity | null = null

  const visibleMines = new Set<number>()
  for (const e of ents) {
    if (e.type === "goldmine") {
      mines.set(e.id, { id: e.id, x: e.x, y: e.y, amount: e.amount ?? 0 })
      visibleMines.add(e.id)
    }
    if (game.types[e.type].kind !== "unit") {
      for (let dx = 0; dx < e.w; dx++) for (let dy = 0; dy < e.h; dy++) blocked.add((e.y + dy) * W + e.x + dx)
    }
    if (e.owner === ME) {
      mine.push(e)
      if (e.type === "base") base = e
      if (e.type === "barracks") barracks = e
    } else if (e.owner >= 0) {
      enemies.push(e)
      if (e.type === "base") enemyBase = e
      if (e.type === "barracks") enemyBarracks = e
    }
  }
  for (const ev of view.events) {
    if (ev.kind === "died" && ev.type === "goldmine") mines.delete(ev.id)
    if (ev.kind === "botError") console.log("ERR " + ev.message)
    if (ev.kind === "rejected") console.log("REJ " + ev.reason + " " + JSON.stringify(ev.command))
  }
  if (!base) return

  const eb = view.objectives.enemyBases[0]
  const enemyBaseCenter: Pos = { x: eb.x + 1, y: eb.y + 1 }
  const baseC = center(base)

  if (!rally) {
    const anchor = barracks ? center(barracks) : baseC
    const dx = enemyBaseCenter.x - anchor.x, dy = enemyBaseCenter.y - anchor.y
    const len = Math.abs(dx) + Math.abs(dy) || 1
    rally = nearestWalkable({ x: Math.round(anchor.x + (dx / len) * 4), y: Math.round(anchor.y + (dy / len) * 4) }, blocked)
    stage = rally
  }

  const workers = mine.filter((e) => e.type === "worker")
  const army = mine.filter((e) => isCombat(e.type))
  const enemyUnits = enemies.filter((e) => game.types[e.type].kind === "unit")
  const enemyArmy = enemyUnits.filter((e) => isCombat(e.type))

  // ---------- 生产 ----------
  let gold = view.resources.gold
  const unitCount = workers.length + army.length + (base.queue?.length ?? 0) + (barracks?.queue?.length ?? 0)
  let cap = game.unitCap > 0 ? game.unitCap - unitCount : 999
  const targetWorkers = 10
  if (barracks && (barracks.queue?.length ?? 0) === 0 && cap > 0) {
    const t: TypeName = "soldier"
    const cost = game.types[t].cost.gold ?? 0
    if (gold >= cost) {
      cmd.produce(barracks, t)
      gold -= cost
      cap--
    }
  }
  const knownGold = [...mines.values()].reduce((s, m) => s + m.amount, 0)
  if ((base.queue?.length ?? 0) === 0 && workers.length < targetWorkers && cap > 0 && gold >= 50 && knownGold > 0) {
    cmd.produce(base, "worker")
    gold -= 50
  }

  // ---------- 威胁 ----------
  const threats = enemyUnits.filter((e) => {
    if (dist(e, base!) <= 12) return true
    if (barracks && dist(e, barracks) <= 9) return true
    for (const w of workers) if (dist(e, w) <= 5) return true
    return false
  })
  if (threats.length > 0) lastThreatTick = view.tick

  // ---------- 工人 ----------
  const mineCount = new Map<number, number>()
  for (const [wid, mid] of workerMine) {
    if (!workers.some((w) => w.id === wid) || !mines.has(mid)) { workerMine.delete(wid); continue }
    mineCount.set(mid, (mineCount.get(mid) ?? 0) + 1)
  }
  for (const w of workers) {
    // 自卫：敌人贴脸且我方军队不足时还手
    const near = threats.filter((t) => dist(t, w) <= 2)
    if (near.length > 0 && army.length < threats.length) {
      const t = near.reduce((a, b) => (a.hp <= b.hp ? a : b))
      cmd.attack(w, t)
      workerMine.delete(w.id)
      continue
    }
    const assigned = workerMine.get(w.id)
    const o = w.order
    if (assigned !== undefined && o && o.kind === "gather" && o.target === assigned) continue
    // 已分配但金矿不在视野里：gather 会被拒（"看不到资源点"），先走过去，看见了再采
    if (assigned !== undefined && mines.has(assigned)) {
      const m = mines.get(assigned)!
      if (visibleMines.has(assigned)) { cmd.gather(w, assigned); continue }
      if (o && o.kind === "move" && o.x === m.x && o.y === m.y) continue
    }
    // 重新分配
    let best: MineInfo | null = null
    let bestScore = Infinity
    for (const m of mines.values()) {
      if (m.amount <= 0) continue
      const c = mineCount.get(m.id) ?? 0
      if (c >= 3) continue
      const s = dist(base, m) * 2 + c * 3
      if (s < bestScore) { bestScore = s; best = m }
    }
    if (best) {
      if (assigned !== undefined) mineCount.set(assigned, (mineCount.get(assigned) ?? 1) - 1)
      workerMine.set(w.id, best.id)
      mineCount.set(best.id, (mineCount.get(best.id) ?? 0) + 1)
      if (visibleMines.has(best.id)) cmd.gather(w, best.id)
      else cmd.move(w, best.x, best.y)
    } else if (o?.kind === "idle") {
      // 没有已知金矿：往地图中央探索
      cmd.move(w, Math.floor(W / 2), Math.floor(H / 2))
    }
  }

  // ---------- 军队 ----------
  const attackThreshold = 8
  if (mode === "defend" && army.length >= attackThreshold && threats.length === 0) {
    mode = "attack"
    attackWaves++
  }
  if (mode === "attack" && army.length < 3) mode = "defend"

  for (const u of army) {
    const td = game.types[u.type]
    const range = td.attack!.range
    let pool: Entity[]
    if (mode === "defend") {
      pool = threats.filter((e) => dist(e, u) <= 16)
    } else {
      pool = enemyUnits.filter((e) => dist(e, u) <= td.sight + 2)
    }
    let target: Entity | null = null
    let bestS = Infinity
    for (const e of pool) {
      const d = dist(u, e)
      let s: number
      if (d <= range) s = -1000 + e.hp
      else s = d * 20 + e.hp / 10
      if (!isCombat(e.type)) s += 40
      if (s < bestS) { bestS = s; target = e }
    }
    if (target) {
      const o = u.order
      if (!(o && o.kind === "attack" && o.target === target.id)) cmd.attack(u, target)
      continue
    }
    if (mode === "attack") {
      const goal = enemyBase ?? null
      if (goal && dist(u, goal) <= td.sight) {
        const o = u.order
        if (!(o && o.kind === "attack" && o.target === goal.id)) cmd.attack(u, goal)
      } else {
        const o = u.order
        if (!(o && o.kind === "attackMove" && o.x === enemyBaseCenter.x && o.y === enemyBaseCenter.y))
          cmd.attackMove(u, enemyBaseCenter.x, enemyBaseCenter.y)
      }
    } else {
      if (dist(u, rally!) > 3) {
        const o = u.order
        if (!(o && o.kind === "attackMove" && o.x === rally!.x && o.y === rally!.y)) cmd.attackMove(u, rally!.x, rally!.y)
      }
    }
  }

  if (view.tick % 250 === 0) {
    console.log(`t=${view.tick} gold=${view.resources.gold} w=${workers.length} army=${army.length} mode=${mode} enemyArmySeen=${enemyArmy.length} mines=${mines.size}`)
  }
}
