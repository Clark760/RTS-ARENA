// 按某一队的视野看回放：用和引擎相同的规则（src/core/vision.ts）从回放局面算出这一队当时看得见什么
import type { EntSnap, Replay } from "../../src/core/types.ts"
import { markSight, rectSeen } from "../../src/core/vision.ts"
import type { State } from "./model.ts"

export class Vision {
  private readonly replay: Replay
  /** 这一队看得见的格子 */
  readonly vis: Uint8Array

  constructor(replay: Replay) {
    this.replay = replay
    this.vis = new Uint8Array(replay.map.width * replay.map.height)
  }

  /** 回放里有没有算视野需要的信息（老回放没有 sight 和 fog） */
  static supported(replay: Replay): boolean {
    return typeof replay.fog === "boolean" && Object.values(replay.types).every((t) => typeof t.sight === "number")
  }

  teamOf(player: number): number {
    return this.replay.players[player]?.team ?? player
  }

  /** 算 team 在这个局面下看得见的格子 */
  compute(state: State, team: number): void {
    const { width, height } = this.replay.map
    this.vis.fill(0)
    for (const e of state.ents.values()) {
      if (e.owner < 0 || this.teamOf(e.owner) !== team) continue
      const t = this.replay.types[e.type]
      markSight(this.vis, width, height, { x: e.x, y: e.y, w: t?.w ?? 1, h: t?.h ?? 1 }, e.st?.sight ?? t?.sight ?? 0)
    }
  }

  /** 和引擎的 visibleTo 一样：没有迷雾、自己和盟友的、资源点都看得见，其余要有一格在视野里（先 compute） */
  visible(e: EntSnap, team: number): boolean {
    const t = this.replay.types[e.type]
    if (!this.replay.fog || (e.owner >= 0 && this.teamOf(e.owner) === team) || t?.kind === "resource") return true
    return rectSeen(this.vis, this.replay.map.width, { x: e.x, y: e.y, w: t?.w ?? 1, h: t?.h ?? 1 })
  }

  /** 某一格在不在视野里（没有迷雾时都在） */
  tileSeen(x: number, y: number): boolean {
    return !this.replay.fog || this.vis[y * this.replay.map.width + x] === 1
  }
}
