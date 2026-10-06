// 建造命令：放地基、扣钱、工人干活、建好前后的区别、拆地基、视野限制
import assert from "node:assert/strict"
import { test } from "node:test"
import type { Commands, Entity, GameEvent, View } from "../src/api/bot-api.ts"
import { runMatch } from "../src/core/match.ts"
import type { Replay, Ruleset, TypeSpec } from "../src/core/types.ts"
import { STANDARD_TERRAIN } from "../rulesets/common/standard.ts"
import { fnBot } from "./helpers.ts"

const look = { shape: "circle" as const }
const TYPES: Record<string, TypeSpec> = {
  hq: { kind: "building", maxHp: 1000, sight: 3, produces: ["peon"], dropOff: true, look },
  // 工作量 10，造价 40 金
  hut: { kind: "building", w: 2, h: 2, maxHp: 200, sight: 2, cost: { gold: 40 }, buildTicks: 10, produces: ["peon"], look },
  post: { kind: "building", maxHp: 100, sight: 2, cost: { gold: 20 }, buildTicks: 4, attack: { damage: 5, range: 3, cooldown: 1 }, look },
  peon: {
    kind: "unit",
    maxHp: 50,
    moveTicks: 1,
    sight: 3,
    cost: { gold: 10 },
    buildTicks: 2,
    builds: ["hut", "post"],
    look,
  },
  grunt: { kind: "unit", maxHp: 50, moveTicks: 1, sight: 3, attack: { damage: 5, range: 1, cooldown: 1 }, look },
}

type Spawn = [type: string, owner: number, x: number, y: number]

function mini(rows: string[], spawns: Spawn[], extra: Partial<Ruleset> = {}): Ruleset {
  return {
    id: "mini-build",
    name: "建造测试",
    players: { min: 2, max: 2 },
    maxTicks: 60,
    tickRate: 10,
    decisionInterval: 1,
    fuel: 100,
    unitCap: 0,
    fog: false,
    resources: ["gold"],
    terrain: STANDARD_TERRAIN,
    types: TYPES,
    setup(ctx) {
      ctx.setTerrain(rows)
      for (const [type, owner, x, y] of spawns) ctx.spawn(type, owner, x, y)
      for (let p = 0; p < 2; p++) ctx.setResources(p, { gold: 100 })
    },
    objectives: () => ({}),
    result: () => null,
    timeUp: () => ({ winner: null, reason: "到时间" }),
    ...extra,
  }
}

function play(rules: Ruleset, p0: (view: View, cmd: Commands) => void, p1: (view: View, cmd: Commands) => void = () => {}): Replay {
  return runMatch({ ruleset: rules, seed: 1, bots: [{ name: "a", file: "", runner: fnBot(p0) }, { name: "b", file: "", runner: fnBot(p1) }] })
}

const mine = (v: View, type: string) => v.entities.filter((e) => e.owner === v.me && e.type === type)
const reasons = (evs: GameEvent[]) => evs.flatMap((e) => (e.kind === "rejected" ? [e.reason] : []))
const ROWS = Array(8).fill(".".repeat(14))

