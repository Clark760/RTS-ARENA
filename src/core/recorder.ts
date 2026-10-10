// 回放记录：每 tick 和上一 tick 比较，只记变化
import type { Order } from "../api/bot-api.ts"
import type { EntityState, EntSnap, Frame, PlayerSnap, Snapshot, StatDiff } from "./types.ts"
import { statDiff, type World } from "./world.ts"

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

function snapOf(e: EntityState, w: World): EntSnap {
  const s: EntSnap = { id: e.id, type: e.type, owner: e.owner, x: e.x, y: e.y, hp: e.def.kind === "resource" ? e.amount : e.hp, ord: orderText(e) }
  if (e.construction) s.bp = Math.floor((100 * e.construction.done) / e.construction.total)
  const st = statDiff(e.def, w.types[e.type])
  if (st) s.st = st
  if (e.buffs.length) s.bf = e.buffs.map((b) => b.name)
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
    w.removed.clear()
    for (const e of w.ents.values()) this.last.set(e.id, snapOf(e, w))
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
    const owner: number[] = []
    const st: [number, StatDiff | null][] = []
    const bf: [number, string[] | null][] = []
    for (const e of w.ents.values()) {
      const prev = this.last.get(e.id)
      const cur = snapOf(e, w)
      if (!prev) {
        spawn.push(cur)
        this.last.set(e.id, cur)
        continue
      }
      if (prev.x !== cur.x || prev.y !== cur.y) move.push(e.id, cur.x, cur.y)
      if (prev.hp !== cur.hp) hp.push(e.id, cur.hp)
      if (prev.ord !== cur.ord) ord.push([e.id, cur.ord])
      if (prev.bp !== cur.bp) bp.push(e.id, cur.bp ?? 100)
      if (prev.owner !== cur.owner) owner.push(e.id, cur.owner)
      if ((prev.st || cur.st) && JSON.stringify(prev.st) !== JSON.stringify(cur.st)) st.push([e.id, cur.st ?? null])
      if ((prev.bf || cur.bf) && (prev.bf ?? []).join("|") !== (cur.bf ?? []).join("|")) bf.push([e.id, cur.bf ?? null])
      this.last.set(e.id, cur)
    }
    const die: number[] = []
    for (const id of this.last.keys()) if (!w.ents.has(id)) die.push(id)
    for (const id of die) this.last.delete(id)
    const removed = die.filter((id) => w.removed.has(id))
    w.removed.clear()

    if (spawn.length) f.spawn = spawn
    if (move.length) f.move = move
    if (hp.length) f.hp = hp
    if (die.length) f.die = die
    if (removed.length) f.removed = removed
    if (w.shots.length) f.shots = w.shots.slice()
    if (ord.length) f.ord = ord
    if (bp.length) f.bp = bp
    if (owner.length) f.owner = owner
    if (st.length) f.st = st
    if (bf.length) f.bf = bf
    if (w.heals.length) f.heal = w.heals.splice(0)
    if (w.casts.length) f.casts = w.casts.splice(0).map((c) => ({ u: c.unit, s: c.skill, ...(c.x !== undefined ? { x: c.x, y: c.y } : {}), ...(c.target !== undefined ? { t: c.target } : {}) }))
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
    if (w.ruleNotes.length) f.notes = w.ruleNotes.splice(0)
    if (extra.logs?.length) f.logs = extra.logs
    if (extra.errs?.length) f.errs = extra.errs
    this.frames.push(f)
  }
}
