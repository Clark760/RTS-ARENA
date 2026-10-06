// 每 tick 的结算：生产 → 战斗（同时结算）→ 死亡 → 移动（随机先后）→ 建造 → 采集
import { flowStep, UNREACHABLE } from "./nav.ts"
import { attackable, rectDist, type World } from "./world.ts"
import type { EntityState, Rect } from "./types.ts"

/** 追单位时，距离在这以内用小范围 A*，更远用去目标当前格的流场 */
const CHASE_NEAR = 10
/** 追单位时 A* 最多扩展的格子数 */
const CHASE_EXPAND = 400
/** move / attackMove 被单位挡住这么多 tick 就放弃，变成 idle */
const STUCK_GIVE_UP = 30
/** 被挡住时绕行 A* 最多扩展的格子数 */
const DETOUR_EXPAND = 300
/** 生产出的单位最远放到建筑外几步 */
const SPAWN_RING = 4

export function step(w: World): void {
  w.events = []
  w.shots = []
  production(w)
  combat(w)
  movement(w)
  construction(w)
  gathering(w)
}

function setIdle(e: EntityState): void {
  e.order = { kind: "idle" }
  e.path.length = 0
  e.pathKey = ""
  e.stuck = 0
  e.want = -1
  e.gatherCd = 0
}

// ---------- 生产 ----------

function production(w: World): void {
  for (const b of w.ents.values()) {
    if (b.queue.length === 0 || b.construction) continue
    const q = b.queue[0]
    if (q.ticksLeft > 0) q.ticksLeft--
    if (q.ticksLeft > 0) continue
    const def = w.types[q.type]
    const spot = w.findSpotAround(def, b, SPAWN_RING)
    if (!spot) continue // 周围满了，等有空位
    b.queue.shift()
    w.spawnLive(q.type, b.owner, spot.x, spot.y)
  }
}

// ---------- 战斗 ----------

/** 敌人：属于别的队伍的玩家、能被攻击（中立的不会被自动攻击） */
function isEnemy(w: World, e: EntityState, o: EntityState): boolean {
  return o.owner >= 0 && !w.isAlly(e.owner, o.owner) && attackable(o)
}

/** 指定攻击的合法目标：不是自己和盟友的、能被攻击（中立的可以） */
export function canHit(w: World, e: EntityState, o: EntityState): boolean {
  return o.owner !== e.owner && !w.isAlly(e.owner, o.owner) && attackable(o)
}

/** radius 内最好打的敌人：最近 → 血最少 → id 最小（id 是随机分配的，所以最后这条等于随机） */
function bestEnemyWithin(w: World, e: EntityState, radius: number): EntityState | null {
  let best: EntityState | null = null
  let bestD = 0
  const W = w.width
  const y0 = Math.max(0, e.y - radius)
  const y1 = Math.min(w.height - 1, e.y + e.h - 1 + radius)
  for (let y = y0; y <= y1; y++) {
    const dy = Math.max(0, e.y - y, y - (e.y + e.h - 1))
    const rem = radius - dy
    const x0 = Math.max(0, e.x - rem)
    const x1 = Math.min(W - 1, e.x + e.w - 1 + rem)
    for (let x = x0; x <= x1; x++) {
      const i = y * W + x
      const id = w.unitOcc[i] || w.staticOcc[i]
      if (id === 0) continue
      const o = w.ents.get(id)!
      if (!isEnemy(w, e, o)) continue
      const d = rectDist(e, o)
      if (d > radius) continue
      if (!best || d < bestD || (d === bestD && (o.hp < best.hp || (o.hp === best.hp && o.id < best.id)))) {
        best = o
        bestD = d
      }
    }
  }
  return best
}

function attackTarget(w: World, e: EntityState): EntityState | null {
  const range = e.def.attack!.range
  const o = e.order
  switch (o.kind) {
    case "attack": {
      const t = w.ents.get(o.target)
      // 目标没了、看不见了，或者自己不能动而目标出了射程：命令结束，这一 tick 照常自动攻击
      if (!t || !canHit(w, e, t) || !w.visibleTo(e.owner, t) || (e.def.moveTicks <= 0 && rectDist(e, t) > range)) {
        setIdle(e)
        return bestEnemyWithin(w, e, range)
      }
      return rectDist(e, t) <= range ? t : null
    }
    case "idle":
    case "attackMove":
      return bestEnemyWithin(w, e, range)
    default:
      return null
  }
}

