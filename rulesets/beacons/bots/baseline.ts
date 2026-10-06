// 基准（均衡）：工人 9 个，从自家门口到中央、再到对方那侧一块块建烽火台；战士先守家、清怪，再拆对方的烽火台，兵多了拆主基地。
// 细节：
// 经济：工人补到 9 个，按离家远近分到金矿（每矿最多 3 人）。
// 烽火台：按 自家台址 → 自家一侧野怪窝 → 中央 → 对方野怪窝 → 对方门口 的顺序，一次派一个工人去建，没建好的有人接着建。
// 军队：兵营一直出战士；先守家和自己的烽火台，再清自己这侧的野怪、中央守卫，然后去拆对方的烽火台，兵多了拆主基地。

const BEACON_COST = game.types.beacon.cost.gold ?? 75

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

function inSite(e: Entity, s: Site): boolean {
  return e.x >= s.x && e.y >= s.y && e.x + e.w <= s.x + s.w && e.y + e.h <= s.y + s.h
}

/** 台址中间的格子；偶数边长时两家各取靠自己的那格，保证两边对称 */
function siteCenter(s: Site): Pos {
  if (game.me === 0) return { x: s.x + Math.floor((s.w - 1) / 2), y: s.y + Math.floor((s.h - 1) / 2) }
  return { x: s.x + s.w - 1 - Math.floor((s.w - 1) / 2), y: s.y + s.h - 1 - Math.floor((s.h - 1) / 2) }
}

/** 台址里能放烽火台的位置（按离 from 近排） */
function buildSpot(view: View, s: Site, from: Pos): Pos | undefined {
  const spots: Pos[] = []
  for (let y = s.y; y + 2 <= s.y + s.h; y++)
    for (let x = s.x; x + 2 <= s.x + s.w; x++) if (canBuild(view, "beacon", x, y)) spots.push({ x, y })
  // 玩家 1 倒着找，这样两边一样近时挑的是对称的位置
  if (view.me === 1) spots.reverse()
  return nearest(from, spots)
}

/** 地图中心对称的位置（玩家 1 用） */
function mirror(p: Pos): Pos {
  return { x: game.width - 1 - p.x, y: game.height - 1 - p.y }
}