test("建造：放下地基立即扣钱、挡路，工人贴着干活，建好后发 built、工人变 idle", () => {
  const events: GameEvent[] = []
  const views: View[] = []
  const rep = play(mini(ROWS, [["peon", 0, 1, 1], ["hq", 1, 12, 6]], { maxTicks: 30 }), (v, cmd) => {
    views.push(v)
    events.push(...v.events)
    if (v.tick === 0) cmd.build(mine(v, "peon")[0], "hut", 5, 1)
  })
  const at = (t: number) => views[t]
  const site = mine(at(1), "hut")[0]
  assert.ok(site, "下一 tick 就看得到地基")
  assert.equal(at(1).resources.gold, 60, "放地基时扣了 40")
  assert.deepEqual(site.construction, { done: 0, total: 10 })
  assert.equal(site.hp, 20, "地基生命从 1/10 开始")
  assert.equal(mine(at(1), "peon")[0].order?.kind, "build")
  // 工人从 (1,1) 走到 (4,1) 要 3 tick，之后每 tick 干 1 份，10 份干完
  const done = views.find((v) => mine(v, "hut")[0] && !mine(v, "hut")[0].construction)!
  assert.ok(done, "应该建好")
  assert.equal(mine(done, "hut")[0].hp, 200, "建好时满血")
  // 第 1 tick 放地基，走 3 步，第 3 tick 起每 tick 干 1 份
  assert.equal(done.tick, 12)
  const built = events.find((e) => e.kind === "built")
  assert.ok(built && built.kind === "built" && built.type === "hut")
  assert.ok(events.some((e) => e.kind === "created" && e.type === "hut"), "放地基时发 created")
  assert.equal(mine(done, "peon")[0].order?.kind, "idle")
  assert.equal(reasons(events).length, 0)
  // 回放：进度每 tick 记一次，建好时记 100
  const bp = rep.frames.flatMap((f) => (f.bp ?? []).filter((_, i) => i % 2 === 1))
  assert.deepEqual(bp, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
})

test("建造：两个工人一起建快一倍；第二个工人对同一块地基下 build 不再扣钱", () => {
  const time = (helpers: number) => {
    const views: View[] = []
    play(mini(ROWS, [["peon", 0, 4, 0], ["peon", 0, 4, 3], ["hq", 1, 12, 6]], { maxTicks: 30 }), (v, cmd) => {
      views.push(v)
      const [a, b] = mine(v, "peon").sort((p, q) => p.y - q.y)
      if (v.tick === 0) cmd.build(a, "hut", 5, 1)
      if (v.tick === 1 && helpers > 1) cmd.build(b, "hut", 5, 1)
    })
    const done = views.find((v) => mine(v, "hut")[0] && !mine(v, "hut")[0].construction)!
    return { tick: done.tick, gold: done.resources.gold }
  }
  const one = time(1)
  const two = time(2)
  assert.equal(two.gold, 60, "只扣了一次钱")
  assert.ok(two.tick < one.tick - 3, `一个人 ${one.tick} tick，两个人 ${two.tick} tick`)
})

test("建造：没建好的建筑不能生产、不能攻击；建好后可以", () => {
  const events: GameEvent[] = []
  let enemyHpWhileSite = 0
  let enemyHpEnd = 0
  play(
    mini(ROWS, [["peon", 0, 1, 1], ["grunt", 1, 5, 4], ["hq", 1, 12, 6]], { maxTicks: 40 }),
    (v, cmd) => {
      events.push(...v.events)
      const post = mine(v, "post")[0]
      const enemy = v.entities.find((e) => e.type === "grunt")
      if (v.tick === 0) cmd.build(mine(v, "peon")[0], "post", 3, 3)
      if (v.tick === 1) cmd.produce(mine(v, "post")[0], "peon")
      if (post?.construction) enemyHpWhileSite = enemy?.hp ?? 0
      enemyHpEnd = enemy?.hp ?? 0
    },
  )
  assert.equal(enemyHpWhileSite, 50, "没建好的塔不打人")
  assert.ok(enemyHpEnd < 50, "建好的塔会打射程内的敌人")
  assert.match(reasons(events)[0] ?? "", /还没建好|不能生产/)
})

test("建造：拆掉没建好的地基退 75%，工人变 idle", () => {
  const golds: number[] = []
  let peon: Entity | undefined
  play(mini(ROWS, [["peon", 0, 1, 1], ["hq", 1, 12, 6]], { maxTicks: 6 }), (v, cmd) => {
    golds.push(v.resources.gold)
    peon = mine(v, "peon")[0]
    if (v.tick === 0) cmd.build(peon, "hut", 6, 1)
    if (v.tick === 1) cmd.cancel(mine(v, "hut")[0])
  })
  assert.deepEqual(golds.slice(0, 3), [100, 60, 90])
  assert.equal(peon?.order?.kind, "idle")
})

test("建造：被拒的情况（不能建造、钱不够、有东西挡着、超出地图、地形不行）", () => {
  const events: GameEvent[] = []
  play(mini(["....#.........", ...ROWS.slice(1)], [["peon", 0, 1, 1], ["grunt", 0, 2, 4], ["hq", 1, 12, 6]], { maxTicks: 3 }), (v, cmd) => {
    events.push(...v.events)
    if (v.tick !== 0) return
    const p = mine(v, "peon")[0]
    const g = mine(v, "grunt")[0]
    cmd.build(g, "hut", 8, 2) // grunt 不能建造
    cmd.build(p, "hq", 8, 2) // 不在 builds 里
    cmd.build(p, "hut", 1, 0) // (1,1) 站着自己
    cmd.build(p, "hut", 13, 2) // 超出地图
    cmd.build(p, "hut", 3, 0) // (4,0) 是岩石
    cmd.build(p, "hut", 8, 2) // 成功，扣 40
    cmd.build(p, "hut", 8, 5) // 成功，扣 40（换了地方：上一块地基留着）
    cmd.build(p, "hut", 4, 4) // 钱不够（剩 20）
  })
  const r = reasons(events)
  assert.equal(r.length, 6, r.join("\n"))
  assert.match(r[0], /不能建造/)
  assert.match(r[1], /不能建造 hq/)
  assert.match(r[2], /挡着/)
  assert.match(r[3], /超出地图/)
  assert.match(r[4], /地形/)
  assert.match(r[5], /不够/)
})

test("建造：检查顺序是地图 → 地形和资源点（整局都看得见）→ 视野 → 其他实体", () => {
  const events: GameEvent[] = []
  // (20, 1) 看不见、是岩石；(24, 1) 看不见、有资源点；(1, 2) 看得见、站着自己
  const rows = Array(5).fill(".".repeat(30))
  rows[1] = ".".repeat(20) + "#" + ".".repeat(9)
  const types = { ...TYPES, ore: { kind: "resource" as const, resource: "gold", amount: 100, look } }
  play(mini(rows, [["peon", 0, 1, 2], ["hq", 1, 27, 3], ["ore", -1, 24, 1]], { fog: true, maxTicks: 3, types }), (v, cmd) => {
    events.push(...v.events)
    if (v.tick !== 0) return
    const p = mine(v, "peon")[0]
    cmd.build(p, "post", 20, 1)
    cmd.build(p, "post", 24, 1)
    cmd.build(p, "post", 26, 3)
  })
  const r = reasons(events)
  assert.equal(r.length, 3, r.join("\n"))
  assert.match(r[0], /\(20, 1\) 的地形不能建造/)
  assert.match(r[1], /\(24, 1\) 有 #\d+（ore）挡着/)
  assert.match(r[2], /视野/)
})

test("建造：有迷雾时只能建在视野里，拒绝原因不暴露看不见的格子里有什么", () => {
  const events: GameEvent[] = []
  const rows = Array(5).fill(".".repeat(30))
  play(mini(rows, [["peon", 0, 1, 2], ["hq", 1, 20, 1]], { fog: true, maxTicks: 3 }), (v, cmd) => {
    events.push(...v.events)
    if (v.tick !== 0) return
    const p = mine(v, "peon")[0]
    cmd.build(p, "hut", 20, 1) // 敌人主基地在这，但看不见
    cmd.build(p, "hut", 25, 1) // 空地，也看不见
  })
  const r = reasons(events)
  assert.equal(r.length, 2)
  assert.equal(r[0].replace(/\(\d+, \d+\)/, "#"), r[1].replace(/\(\d+, \d+\)/, "#"), "两种情况的拒绝原因一样")
  assert.match(r[0], /视野/)
})

test("建造：地基被打掉，去建它的工人变 idle", () => {
  let peon: Entity | undefined
  const rep = play(
    // 两个敌人贴着地基（会自动打它），工人离得远，还没走到地基就没了
    mini(ROWS, [["peon", 0, 0, 7], ["grunt", 1, 8, 1], ["grunt", 1, 8, 2], ["hq", 1, 12, 6]], { maxTicks: 10 }),
    (v, cmd) => {
      peon = mine(v, "peon")[0] ?? peon
      if (v.tick === 0) cmd.build(mine(v, "peon")[0], "hut", 6, 1)
    },
  )
  assert.ok(rep.frames.some((f) => f.spawn?.some((s) => s.type === "hut" && s.bp === 0)))
  assert.ok(rep.frames.some((f) => f.ord?.some(([, o]) => o.startsWith("build #"))))
  const died = rep.frames.some((f) => f.die && f.die.length > 0)
  assert.ok(died, "地基被打掉了")
  assert.equal(peon?.order?.kind, "idle")
  // bot 收到的 died 事件说明死的是没建好的地基
  const ev: GameEvent[] = []
  play(mini(ROWS, [["peon", 0, 0, 7], ["grunt", 1, 8, 1], ["grunt", 1, 8, 2], ["hq", 1, 12, 6]], { maxTicks: 10 }), (v, cmd) => {
    ev.push(...v.events)
    if (v.tick === 0) cmd.build(mine(v, "peon")[0], "hut", 6, 1)
  })
  const d = ev.find((e) => e.kind === "died" && e.type === "hut")
  assert.ok(d && d.kind === "died" && d.unfinished === true, JSON.stringify(d))
})

test("建造：规则包里 builds 写了不是建筑的类型会报错", () => {
  const bad = mini(ROWS, [], { types: { ...TYPES, peon: { ...TYPES.peon, builds: ["grunt"] } } })
  assert.throws(() => play(bad, () => {}), /不是建筑类型/)
})
