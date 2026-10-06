// 速攻：工人采家门口的矿，兵营一直出战士，凑够 6 个就全体压向对方主基地。

const MAX_WORKERS = 8
const WAVE = 6
let attacking = false

function nearest<T extends Pos>(from: Pos, list: T[]): T | undefined {
  let best: T | undefined
  for (const e of list) if (!best || dist(from, e) < dist(from, best)) best = e
  return best
}

export function onTick(view: View, cmd: Commands): void {
  const mine = view.entities.filter((e) => e.owner === view.me)
  const base = mine.find((e) => e.type === "base")
  const barracks = mine.find((e) => e.type === "barracks")
  const workers = mine.filter((e) => e.type === "worker")
  const army = mine.filter((e) => e.type === "soldier" || e.type === "archer")
  const goldmines = view.entities.filter((e) => e.type === "goldmine")
  let gold = view.resources.gold

  // 闲着的工人去采离自己最近的矿
  for (const w of workers) {
    if (w.order?.kind !== "idle") continue
    const m = nearest(w, goldmines)
    if (m) cmd.gather(w, m)
  }

  // 主基地补工人（同一时间只排一个）
  if (base && base.queue?.length === 0 && workers.length < MAX_WORKERS && gold >= 50) {
    cmd.produce(base, "worker")
    gold -= 50
  }

  // 兵营一直出战士
  if (barracks && (barracks.queue?.length ?? 0) < 2 && gold >= 75) {
    cmd.produce(barracks, "soldier")
    gold -= 75
  }

  // 够数了就进攻；之后新出的兵直接跟上
  if (army.length >= WAVE) attacking = true
  if (attacking) {
    const target = view.objectives.enemyBases[0]
    for (const u of army) {
      if (u.order?.kind === "idle") cmd.attackMove(u, target.x + 1, target.y + 1)
    }
  }
}