export function onTick(view: View, cmd: Commands): void {
  const me = view.me
  const enemy = 1 - me
  const mine = view.entities.filter((e) => e.owner === me)
  const base = mine.find((e) => e.type === "base")
  if (!base) return
  const barracks = mine.filter((e) => e.type === "barracks" && !e.construction)
  const workers = mine.filter((e) => e.type === "worker")
  const army = mine.filter((e) => e.type === "soldier" || e.type === "archer")
  const myBeacons = mine.filter((e) => e.type === "beacon")
  const mines = view.entities.filter((e) => e.type === "goldmine")
  const enemies = view.entities.filter((e) => e.owner >= 0 && e.owner !== me)
  const monsters = view.entities.filter((e) => e.owner === -1 && (e.type === "beast" || e.type === "guardian"))
  const sites = view.objectives.sites
  const byName = (n: string) => sites.find((s) => s.name === n)!
  let gold = view.resources.gold

  for (const ev of view.events) if (ev.kind === "rejected") console.log("被拒", JSON.stringify(ev.command), ev.reason)

  // ---------- 烽火台 ----------
  const order = [byName("home" + me), byName("flank" + me), byName("center"), byName("flank" + enemy), byName("home" + enemy)]
  const builders = new Set<number>()
  for (const w of workers) if (w.order?.kind === "build") builders.add(w.id)
  // 没建好、也没人建的地基：派最近的工人接着建
  for (const b of myBeacons) {
    if (!b.construction) continue
    const someone = workers.some((w) => w.order?.kind === "build" && w.order.target === b.id)
    if (someone) continue
    const w = nearest(b, workers.filter((w) => !builders.has(w.id)))
    if (w) {
      cmd.build(w, "beacon", b.x, b.y)
      builders.add(w.id)
    }
  }
  // 下一个要建的台址：没有我的烽火台（含地基）、没有野怪
  // 对方那一侧的台址等兵够了再去建
  const allowed = army.length >= 6 ? order : order.slice(0, 3)
  const want = allowed.find((s) => s.monsters === 0 && !myBeacons.some((b) => inSite(b, s)))
  if (want && builders.size === 0 && workers.length >= 4) {
    const w = nearest(siteCenter(want), workers)
    if (w) {
      const spot = buildSpot(view, want, w)
      if (spot && gold >= BEACON_COST) {
        cmd.build(w, "beacon", spot.x, spot.y)
        gold -= BEACON_COST
        builders.add(w.id)
      } else if (!spot && dist(w, siteCenter(want)) > 2) {
        // 看不见台址就先走过去
        cmd.move(w, siteCenter(want).x, siteCenter(want).y)
        builders.add(w.id)
      }
    }
  }

  // ---------- 生产 ----------
  if ((base.queue?.length ?? 0) === 0 && workers.length < 9 && gold >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }
  // 还有野怪时出弓箭手（野怪不会动，弓箭手在射程外打它们不掉血），之后战士、弓箭手对半
  const reserve = want && myBeacons.every((b) => !b.construction) ? BEACON_COST : 0
  const archerCount = army.filter((e) => e.type === "archer").length
  const monstersLeft = byName("flank" + me).monsters + byName("center").monsters > 0
  for (const b of barracks) {
    const kind: TypeName = monstersLeft || archerCount * 2 < army.length ? "archer" : "soldier"
    const cost = game.types[kind].cost.gold ?? 80
    if ((b.queue?.length ?? 0) === 0 && workers.length >= 5 && gold - reserve >= cost) {
      cmd.produce(b, kind)
      gold -= cost
    }
  }

  // ---------- 采集 ----------
  const load = new Map<number, number>()
  for (const w of workers) if (w.order?.kind === "gather") load.set(w.order.target, (load.get(w.order.target) ?? 0) + 1)
  for (const w of workers) {
    if (builders.has(w.id)) continue
    if (w.order?.kind === "gather" && mines.some((m) => m.id === (w.order as { target: number }).target)) continue
    if (w.order?.kind === "move") continue
    const open = mines.filter((m) => (load.get(m.id) ?? 0) < 3)
    const m = nearest(base, open)
    if (!m) continue
    cmd.gather(w, m)
    load.set(m.id, (load.get(m.id) ?? 0) + 1)
  }

  // ---------- 军队 ----------
  if (army.length === 0) return
  const guarded: Entity[] = [base, ...myBeacons]
  const threat = enemies.find((e) => guarded.some((g) => dist(e, g) <= 6))
  const myFlank = byName("flank" + me)
  const center = byName("center")
  const enemyBeacons = enemies.filter((e) => e.type === "beacon")
  const enemySites = sites.filter((s) => s.holder === enemy || s.holder === -2)
  let goal: Entity | Pos
  let mode = ""
  if (threat) {
    goal = threat
    mode = "守"
  } else if (myFlank.monsters > 0 && archerCount >= 2) {
    goal = monsters.find((m) => inSite(m, myFlank)) ?? siteCenter(myFlank)
    mode = "清侧"
  } else if (center.monsters > 0 && archerCount >= 4) {
    goal = monsters.find((m) => inSite(m, center)) ?? siteCenter(center)
    mode = "清中"
  } else if (enemyBeacons.length > 0 && army.length >= 5) {
    goal = nearest(army[0], enemyBeacons)!
    mode = "拆台"
  } else if (enemySites.length > 0 && army.length >= 5) {
    goal = siteCenter(nearest(army[0], enemySites)!)
    mode = "找台"
  } else if (army.length >= 14) {
    const eb = view.objectives.enemyBase
    goal = { x: eb.x + 1, y: eb.y + 1 }
    mode = "拆家"
  } else {
    // 集结在中央台址靠自己家的一侧，别站进台址里挡住建造
    goal = me === 0 ? { x: 13, y: 8 } : mirror({ x: 13, y: 8 })
    mode = "集结"
  }
  for (const s of army) {
    if ("id" in goal) {
      const target = goal as Entity
      if (s.order?.kind === "attack" && s.order.target === target.id) continue
      if (target.owner === -1) {
        // 野怪只让弓箭手打，战士在一旁等
        if (s.type === "archer" || archerCount === 0) cmd.attack(s, target)
        else if (dist(s, target) > 4 && s.order?.kind !== "move") cmd.move(s, target.x + (me === 0 ? -3 : 3), target.y)
      }
      else if (dist(s, target) <= 8) cmd.attack(s, target)
      else cmd.attackMove(s, target.x, target.y)
    } else {
      const p = goal as Pos
      if (dist(s, p) <= 2 && s.order?.kind === "idle") continue
      if (s.order?.kind === "attackMove" && s.order.x === p.x && s.order.y === p.y) continue
      if (s.order?.kind === "attack") continue
      cmd.attackMove(s, p.x, p.y)
    }
  }
  if (view.tick % 200 === 0) console.log(mode, "army", army.length, "gold", view.resources.gold)
}
