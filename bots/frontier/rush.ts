// 拓荒的速攻示例：开局 5 个工人一起建兵营（约 50 tick 建好），只出战士，凑够 4 个就去拆对方主基地。
// 不补工人、不建箭塔和仓库，打的是对手还没建好防御的时间差。

const WAVE = 4
let sent = new Set<number>()

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

export function onTick(view: View, cmd: Commands): void {
  const mine = view.entities.filter((e) => e.owner === view.me)
  const base = mine.find((e) => e.type === "base")
  if (!base) return
  const workers = mine.filter((e) => e.type === "worker")
  const barracks = mine.find((e) => e.type === "barracks")
  const soldiers = mine.filter((e) => e.type === "soldier")
  const eb = view.objectives.enemyBases[0]
  const target = { x: eb.x + 1, y: eb.y + 1 }

  if (!barracks) {
    // 主基地右下角外面找一块空地
    for (let r = 0; r < 6; r++) {
      const x = base.x + base.w + 1 + r
      const y = base.y + base.h - 1 + r
      if (canBuild(view, "barracks", x, y)) {
        for (const w of workers) cmd.build(w, "barracks", x, y)
        return
      }
    }
    return
  }
  if (barracks.construction) {
    for (const w of workers) if (w.order?.kind !== "build") cmd.build(w, "barracks", barracks.x, barracks.y)
    return
  }

  // 工人采最近的金矿
  const mines = view.entities.filter((e) => e.type === "goldmine")
  for (const w of workers) if (w.order?.kind !== "gather") {
    const m = nearest(base, mines)
    if (m) cmd.gather(w, m)
  }

  if ((barracks.queue?.length ?? 0) === 0 && view.resources.gold >= 75) cmd.produce(barracks, "soldier")

  sent = new Set([...sent].filter((id) => soldiers.some((s) => s.id === id)))
  const waiting = soldiers.filter((s) => !sent.has(s.id))
  if (waiting.length >= WAVE)
    for (const s of waiting) {
      cmd.attackMove(s, target.x, target.y)
      sent.add(s.id)
    }
  // 到了对方家门口就直接打主基地
  const enemyBase = view.entities.find((e) => e.type === "base" && e.owner !== view.me)
  if (enemyBase) for (const s of soldiers) if (sent.has(s.id) && dist(s, enemyBase) <= 6 && s.order?.kind !== "attack") cmd.attack(s, enemyBase)
}
