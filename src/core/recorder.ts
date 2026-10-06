// 回放记录：每 tick 和上一 tick 比较，只记变化
import type { Order } from "../api/bot-api.ts"
import type { EntityState, EntSnap, Frame, PlayerSnap, Snapshot } from "./types.ts"
import type { World } from "./world.ts"

export function orderText(e: EntityState): string {
  const o: Order = e.order
  switch (o.kind) {
    case "idle":
      return "idle"
    case "move":
      return `move (${o.x},${o.y})`
    case "attack":
      return `attack #${o.target}`
    case "attackMove":
      return `attackMove (${o.x},${o.y})`
    case "gather":
      return o.returning ? `gather #${o.target} 回程` : `gather #${o.target}`
    case "build":
      return `build #${o.target}`
  }
}

function snapOf(e: EntityState): EntSnap {
  const s: EntSnap = { id: e.id, type: e.type, owner: e.owner, x: e.x, y: e.y, hp: e.def.kind === "resource" ? e.amount : e.hp, ord: orderText(e) }
  if (e.construction) s.bp = Math.floor((100 * e.construction.done) / e.construction.total)
  return s
}

function playerSnaps(w: World): PlayerSnap[] {
  return w.players.map((p) => ({ resources: { ...p.resources }, score: p.score, alive: p.alive }))
}

export class Recorder {
  private last = new Map<number, EntSnap>()
  private lastPlayers: string
  private lastMarkers: string
  private lastStatus: string
  readonly frames: Frame[] = []
  readonly initial: Snapshot

  constructor(w: World) {
    for (const e of w.ents.values()) this.last.set(e.id, snapOf(e))
    const players = playerSnaps(w)
    this.lastPlayers = JSON.stringify(players)
    this.lastMarkers = JSON.stringify(w.markers)
    this.lastStatus = w.status
    this.initial = { entities: [...this.last.values()], players, markers: JSON.parse(this.lastMarkers), status: w.status }
  }

  /** 记录一 tick 的变化；logs、errs 由对局循环填 */
  record(w: World, extra: Pick<Frame, "logs" | "errs">): void {
    const f: Frame = { t: w.tick }
    const spawn: EntSnap[] = []
    const move: number[] = []
    const hp: number[] = []
    const ord: [number, string][] = []
    const bp: number[] = []
    for (const e of w.ents.values()) {
      const prev = this.last.get(e.id)
      const cur = snapOf(e)
      if (!prev) {
        spawn.push(cur)
        this.last.set(e.id, cur)
        continue
      }
      if (prev.x !== cur.x || prev.y !== cur.y) move.push(e.id, cur.x, cur.y)
      if (prev.hp !== cur.hp) hp.push(e.id, cur.hp)
      if (prev.ord !== cur.ord) ord.push([e.id, cur.ord])
      if (prev.bp !== cur.bp) bp.push(e.id, cur.bp ?? 100)
      this.last.set(e.id, cur)
    }
    const die: number[] = []
    for (const id of this.last.keys()) if (!w.ents.has(id)) die.push(id)
    for (const id of die) this.last.delete(id)

    if (spawn.length) f.spawn = spawn
    if (move.length) f.move = move
    if (hp.length) f.hp = hp
    if (die.length) f.die = die
    if (w.shots.length) f.shots = w.shots.slice()
    if (ord.length) f.ord = ord
    if (bp.length) f.bp = bp
    const players = playerSnaps(w)
    const pj = JSON.stringify(players)
    if (pj !== this.lastPlayers) {
      f.players = players
      this.lastPlayers = pj
    }
    const mj = JSON.stringify(w.markers)
    if (mj !== this.lastMarkers) {
      f.markers = JSON.parse(mj)
      this.lastMarkers = mj
    }
    if (w.status !== this.lastStatus) {
      f.status = w.status
      this.lastStatus = w.status
    }
    if (extra.logs?.length) f.logs = extra.logs
    if (extra.errs?.length) f.errs = extra.errs
    this.frames.push(f)
  }
}
