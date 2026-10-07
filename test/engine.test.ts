// 内核边界情况：用小地图和直接在 Node 里跑的 bot
import assert from "node:assert/strict"
import { test } from "node:test"
import type { Entity, GameEvent, View } from "../src/api/bot-api.ts"
import { runMatch } from "../src/core/match.ts"
import type { Ruleset, TypeSpec } from "../src/core/types.ts"
import { STANDARD_TERRAIN } from "../rulesets/common/standard.ts"
import { fnBot, idle } from "./helpers.ts"
import { ReplayModel } from "../src/core/replay-model.ts"
import type { Commands } from "../src/api/bot-api.ts"

const look = { shape: "circle" as const }
const TYPES: Record<string, TypeSpec> = {
  hq: { kind: "building", maxHp: 1000, sight: 3, produces: ["grunt"], dropOff: true, look },
  tower: { kind: "building", maxHp: 500, sight: 4, attack: { damage: 5, range: 3, cooldown: 2 }, look },
  grunt: {
    kind: "unit",
    maxHp: 100,
    moveTicks: 1,
    sight: 4,
    cost: { gold: 10 },
    buildTicks: 2,
    attack: { damage: 10, range: 1, cooldown: 2 },
    gather: { amount: 1, ticks: 2, capacity: 3 },
    look,
  },
  ore: { kind: "resource", resource: "gold", amount: 30, look },
}

type Spawn = [type: string, owner: number, x: number, y: number]

