// 回放数据：按帧还原局面（播放器和命令行的战报共用），每 100 tick 存一个关键帧，拖进度条时从最近的关键帧往后推
import type { EntSnap, Frame, Marker, PlayerSnap, Replay } from "./types.ts"

const KEY_EVERY = 100

export interface State {
  tick: number
  ents: Map<number, EntSnap>
  players: PlayerSnap[]
  markers: Marker[]
  status: string
}

/** 应用一帧时的变化，供画面做动画 */
export interface Delta {
  moved: { id: number; fromX: number; fromY: number }[]
  spawned: number[]
  died: EntSnap[]
  shots: number[]
  /** 换了主人的实体（from 是原来的主人） */
  owned: { id: number; from: number }[]
  /** 这一 tick 放的技能（D-186） */
  casts: NonNullable<Frame["casts"]>
  /** 这一 tick 被动回血的 [id, 回了多少, ...]（D-190） */
  heals: number[]
}

function clone(s: State): State {
  const ents = new Map<number, EntSnap>()
  for (const [id, e] of s.ents) ents.set(id, { ...e })
  return { tick: s.tick, ents, players: s.players, markers: s.markers, status: s.status }
}

export class ReplayModel {
  readonly replay: Replay
  readonly lastTick: number
  private keys: State[] = []

  constructor(replay: Replay) {
    if (replay.format !== "rts-arena-replay") throw new Error("不是 rts-arena 回放文件")
    this.replay = replay
    this.lastTick = replay.frames.length
    const s = this.initialState()
    this.keys.push(clone(s))
    for (const f of replay.frames) {
      applyFrame(s, f)
      if (f.t % KEY_EVERY === 0) this.keys.push(clone(s))
    }
  }

  initialState(): State {
    const init = this.replay.initial
    const ents = new Map<number, EntSnap>()
    for (const e of init.entities) ents.set(e.id, { ...e })
    return { tick: 0, ents, players: init.players, markers: init.markers, status: init.status }
  }

  frame(t: number): Frame | undefined {
    return this.replay.frames[t - 1]
  }

  /** 第 t tick 的局面（新对象） */
  stateAt(t: number): State {
    t = Math.max(0, Math.min(this.lastTick, t))
    const s = clone(this.keys[Math.floor(t / KEY_EVERY)])
    for (let k = s.tick + 1; k <= t; k++) applyFrame(s, this.replay.frames[k - 1])
    return s
  }
}

/** 把一帧应用到局面上（原地修改），返回变化 */
export function applyFrame(s: State, f: Frame): Delta {
  const d: Delta = { moved: [], spawned: [], died: [], shots: f.shots ?? [], owned: [], casts: f.casts ?? [], heals: f.heal ?? [] }
  for (const e of f.spawn ?? []) {
    s.ents.set(e.id, { ...e })
    d.spawned.push(e.id)
  }
  const mv = f.move ?? []
  for (let i = 0; i < mv.length; i += 3) {
    const e = s.ents.get(mv[i])
    if (!e) continue
    d.moved.push({ id: e.id, fromX: e.x, fromY: e.y })
    e.x = mv[i + 1]
    e.y = mv[i + 2]
  }
  const hp = f.hp ?? []
  for (let i = 0; i < hp.length; i += 2) {
    const e = s.ents.get(hp[i])
    if (e) e.hp = hp[i + 1]
  }
  for (const [id, ord] of f.ord ?? []) {
    const e = s.ents.get(id)
    if (e) e.ord = ord
  }
  const ow = f.owner ?? []
  for (let i = 0; i < ow.length; i += 2) {
    const e = s.ents.get(ow[i])
    if (!e || e.owner === ow[i + 1]) continue
    d.owned.push({ id: e.id, from: e.owner })
    e.owner = ow[i + 1]
  }
  for (const [id, st] of f.st ?? []) {
    const e = s.ents.get(id)
    if (!e) continue
    if (st) e.st = st
    else delete e.st
  }
  for (const [id, bf] of f.bf ?? []) {
    const e = s.ents.get(id)
    if (!e) continue
    if (bf) e.bf = bf
    else delete e.bf
  }
  const bp = f.bp ?? []
  for (let i = 0; i < bp.length; i += 2) {
    const e = s.ents.get(bp[i])
    if (!e) continue
    if (bp[i + 1] >= 100) delete e.bp
    else e.bp = bp[i + 1]
  }
  for (const id of f.die ?? []) {
    const e = s.ents.get(id)
    if (e) d.died.push(e)
    s.ents.delete(id)
  }
  if (f.players) s.players = f.players
  if (f.markers) s.markers = f.markers
  if (f.status !== undefined) s.status = f.status
  s.tick = f.t
  return d
}