function combat(w: World): void {
  const hits: EntityState[] = []
  for (const e of w.ents.values()) {
    const atk = e.def.attack
    if (!atk || e.construction) continue
    if (e.attackCd > 0) e.attackCd--
    if (e.attackCd > 0) continue
    const t = attackTarget(w, e)
    if (!t) continue
    hits.push(e, t)
    e.attackCd = atk.cooldown
  }
  // 先全部算完再扣血：同一 tick 互相攻击的双方都能打出伤害
  for (let i = 0; i < hits.length; i += 2) {
    const a = hits[i]
    const t = hits[i + 1]
    const dmg = a.def.attack!.damage
    t.hp -= dmg
    t.lastHitBy = a.owner
    w.shots.push(a.id, t.id)
    if (t.owner >= 0) w.pushEvent(t.owner, { kind: "damaged", tick: w.tick, id: t.id, by: a.id, damage: dmg })
  }
  for (let i = 1; i < hits.length; i += 2) {
    const t = hits[i]
    if (t.alive && t.hp <= 0) w.destroy(t, t.lastHitBy)
  }
}

// ---------- 移动 ----------

/** 移动目标：不会动的目标走流场，会动的单位用 chase */
interface Goal {
  key: string
  /** move / attackMove：到不了或挡太久就放弃 */
  giveUp: boolean
  field?: () => Int32Array
  /** 追会动的目标 */
  chase?: { target: EntityState; range: number }
}

function tileGoal(w: World, x: number, y: number, key = `t${x},${y}`): Goal {
  return { key, giveUp: true, field: () => w.flow.toTile(x, y) }
}

function nearGoal(w: World, t: EntityState, range: number): Goal {
  if (t.def.kind === "unit") return { key: `c${t.id}r${range}`, giveUp: false, chase: { target: t, range } }
  return { key: `r${t.id}r${range}`, giveUp: false, field: () => w.flow.toRect(t.id, t, range) }
}

function nearestDropOff(w: World, e: EntityState): EntityState | null {
  let best: EntityState | null = null
  let bestD = 0
  for (const o of w.ents.values()) {
    if (o.owner !== e.owner || !o.def.dropOff || o.construction) continue
    const d = rectDist(e, o)
    if (!best || d < bestD || (d === bestD && o.id < best.id)) {
      best = o
      bestD = d
    }
  }
  return best
}

function moveGoal(w: World, e: EntityState): Goal | null {
  const o = e.order
  switch (o.kind) {
    case "idle":
      return null
    case "move":
      if (e.x === o.x && e.y === o.y) {
        setIdle(e)
        return null
      }
      return tileGoal(w, o.x, o.y)
    case "attack": {
      const t = w.ents.get(o.target)
      if (!t || !w.visibleTo(e.owner, t)) {
        setIdle(e)
        return null
      }
      const range = e.def.attack!.range
      return rectDist(e, t) <= range ? null : nearGoal(w, t, range)
    }
    case "attackMove": {
      const range = e.def.attack!.range
      if (bestEnemyWithin(w, e, range)) return null
      const seen = bestEnemyWithin(w, e, e.def.sight)
      if (seen) return nearGoal(w, seen, range)
      if (e.x === o.x && e.y === o.y) {
        setIdle(e)
        return null
      }
      return tileGoal(w, o.x, o.y, `a${o.x},${o.y}`)
    }
    case "gather": {
      if (o.returning) {
        const drop = nearestDropOff(w, e)
        if (!drop) {
          setIdle(e)
          return null
        }
        return rectDist(e, drop) <= 1 ? null : nearGoal(w, drop, 1)
      }
      const node = w.ents.get(o.target)
      if (!node) return null // 采集阶段会处理
      return rectDist(e, node) <= 1 ? null : nearGoal(w, node, 1)
    }
    case "build": {
      const site = w.ents.get(o.target)
      if (!site || !site.construction) {
        setIdle(e)
        return null
      }
      return rectDist(e, site) <= 1 ? null : nearGoal(w, site, 1)
    }
  }
}

/** unreachable：从这里到不了目标（由 stepToward 决定怎么办） */
type StepResult = "moved" | "blocked" | "done" | "unreachable"

function doMove(w: World, e: EntityState, to: number): StepResult {
  w.moveUnit(e, to)
  e.stuck = 0
  e.want = -1
  e.moveCd = e.def.moveTicks
  return "moved"
}

/**
 * 挡在 ni 的是自己人，而且它闲着、或者它上次也想走进我这一格（迎面堵住）：两人交换位置。
 * 敌人不让路。
 */