function mini(rows: string[], spawns: Spawn[], extra: Partial<Ruleset> = {}): Ruleset {
  return {
    id: "mini",
    name: "测试",
    players: { min: 2, max: 2 },
    maxTicks: 100,
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

function play(rules: Ruleset, p0: (view: View, cmd: Commands) => void, p1: (view: View, cmd: Commands) => void = () => {}) {
  return runMatch({ ruleset: rules, seed: 1, bots: [{ name: "a", file: "", runner: fnBot(p0) }, { name: "b", file: "", runner: fnBot(p1) }] })
}

const mine = (v: View, type: string) => v.entities.filter((e) => e.owner === v.me && e.type === type)
const theirs = (v: View, type: string) => v.entities.filter((e) => e.owner !== v.me && e.owner >= 0 && e.type === type)

test("塔：目标走出射程后命令结束，接着自动打射程内的新敌人", () => {
  const rows = Array(5).fill(".".repeat(12))
  let last: View | null = null
  let firstTarget = 0
  play(
    mini(rows, [["tower", 0, 5, 2], ["grunt", 1, 7, 2], ["grunt", 1, 0, 4]], { maxTicks: 30 }),
    (v, cmd) => {
      last = v
      if (v.tick === 0) {
        const t = theirs(v, "grunt").find((e) => e.x === 7)!
        firstTarget = t.id
        cmd.attack(mine(v, "tower")[0], t)
      }
    },
    (v, cmd) => {
      if (v.tick !== 0) return
      for (const g of mine(v, "grunt")) {
        if (g.x === 7) cmd.move(g, 11, 0) // 跑出射程
        else cmd.move(g, 4, 3) // 走进射程
      }
    },
  )
  const v = last as unknown as View
  assert.equal(mine(v, "tower")[0].order?.kind, "idle")
  const late = theirs(v, "grunt").find((e) => e.id !== firstTarget)!
  assert.ok(late.hp < 100, "后来的敌人应该挨打")
})

test("追击隔墙的目标：A* 找不到近路时改用流场绕过去", () => {
  // 一堵长墙，只在最右边留口子：墙这边有 600 格，A* 扩展 400 格内找不到更近的路
  const rows = Array.from({ length: 12 }, (_, y) => (y === 6 ? "#".repeat(98) + ".." : ".".repeat(100)))
  let enemyHp = 100
  play(
    mini(rows, [["grunt", 0, 2, 4], ["grunt", 1, 2, 8]], { maxTicks: 400 }),
    (v, cmd) => {
      if (v.tick === 0) cmd.attack(mine(v, "grunt")[0], theirs(v, "grunt")[0])
      const t = theirs(v, "grunt")[0]
      if (t) enemyHp = t.hp
      else enemyHp = 0
    },
  )
  assert.ok(enemyHp < 100, "应该绕过墙打到目标")
})

test("一格宽走廊里两个自己人迎面走：交换位置，各自到达", () => {
  const rows = ["##########", "#........#", "##########"]
  let last: View | null = null
  let a = 0
  let b = 0
  play(mini(rows, [["grunt", 0, 1, 1], ["grunt", 0, 8, 1]], { maxTicks: 40 }), (v, cmd) => {
    last = v
    if (v.tick === 0) {
      const [g1, g2] = mine(v, "grunt").sort((x, y) => x.x - y.x)
      a = g1.id
      b = g2.id
      cmd.move(g1, 8, 1)
      cmd.move(g2, 1, 1)
    }
  })
  const v = last as unknown as View
  const byId = (id: number) => v.entities.find((e) => e.id === id)!
  assert.deepEqual([byId(a).x, byId(b).x], [8, 1])
})

test("追击时挡路的是自己闲着的单位：换位过去", () => {
  const rows = ["##########", "#........#", "##########"]
  let enemyHp = 100
  play(mini(rows, [["grunt", 0, 1, 1], ["grunt", 0, 2, 1], ["grunt", 1, 8, 1]], { maxTicks: 40 }), (v, cmd) => {
    if (v.tick === 0) {
      const attacker = mine(v, "grunt").find((e) => e.x === 1)!
      cmd.attack(attacker, theirs(v, "grunt")[0])
    }
    enemyHp = theirs(v, "grunt")[0]?.hp ?? 0
  })
  assert.ok(enemyHp < 100)
})

test("局中改数值（D-153）：setTypeStats 改某玩家某类实体（已有的和以后造的），setStats 改单个；bot 从 stats 看到；回放记下", () => {
  const rows = Array(5).fill(".".repeat(10))
  const seen: { tick: number; mine: Entity[]; theirs: Entity[] }[] = []
  const replay = play(
    mini(rows, [["hq", 0, 0, 0], ["grunt", 0, 4, 1], ["hq", 1, 5, 1], ["grunt", 1, 8, 4]], {
      maxTicks: 14,
      onTick(ctx) {
        if (ctx.tick === 2) ctx.setTypeStats(0, "grunt", { attack: { damage: 25 }, maxHp: 150, sight: 6 })
        if (ctx.tick === 4) ctx.setStats(ctx.entities({ owner: 1, type: "grunt" })[0].id, { moveTicks: 3 })
        if (ctx.tick === 10) ctx.setTypeStats(0, "grunt", null)
      },
    }),
    (v, cmd) => {
      if (v.tick === 3) cmd.produce(mine(v, "hq")[0], "grunt")
      seen.push({ tick: v.tick, mine: mine(v, "grunt"), theirs: theirs(v, "grunt") })
    },
  )
  const at = (t: number) => seen.find((s) => s.tick === t)!
  // 改之前：没有 stats
  assert.equal(at(1).mine[0].stats, undefined)
  // 改之后：已有的那个生命上限 100 → 150，当前生命加上差值；攻击、视野在 stats 里（只列改过的项）
  const g = at(3).mine[0]
  assert.equal(g.maxHp, 150)
  assert.equal(g.hp, 150)
  assert.deepEqual(g.stats, { sight: 6, attack: { damage: 25, range: 1, cooldown: 2 } })
  // 以后造出来的也按新数值（满血 150）
  const later = at(8).mine.find((e) => e.id !== g.id)!
  assert.ok(later && later.maxHp === 150 && later.hp === 150, JSON.stringify(later))
  // 单个实体：对手的那个走得慢；只改它，不影响别的
  assert.deepEqual(at(5).theirs[0].stats, { moveTicks: 3 })
  // 改回原值：stats 没了，生命去掉超出的部分
  const back = at(11).mine.find((e) => e.id === g.id)!
  assert.ok(back.stats === undefined && back.maxHp === 100 && back.hp <= 100, JSON.stringify(back))
  // 攻击力真的变了：贴着对手主基地的那个，伤害从 10 变成 25
  const hq1 = replay.initial.entities.find((e) => e.type === "hq" && e.owner === 1)!
  const hits: number[] = []
  let last = hq1.hp
  for (const f of replay.frames)
    for (let i = 0; i < (f.hp ?? []).length; i += 2)
      if (f.hp![i] === hq1.id) {
        hits.push(last - f.hp![i + 1])
        last = f.hp![i + 1]
      }
  assert.ok(hits.includes(10) && hits.includes(25), hits.join(","))
  // 回放：st 记下改过的项，按帧还原
  const model = new ReplayModel(replay)
  assert.deepEqual(model.stateAt(3).ents.get(g.id)?.st, { maxHp: 150, sight: 6, attack: { damage: 25, range: 1, cooldown: 2 } })
  assert.equal(model.stateAt(12).ents.get(g.id)?.st, undefined)
  // 不能改的：不认识的字段、没有这项能力、取值不对
  const bad = (patch: unknown, type = "grunt") =>
    play(mini(rows, [["hq", 0, 0, 0], ["hq", 1, 5, 1]], { maxTicks: 3, onTick: (ctx) => ctx.setTypeStats(0, type, patch as never) }), () => {})
  assert.throws(() => bad({ speed: 2 }), /不能改 speed/)
  assert.throws(() => bad({ attack: { damage: 5 } }, "hq"), /不能攻击/)
  assert.throws(() => bad({ moveTicks: 0 }), /moveTicks 要是 1～1000 的整数/)
  assert.throws(() => bad({ attack: { reach: 3 } }), /attack 里不能改 reach/)
})

test("采集交货循环：每次交 capacity 个", () => {
  const rows = Array(5).fill(".".repeat(10))
  const golds: number[] = []
  play(mini(rows, [["hq", 0, 1, 1], ["ore", -1, 5, 1], ["grunt", 0, 2, 2], ["hq", 1, 8, 4]], { maxTicks: 60 }), (v, cmd) => {
    if (v.tick === 0) cmd.gather(mine(v, "grunt")[0], v.entities.find((e) => e.type === "ore")!)
    golds.push(v.resources.gold)
  })
  const gained = golds[golds.length - 1] - golds[0]
  assert.ok(gained >= 6 && gained % 3 === 0, `交货量 ${gained}`)
})

test("生产：取消全额退款；单位数到上限被拒", () => {
  const rows = Array(5).fill(".".repeat(10))
  const events: GameEvent[] = []
  const golds: number[] = []
  play(mini(rows, [["hq", 0, 1, 1], ["grunt", 0, 3, 3], ["hq", 1, 8, 4]], { maxTicks: 5, unitCap: 2 }), (v, cmd) => {
    events.push(...v.events)
    golds.push(v.resources.gold)
    const hq = mine(v, "hq")[0]
    if (v.tick === 0) {
      cmd.produce(hq, "grunt")
      cmd.cancel(hq)
    }
    if (v.tick === 1) {
      cmd.produce(hq, "grunt") // 现有 1 个 + 这个 = 2，到上限
      cmd.produce(hq, "grunt") // 第 3 个被拒
    }
  })
  assert.equal(golds[1], 100, "取消后退款")
  const rej = events.filter((e) => e.kind === "rejected").map((e) => (e.kind === "rejected" ? e.reason : ""))
  assert.equal(rej.length, 1)
  assert.match(rej[0], /上限/)
})

test("生产的单位不会隔墙出生", () => {
  // 主基地右边一整列墙，左边三个邻格都站了人
  const rows = ["....#.....", "....#.....", "....#.....", "....#.....", "....#....."]
  let spawned: Entity | undefined
  let before: number[] = []
  play(mini(rows, [["hq", 0, 3, 2], ["grunt", 0, 3, 1], ["grunt", 0, 3, 3], ["grunt", 0, 2, 2], ["hq", 1, 9, 4]], { maxTicks: 10 }), (v, cmd) => {
    if (v.tick === 0) {
      before = mine(v, "grunt").map((e) => e.id)
      cmd.produce(mine(v, "hq")[0], "grunt")
    }
    spawned = mine(v, "grunt").find((e) => !before.includes(e.id)) ?? spawned
  })
  assert.ok(spawned, "应该生产出来")
  assert.ok(spawned!.x < 4, `出生在 (${spawned!.x}, ${spawned!.y})，跑到墙那边去了`)
})

test("实体 id 随机分配，view.entities 按 id 升序", () => {
  const rows = Array(5).fill(".".repeat(10))
  let ids: number[] = []
  play(mini(rows, [["hq", 0, 1, 1], ["grunt", 0, 3, 3], ["grunt", 0, 4, 3], ["grunt", 0, 5, 3], ["hq", 1, 8, 4]], { maxTicks: 2 }), (v) => {
    ids = v.entities.map((e) => e.id)
  })
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b))
  const gaps = ids.slice(1).map((x, i) => x - ids[i])
  assert.ok(gaps.some((g) => g !== 1), "id 不应该是连续的")
})

