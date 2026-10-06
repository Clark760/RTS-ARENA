// 稳守（按需回防）：开局派 1 个工人进点搅局，点附近的敌人（连蹲点的工人）见一个清一个；家里来敌人只派够用的兵回去，不被诱饵调走。
// 工人补到 10 个；先出 4 个战士，之后战士、弓手交替；点附近的敌兵比自己多就退到点和家之间等援兵，落后 100 分以上就不等了。

const MAX_WORKERS = 10
const EARLY_SOLDIERS = 4
/** 看到过的敌方战斗单位，最后一次看见的 tick（估计对方兵力） */
const seen = new Map<number, number>()
const SEEN_FOR = 500
let produced = 0
/** 进点搅局的工人 */
let denier: number | null = null

const isCombat = (e: Entity) => e.type === "soldier" || e.type === "archer"

function nearest<T extends Pos>(from: Pos, list: T[]): T | undefined {
  let best: T | undefined
  let bestD = Infinity
  for (const e of list) {
    const d = dist(from, e)
    if (d < bestD) {
      best = e
      bestD = d
    }
  }
  return best
}

function attack(cmd: Commands, u: Entity, t: Entity): void {
  if (u.order?.kind !== "attack" || u.order.target !== t.id) cmd.attack(u, t)
}

function attackMove(cmd: Commands, u: Entity, p: Pos): void {
  if (u.order?.kind !== "attackMove" || u.order.x !== p.x || u.order.y !== p.y) cmd.attackMove(u, p.x, p.y)
}

export function onTick(view: View, cmd: Commands): void {
  const mine = view.entities.filter((e) => e.owner === view.me)
  const enemies = view.entities.filter((e) => e.owner >= 0 && e.owner !== view.me)
  const base = mine.find((e) => e.type === "base")
  if (!base) return
  const barracks = mine.find((e) => e.type === "barracks")
  const workers = mine.filter((e) => e.type === "worker")
  const army = mine.filter(isCombat)
  const goldmines = view.entities.filter((e) => e.type === "goldmine")
  const zone = view.objectives.zone
  const center = { x: zone.x + Math.floor(zone.w / 2), y: zone.y + Math.floor(zone.h / 2) }
  const home = { x: base.x + 1, y: base.y + 1 }
  const fallback = { x: Math.round((center.x + home.x) / 2), y: Math.round((center.y + home.y) / 2) }
  let gold = view.resources.gold

  for (const e of enemies) if (isCombat(e)) seen.set(e.id, view.tick)
  for (const ev of view.events) if (ev.kind === "died") seen.delete(ev.id)
  for (const [id, t] of seen) if (view.tick - t > SEEN_FOR) seen.delete(id)
  const enemyArmy = seen.size

  // ---------- 经济和生产 ----------
  // 搅局：一个工人站进点里（双方都在点里谁也不得分），死了就再派；点里有自己的兵就回去采矿
  const inZone = (e: Pos) => e.x >= zone.x && e.x < zone.x + zone.w && e.y >= zone.y && e.y < zone.y + zone.h
  const ownInZone = army.filter(inZone).length
  if (denier !== null && !workers.some((w) => w.id === denier)) denier = null
  if (ownInZone >= 2) denier = null
  else if (denier === null && workers.length >= 4) denier = nearest(center, workers.filter((w) => w.order?.kind !== "attack"))?.id ?? null
  const d = workers.find((w) => w.id === denier)
  if (d && !inZone(d) && (d.order?.kind !== "move" || d.order.x !== center.x || d.order.y !== center.y)) cmd.move(d, center.x, center.y)

  const load = new Map<number, number>()
  for (const w of workers) if (w.order?.kind === "gather") load.set(w.order.target, (load.get(w.order.target) ?? 0) + 1)
  for (const w of workers) {
    if (w.id === denier || w.order?.kind === "gather" || w.order?.kind === "attack") continue
    const open = goldmines.filter((m) => (load.get(m.id) ?? 0) < 3)
    const m = nearest(base, open.length ? open : goldmines)
    if (!m) continue
    cmd.gather(w, m)
    load.set(m.id, (load.get(m.id) ?? 0) + 1)
  }
  // 工人到 6 个以后兵营优先：补工人要留够下一个兵的钱（不然死了搅局的工人就补，兵永远出不来）
  const nextCost = game.types[produced < EARLY_SOLDIERS || produced % 2 === 0 ? "soldier" : "archer"].cost.gold ?? 0
  const reserve = workers.length >= 6 && barracks && (barracks.queue?.length ?? 0) < 2 ? nextCost : 0
  if ((base.queue?.length ?? 0) === 0 && workers.length < MAX_WORKERS && gold - reserve >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }
  if (barracks && (barracks.queue?.length ?? 0) < 2) {
    const type: TypeName = produced < EARLY_SOLDIERS || produced % 2 === 0 ? "soldier" : "archer"
    const cost = game.types[type].cost.gold ?? 0
    if (gold >= cost) {
      cmd.produce(barracks, type)
      gold -= cost
      produced++
    }
  }

  // ---------- 回防：来几个派几个（威胁的两倍、至少 1 个），离家最近的去；兵不够时附近的工人帮忙 ----------
  const intruders = enemies.filter((e) => game.types[e.type].kind === "unit" && (dist(e, base) <= 10 || (barracks && dist(e, barracks) <= 7) || workers.some((w) => dist(w, e) <= 3)))
  const threat = intruders.filter(isCombat).length + Math.ceil(intruders.filter((e) => !isCombat(e)).length / 2)
  const defenders = new Set<number>()
  if (intruders.length > 0) {
    const need = Math.min(army.length, Math.max(1, threat * 2))
    for (const u of [...army].sort((a, b) => dist(a, base) - dist(b, base)).slice(0, need)) {
      attack(cmd, u, nearest(u, intruders)!)
      defenders.add(u.id)
    }
    if (threat > army.length)
      for (const w of workers) {
        const t = intruders.find((e) => dist(e, w) <= 2)
        if (t) attack(cmd, w, t)
      }
  }

  // ---------- 控制点：点附近 8 格内的敌人见一个清一个（包括蹲点的工人），不追出去；点附近的敌兵比自己多就退到中间等援兵 ----------
  const field = army.filter((u) => !defenders.has(u.id))
  const nearZone = enemies.filter((e) => game.types[e.type].kind === "unit" && dist(e, center) <= 8)
  const foes = nearZone.filter(isCombat).length
  const pts = view.objectives.points
  const behind = Math.max(...pts.filter((_, i) => i !== view.me)) - pts[view.me] >= 100
  const strong = field.length >= Math.max(1, foes) || behind
  field.forEach((u, i) => {
    const t = nearest(u, nearZone)
    if (strong) {
      if (t) return attack(cmd, u, t)
      const spot = { x: zone.x + (i % zone.w), y: zone.y + (Math.floor(i / zone.w) % zone.h) }
      if (!inZone(u)) attackMove(cmd, u, spot)
      return
    }
    // 打不过：点里只有工人时照样去清，有敌兵就退
    if (t && foes === 0) return attack(cmd, u, t)
    if (dist(u, fallback) > 2) attackMove(cmd, u, fallback)
  })
  if (view.tick % 500 === 0) console.log(`控制分 ${pts.join(" : ")}，兵力 ${army.length}（估计对方 ${enemyArmy}）`)
}