function trySwap(w: World, e: EntityState, ni: number): boolean {
  if (ni < 0) return false
  const o = w.ents.get(w.unitOcc[ni])
  if (!o || o.owner !== e.owner || o.def.moveTicks <= 0) return false
  const here = e.y * w.width + e.x
  const idle = o.order.kind === "idle"
  if (!idle && o.want !== here) return false
  w.unitOcc[here] = o.id
  w.unitOcc[ni] = e.id
  o.x = e.x
  o.y = e.y
  e.x = ni % w.width
  e.y = (ni - e.x) / w.width
  e.stuck = 0
  e.want = -1
  e.moveCd = e.def.moveTicks
  if (!idle) {
    // 对方也算走了一步
    o.stuck = 0
    o.want = -1
    o.path.length = 0
    o.moveCd = o.def.moveTicks
  }
  return true
}

/** 按流场走一步 */
function stepByField(w: World, e: EntityState, field: Int32Array, key: string, giveUp: boolean): StepResult {
  const here = e.y * w.width + e.x
  const d = field[here]
  if (d === UNREACHABLE) return "unreachable"
  if (d === 0) return "done"
  // move 到目标旁边了、目标格被别的单位占着：算到了
  if (giveUp && d <= 1 && e.stuck >= 3) {
    setIdle(e)
    return "done"
  }
  // 正在走绕行路线
  const detourKey = "d" + key
  if (e.pathKey === detourKey && e.path.length > 0) {
    const next = e.path[e.path.length - 1]
    if (w.staticFree(next) && w.unitOcc[next] === 0) {
      e.path.pop()
      return doMove(w, e, next)
    }
    e.path.length = 0
  }
  const step = flowStep(w, field, here)
  if (step.next >= 0) return doMove(w, e, step.next)
  if (!step.closer) {
    // 没有更近的可站位置（目标在障碍里）：已经尽量靠近了
    setIdle(e)
    return "done"
  }
  if (trySwap(w, e, step.blocked)) return "moved"
  e.want = step.blocked
  // 被挡了两回：把单位当障碍、用流场当启发值做小范围 A*，绕一段
  if (e.stuck >= 2 && e.stuck % 2 === 0) {
    const self = e.id
    const W = w.width
    const res = w.pf.find({
      sx: e.x,
      sy: e.y,
      h: (x, y) => {
        const v = field[y * W + x]
        return v === UNREACHABLE ? 1e6 : v
      },
      passable: (i) => w.staticFree(i) && (w.unitOcc[i] === 0 || w.unitOcc[i] === self),
      maxExpand: DETOUR_EXPAND,
      salt: w.simRng.next() >>> 1,
    })
    if (res.path.length > 0) {
      e.path = res.path
      e.pathKey = detourKey
      return doMove(w, e, e.path.pop()!)
    }
  }
  return "blocked"
}

/**
 * 追会动的单位：近了用小范围 A*（目标走出 2 格就重新规划）；远了、或者 A* 找不到更近的路（隔着墙要绕远），
 * 改用去目标当前格的流场。
 */
function stepByChase(w: World, e: EntityState, goal: Goal): StepResult {
  const { target: t, range } = goal.chase!
  const fieldKey = "f" + goal.key
  if (e.pathKey === fieldKey || rectDist(e, t) > CHASE_NEAR) {
    e.pathKey = fieldKey
    return stepByField(w, e, w.flow.toTile(t.x, t.y), goal.key, false)
  }
  const moved = Math.abs(t.x - e.planX) + Math.abs(t.y - e.planY)
  const avoid = e.stuck >= 2
  if (e.pathKey !== goal.key || e.path.length === 0 || moved >= 2 || (avoid && e.stuck % 3 === 2)) {
    const self = e.id
    const r: Rect = { x: t.x, y: t.y, w: t.w, h: t.h }
    const res = w.pf.find({
      sx: e.x,
      sy: e.y,
      h: (ax, ay) => Math.max(0, rectDist({ x: ax, y: ay, w: 1, h: 1 }, r) - range),
      passable: avoid ? (i) => w.staticFree(i) && (w.unitOcc[i] === 0 || w.unitOcc[i] === self) : (i) => w.staticFree(i),
      maxExpand: CHASE_EXPAND,
      salt: w.simRng.next() >>> 1,
    })
    e.path = res.path
    e.pathKey = goal.key
    e.planX = t.x
    e.planY = t.y
    if (e.path.length === 0) {
      if (avoid) return "blocked"
      // 不绕开单位都找不到更近的路：改用流场（流场也到不了才算真的到不了）
      e.pathKey = fieldKey
      return stepByField(w, e, w.flow.toTile(t.x, t.y), goal.key, false)
    }
  }
  const next = e.path[e.path.length - 1]
  if (!w.staticFree(next)) {
    e.path.length = 0
    return "blocked"
  }
  if (w.unitOcc[next] !== 0) {
    if (trySwap(w, e, next)) {
      e.path.pop()
      return "moved"
    }
    e.want = next
    return "blocked"
  }
  e.path.pop()
  return doMove(w, e, next)
}

