// 偷旗：5 个工人采金，兵营先出 2 个战士守旗台，之后只出弓手；弓手三个一组、路上不打架，沿地图边绕开中央的巨魔去扛最近的敌旗，扛到后旗手绕边回家、另外两个跟着射追兵。

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

function isEnemy(owner: number): boolean {
  return owner >= 0 && game.teams[owner] !== game.teams[game.me]
}

/** 从 a 到 b 绕开地图中央的拐点：两个 L 形拐角里离中心远的那个 */
function corner(a: Pos, b: Pos): Pos {
  const c1 = { x: a.x, y: b.y }
  const c2 = { x: b.x, y: a.y }
  const mid = { x: game.width / 2, y: game.height / 2 }
  return dist(c1, mid) >= dist(c2, mid) ? c1 : c2
}

/** 先走到拐点，再去终点（已经比拐点离终点近就直接去） */
function via(cmd: Commands, u: Entity, wp: Pos, to: Pos): void {
  const goal = dist(u, wp) > 2 && dist(u, to) > dist(wp, to) ? wp : to
  if (u.order?.kind !== "move" || u.order.x !== goal.x || u.order.y !== goal.y) cmd.move(u, goal.x, goal.y)
}

export function onTick(view: View, cmd: Commands): void {
  const o = view.objectives
  const mine = view.entities.filter((e) => e.owner === view.me)
  const base = mine.find((e) => e.type === "base")
  if (!base) return
  const stand = o.stands[view.me]
  const barracks = mine.find((e) => e.type === "barracks")
  const workers = mine.filter((e) => e.type === "worker")
  const soldiers = mine.filter((e) => e.type === "soldier")
  const archers = mine.filter((e) => e.type === "archer").sort((a, b) => a.id - b.id)
  const mines = view.entities.filter((e) => e.type === "goldmine" && (e.amount ?? 0) > 0)
  let gold = view.resources.gold

  if (workers.length < 5 && (base.queue?.length ?? 0) === 0 && gold >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }
  if (barracks && (barracks.queue?.length ?? 0) < 2) {
    const type = soldiers.length < 2 ? "soldier" : "archer"
    if (gold >= 80) cmd.produce(barracks, type)
  }
  const carriers = new Set(o.flags.filter((f) => f.state === "carried" && f.carrierOwner === view.me).map((f) => f.carrier!))
  for (const w of workers) {
    if (carriers.has(w.id)) continue
    if (w.order?.kind !== "gather") {
      const m = nearest(base, mines)
      if (m) cmd.gather(w, m)
    }
  }

  // 扛着旗的：绕边回家
  const targets = o.flags.filter((f) => isEnemy(f.owner) && (f.state === "home" || f.state === "dropped"))
  for (const u of mine) {
    if (!carriers.has(u.id)) continue
    const from = nearest(u, o.stands.filter((s) => isEnemy(s.owner))) ?? u
    via(cmd, u, corner(stand, from), stand)
  }

  // 战士守家
  const myFlag = o.flags[view.me]
  for (const s of soldiers) {
    if (carriers.has(s.id)) continue
    const threat = view.entities.find((e) => isEnemy(e.owner) && dist(e, stand) <= 7)
    if (myFlag.state === "dropped") cmd.move(s, myFlag.x, myFlag.y)
    else if (threat) {
      if (s.order?.kind !== "attack") cmd.attack(s, threat)
    } else if (dist(s, stand) > 3 && s.order?.kind === "idle") cmd.attackMove(s, stand.x, stand.y)
  }

  // 弓手三个一组：有人扛着旗就护送（射旗手附近的敌人），否则去偷
  for (let i = 0; i + 2 < archers.length; i += 3) {
    const group = archers.slice(i, i + 3)
    const c = group.find((a) => carriers.has(a.id))
    if (c) {
      const chaser = view.entities.find((e) => isEnemy(e.owner) && e.type !== "flag" && dist(e, c) <= 5)
      for (const a of group) {
        if (a === c) continue
        if (chaser) {
          if (a.order?.kind !== "attack") cmd.attack(a, chaser)
        } else if (dist(a, c) > 2) cmd.move(a, c.x, c.y)
      }
      continue
    }
    const t = nearest(group[0], targets)
    if (!t) break
    const wp = corner(stand, t)
    for (const a of group) via(cmd, a, wp, t)
  }
}