test("隔墙够不着的敌人不会让 attackMove 停在墙根", () => {
  // 敌人在水对面看得见但过不去，终点在右边
  const rows = [".".repeat(16), ".".repeat(16), "~".repeat(16), ".".repeat(16)]
  let last: View | null = null
  play(mini(rows, [["grunt", 0, 1, 1], ["grunt", 1, 3, 3]], { maxTicks: 40 }), (v, cmd) => {
    last = v
    if (v.tick === 0) cmd.attackMove(mine(v, "grunt")[0], 14, 0)
  })
  const g = mine(last as unknown as View, "grunt")[0]
  assert.deepEqual([g.x, g.y], [14, 0])
})

void idle

test("队伍：盟友共享视野、看得见彼此的实体", () => {
  // 开迷雾；P0 在左边，盟友 P1 在右边，敌人 P2 只在 P1 视野里
  const rows = Array(5).fill(".".repeat(30))
  let p0View: View | null = null
  runMatch({
    ruleset: mini(rows, [["grunt", 0, 1, 2], ["grunt", 1, 25, 2], ["grunt", 2, 28, 2], ["grunt", 3, 14, 2]], { fog: true, maxTicks: 2, players: { min: 2, max: 4 } }),
    seed: 1,
    teams: [0, 0, 1, 1],
    bots: [
      { name: "a", file: "", runner: fnBot((v) => void (p0View ??= v)) },
      { name: "b", file: "", runner: idle() },
      { name: "c", file: "", runner: idle() },
      { name: "d", file: "", runner: idle() },
    ],
  })
  const v = p0View as unknown as View
  const owners = v.entities.map((e) => e.owner).sort()
  assert.deepEqual(owners, [0, 1, 2], "看得见自己、盟友，以及盟友视野里的敌人；看不见视野外的敌人 P3")
  assert.deepEqual(v.players.map((p) => p.team), [0, 0, 1, 1])
})

test("队伍：盟友之间不会自动攻击，攻击命令被拒", () => {
  const rows = Array(3).fill(".".repeat(10))
  const events: GameEvent[] = []
  let last: View | null = null
  runMatch({
    ruleset: mini(rows, [["grunt", 0, 4, 1], ["grunt", 1, 5, 1]], { maxTicks: 20 }),
    seed: 1,
    teams: [0, 0],
    bots: [
      {
        name: "a",
        file: "",
        runner: fnBot((v, cmd) => {
          events.push(...v.events)
          last = v
          if (v.tick === 0) cmd.attack(mine(v, "grunt")[0], v.entities.find((e) => e.owner === 1)!)
        }),
      },
      { name: "b", file: "", runner: idle() },
    ],
  })
  const reasons = events.filter((e) => e.kind === "rejected").map((e) => (e.kind === "rejected" ? e.reason : ""))
  assert.match(reasons[0] ?? "", /盟友/)
  for (const e of (last as unknown as View).entities) assert.equal(e.hp, 100, "贴在一起 20 tick 也没互相打")
})