function stepToward(w: World, e: EntityState): StepResult {
  const goal = moveGoal(w, e)
  if (!goal) return "done"
  const r = goal.field ? stepByField(w, e, goal.field(), goal.key, goal.giveUp) : stepByChase(w, e, goal)
  if (r !== "unreachable") return r
  const o = e.order
  // attackMove 被看得见却到不了的敌人（比如隔着水）引过去：不管它，继续去终点
  if (o.kind === "attackMove" && goal.key !== `a${o.x},${o.y}`) {
    const r2 = stepByField(w, e, w.flow.toTile(o.x, o.y), `a${o.x},${o.y}`, true)
    if (r2 !== "unreachable") return r2
  }
  setIdle(e) // 从这里到不了
  return "done"
}

function movement(w: World): void {
  const movers: EntityState[] = []
  for (const e of w.ents.values()) {
    if (e.def.moveTicks <= 0) continue
    if (e.moveCd > 0) e.moveCd--
    if (e.moveCd > 0 || e.order.kind === "idle") continue
    movers.push(e)
  }
  w.simRng.shuffle(movers)
  // 第一轮被挡住的，等别人走完再试一次（排成一列走时后面的能跟上）
  const retry: EntityState[] = []
  for (const e of movers) if (e.alive && e.moveCd === 0 && stepToward(w, e) === "blocked") retry.push(e)
  for (const e of retry) {
    if (e.moveCd > 0 || stepToward(w, e) !== "blocked") continue
    e.stuck++
    if (e.stuck >= STUCK_GIVE_UP && (e.order.kind === "move" || e.order.kind === "attackMove")) setIdle(e)
  }
}

// ---------- 建造 ----------

/** 贴着地基的建造者每人每 tick 干 1 份活；生命按进度从 1/10 涨到满（期间挨的打不补） */
function construction(w: World): void {
  for (const e of w.ents.values()) {
    const o = e.order
    if (o.kind !== "build") continue
    const site = w.ents.get(o.target)
    if (!site || !site.construction) {
      setIdle(e)
      continue
    }
    if (rectDist(e, site) > 1) continue
    const c = site.construction
    const hp0 = Math.max(1, Math.ceil(site.def.maxHp / 10))
    const gain = (done: number) => Math.floor(((site.def.maxHp - hp0) * done) / c.total)
    c.done++
    site.hp += gain(c.done) - gain(c.done - 1)
    if (c.done < c.total) continue
    site.construction = null
    for (const u of w.ents.values()) if (u.order.kind === "build" && u.order.target === site.id) setIdle(u)
    w.events.push({ kind: "built", id: site.id, type: site.type, owner: site.owner })
    if (site.owner >= 0) w.pushEvent(site.owner, { kind: "built", tick: w.tick, id: site.id, type: site.type })
  }
}

// ---------- 采集 ----------

function gathering(w: World): void {
  for (const e of w.ents.values()) {
    const o = e.order
    if (o.kind !== "gather") continue
    const g = e.def.gather!
    if (!o.returning) {
      const node = w.ents.get(o.target)
      if (!node || node.amount <= 0) {
        if (e.carrying) o.returning = true
        else setIdle(e)
        continue
      }
      if (e.carrying && (e.carrying.resource !== node.def.resource || e.carrying.amount >= g.capacity)) {
        o.returning = true
        continue
      }
      if (rectDist(e, node) > 1) {
        e.gatherCd = 0
        continue
      }
      e.gatherCd++
      if (e.gatherCd < g.ticks) continue
      e.gatherCd = 0
      const have = e.carrying?.amount ?? 0
      const take = Math.min(g.amount, node.amount, g.capacity - have)
      e.carrying = { resource: node.def.resource!, amount: have + take }
      node.amount -= take
      if (node.amount <= 0) w.destroy(node, -1)
      if (e.carrying.amount >= g.capacity) o.returning = true
    } else {
      if (!e.carrying) {
        o.returning = false
        continue
      }
      const drop = nearestDropOff(w, e)
      if (!drop) {
        setIdle(e)
        continue
      }
      if (rectDist(e, drop) > 1) continue
      const { resource, amount } = e.carrying
      w.players[e.owner].resources[resource] += amount
      w.events.push({ kind: "deposit", player: e.owner, resource, amount, by: e.id })
      e.carrying = null
      o.returning = false
      e.path.length = 0
      if (!w.ents.has(o.target)) setIdle(e)
    }
  }
}
