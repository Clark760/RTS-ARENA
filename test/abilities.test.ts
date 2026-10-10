// 技能、光环、被动（D-186）：内核的冷却、目标检查、onCast、光环加成、脱战回血、增益，以及格式检查
import assert from "node:assert/strict"
import { test } from "node:test"
import type { Commands, Entity, GameEvent, View } from "../src/api/bot-api.ts"
import { runMatch } from "../src/core/match.ts"
import type { RuleEvent, Ruleset, TypeSpec } from "../src/core/types.ts"
import { buffedDamage } from "../src/core/world.ts"
import { checkRulesetData } from "../src/sandbox/rules-check.ts"
import { STANDARD_TERRAIN } from "../rulesets/common/standard.ts"
import { fnBot } from "./helpers.ts"

const look = { shape: "circle" as const }
const TYPES: Record<string, TypeSpec> = {
  grunt: { kind: "unit", maxHp: 100, moveTicks: 1, sight: 4, attack: { damage: 10, range: 1, cooldown: 2 }, look },
  chief: {
    kind: "unit",
    maxHp: 100,
    moveTicks: 1,
    sight: 6,
    attack: { damage: 1, range: 1, cooldown: 10 },
    auras: [{ name: "战旗", radius: 3, types: ["grunt"], damagePct: 50, defensePct: 50 }],
    passives: [{ kind: "regen", name: "养伤", delay: 5, every: 2, amount: 3 }],
    skills: [
      { id: "drop", name: "放矿", cooldown: 5, target: "point", range: 3, desc: "在目标格附近放一个矿" },
      { id: "rage", name: "狂暴", cooldown: 20, desc: "自己伤害翻倍 3 tick" },
      { id: "nope", name: "不行", cooldown: 5, desc: "规则包总是拒绝" },
      { id: "smite", name: "惩戒", cooldown: 5, target: "unit", range: 2, desc: "目标掉 7 血" },
    ],
    look,
  },
  ore: { kind: "resource", resource: "gold", amount: 30, look },
}

type Spawn = [type: string, owner: number, x: number, y: number]

function mini(spawns: Spawn[], extra: Partial<Ruleset> = {}): Ruleset {
  return {
    id: "mini",
    name: "测试",
    players: { min: 2, max: 2 },
    maxTicks: 30,
    tickRate: 10,
    decisionInterval: 1,
    fuel: 100,
    unitCap: 0,
    fog: false,
    resources: ["gold"],
    terrain: STANDARD_TERRAIN,
    types: TYPES,
    setup(ctx) {
      ctx.setTerrain(Array(6).fill(".".repeat(12)))
      for (const [type, owner, x, y] of spawns) ctx.spawn(type, owner, x, y)
    },
    objectives: () => ({}),
    result: () => null,
    timeUp: () => ({ winner: null, reason: "到时间" }),
    onCast(ctx, c) {
      if (c.skill === "nope") return "就是不让放"
      if (c.skill === "drop") return ctx.spawnNear("ore", -1, c.x!, c.y!) === null ? "放不下" : null
      if (c.skill === "rage") ctx.addBuff(c.unit, { name: "狂暴", damagePct: 100, ticks: 3 })
      if (c.skill === "smite") ctx.setHp(c.target!, ctx.get(c.target!)!.hp - 7)
      return null
    },
    ...extra,
  }
}

function play(rules: Ruleset, p0: (view: View, cmd: Commands) => void, p1: (view: View, cmd: Commands) => void = () => {}) {
  return runMatch({ ruleset: rules, seed: 1, bots: [{ name: "a", file: "", runner: fnBot(p0) }, { name: "b", file: "", runner: fnBot(p1) }] })
}

const mine = (v: View, type: string) => v.entities.filter((e) => e.owner === v.me && e.type === type)

test("伤害公式：原伤害 ×（1 + 加成）×（1 − 减伤），四舍五入，原伤害大于 0 时至少 1", () => {
  assert.equal(buffedDamage(10, 0, 0), 10)
  assert.equal(buffedDamage(10, 25, 0), 13)
  assert.equal(buffedDamage(10, 0, 25), 8)
  assert.equal(buffedDamage(10, 25, 25), 9)
  assert.equal(buffedDamage(1, 0, 90), 1)
  assert.equal(buffedDamage(0, 50, 0), 0)
})

test("光环：范围内自己的兵伤害 +50%、受伤 −50%，bot 两边都看得到 buffs；范围外没有", () => {
  // P0 的首领在 (0, 0)，战士在 (2, 0)（3 格内）；P1 的战士贴着它在 (3, 0)。P0 还有一个战士在 (8, 5)，离首领太远
  const replay = play(
    mini([["chief", 0, 0, 0], ["grunt", 0, 2, 0], ["grunt", 1, 3, 0], ["grunt", 0, 8, 5]], { maxTicks: 1 }),
    () => {},
  )
  const hp = replay.frames[0].hp ?? []
  const after = new Map<number, number>()
  for (let i = 0; i < hp.length; i += 2) after.set(hp[i], hp[i + 1])
  const init = replay.initial.entities
  const p0near = init.find((e) => e.owner === 0 && e.type === "grunt" && e.x === 2)!
  const p1 = init.find((e) => e.owner === 1 && e.type === "grunt")!
  // 同一 tick 互相打：P0 的战士打出 15，P1 的战士只打出 5
  assert.equal(after.get(p1.id), 85)
  assert.equal(after.get(p0near.id), 95)
  // 回放记下增益的名字
  assert.deepEqual(
    (replay.frames[0].bf ?? []).find(([id]) => id === p0near.id),
    [p0near.id, ["战旗"]],
  )

  // 再打一局看 bot 的视图：自己和对手都看得到 P0 战士身上的 buffs，远处那个没有
  let ownView: View | null = null
  let enemyView: View | null = null
  play(
    mini([["chief", 0, 0, 0], ["grunt", 0, 2, 0], ["grunt", 1, 3, 0], ["grunt", 0, 8, 5]], { maxTicks: 3 }),
    (v) => {
      if (v.tick === 1) ownView = v
    },
    (v) => {
      if (v.tick === 1) enemyView = v
    },
  )
  const near = (v: View) => v.entities.find((e) => e.owner === 0 && e.type === "grunt" && e.x === 2)!
  assert.deepEqual(near(ownView!).buffs, [{ name: "战旗", damagePct: 50, defensePct: 50 }])
  assert.deepEqual(near(enemyView!).buffs, [{ name: "战旗", damagePct: 50, defensePct: 50 }])
  assert.equal(ownView!.entities.find((e) => e.x === 8)!.buffs, undefined)
  // 首领自己不吃（self 默认 false）
  assert.equal(mine(ownView!, "chief")[0].buffs, undefined)
})

test("脱战回血：最后一次挨打 5 tick 以后，每 2 tick 回 3", () => {
  // P1 的战士贴着首领打两下（第 1、3 tick），第 4 tick 规则包把它移走
  const replay = play(
    mini([["chief", 0, 5, 2], ["grunt", 1, 6, 2]], {
      maxTicks: 12,
      onTick(ctx) {
        if (ctx.tick === 4) for (const e of ctx.entities({ owner: 1 })) ctx.remove(e.id)
      },
    }),
    () => {},
  )
  const chief = replay.initial.entities.find((e) => e.type === "chief")!
  const hpAt: number[] = []
  let hp = chief.hp
  for (const f of replay.frames) {
    const h = f.hp ?? []
    for (let i = 0; i < h.length; i += 2) if (h[i] === chief.id) hp = h[i + 1]
    hpAt[f.t] = hp
  }
  assert.deepEqual(hpAt.slice(1, 12), [90, 90, 80, 80, 80, 80, 80, 83, 83, 86, 86])
})

test("技能：放成功开始冷却、冷却中被拒、目标超出射程被拒、规则包能拒绝、事件和回放都有记录", () => {
  const events: GameEvent[] = []
  const ruleEvents: RuleEvent[] = []
  let cdAfter: Record<string, number> | undefined
  const replay = play(
    mini([["chief", 0, 1, 1], ["grunt", 1, 10, 4]], {
      maxTicks: 4,
      onTick(ctx) {
        ruleEvents.push(...ctx.events.filter((e) => e.kind === "cast"))
      },
    }),
    (v, cmd) => {
      events.push(...v.events)
      const c = mine(v, "chief")[0]
      if (v.tick === 0) {
        cmd.cast(c, "drop", { x: 3, y: 2 })
        cmd.cast(c, "drop", { x: 3, y: 2 }) // 同一次调用里第二次：已经在冷却
        cmd.cast(c, "nope")
        cmd.cast(c, "fly")
      }
      if (v.tick === 1) {
        cdAfter = c.skillCooldowns
        cmd.cast(c, "smite", 99999) // 不存在的目标
        cmd.cast(c, "rage")
      }
      if (v.tick === 2) cmd.cast(c, "drop", { x: 9, y: 5 }) // 冷却中，同时也超出射程：先报冷却
    },
  )
  const rejected = events.filter((e) => e.kind === "rejected").map((e) => (e as { reason: string }).reason)
  assert.ok(rejected.some((r) => /放矿（drop）还在冷却，还要 5 tick/.test(r)), rejected.join("\n"))
  assert.ok(rejected.includes("就是不让放"))
  assert.ok(rejected.some((r) => /没有技能 "fly"，有：drop、rage、nope、smite/.test(r)))
  assert.ok(rejected.some((r) => /看不到目标 #99999/.test(r)))
  assert.ok(rejected.some((r) => /放矿（drop）还在冷却，还要 3 tick/.test(r)))
  // 第 1 tick 放成功的放矿冷却 5，结算时减 1；nope 被拒不进冷却
  assert.deepEqual(cdAfter, { drop: 4, rage: 0, nope: 0, smite: 0 })
  // 矿放在 (3, 2)
  assert.ok(replay.frames[0].spawn?.some((e) => e.type === "ore" && e.x === 3 && e.y === 2))
  // 回放和规则包事件
  assert.deepEqual(replay.frames[0].casts, [{ u: replay.initial.entities.find((e) => e.type === "chief")!.id, s: "drop", x: 3, y: 2 }])
  assert.deepEqual(
    ruleEvents.map((e) => (e as { skill: string }).skill),
    ["drop", "rage"],
  )
})

test("技能：目标超出 range 被拒；增益 addBuff 限时，到期自动去掉", () => {
  const events: GameEvent[] = []
  const seen: (Entity["buffs"] | undefined)[] = []
  play(
    mini([["chief", 0, 1, 1], ["grunt", 1, 10, 4]], { maxTicks: 6 }),
    (v, cmd) => {
      events.push(...v.events)
      const c = mine(v, "chief")[0]
      if (v.tick === 0) {
        cmd.cast(c, "drop", { x: 9, y: 5 })
        cmd.cast(c, "rage")
      }
      seen[v.tick] = c.buffs
    },
  )
  const rejected = events.filter((e) => e.kind === "rejected").map((e) => (e as { reason: string }).reason)
  assert.ok(rejected.some((r) => /\(9, 5\) 离 #\d+ 12 格，放矿 最远 3 格/.test(r)), rejected.join("\n"))
  assert.deepEqual(seen[1], [{ name: "狂暴", damagePct: 100, defensePct: 0, ticksLeft: 3 }])
  assert.deepEqual(seen[3], [{ name: "狂暴", damagePct: 100, defensePct: 0, ticksLeft: 1 }])
  assert.equal(seen[4], undefined)
})

test("技能造价（D-192）：放成功才扣，不够被拒，规则包拒绝时不扣；bot 在 game.types 里看得到 cost", () => {
  const events: GameEvent[] = []
  const gold: number[] = []
  const banker: TypeSpec = {
    kind: "unit",
    maxHp: 100,
    moveTicks: 1,
    sight: 4,
    skills: [
      { id: "buy", name: "花钱", cooldown: 2, cost: { gold: 20 }, desc: "花 20 金" },
      { id: "nope", name: "不行", cooldown: 2, cost: { gold: 5 }, desc: "规则包总是拒绝" },
    ],
    look,
  }
  const replay = play(
    mini([["banker", 0, 1, 1], ["grunt", 1, 10, 4]], {
      maxTicks: 6,
      types: { ...TYPES, banker },
      setup(ctx) {
        ctx.setTerrain(Array(6).fill(".".repeat(12)))
        ctx.spawn("banker", 0, 1, 1)
        ctx.spawn("grunt", 1, 10, 4)
        ctx.setResources(0, { gold: 30 })
      },
    }),
    (v, cmd) => {
      events.push(...v.events)
      gold[v.tick] = v.resources.gold
      const b = mine(v, "banker")[0]
      if (v.tick === 0) cmd.cast(b, "buy")
      if (v.tick === 1) cmd.cast(b, "nope")
      if (v.tick === 3) cmd.cast(b, "buy")
    },
  )
  assert.deepEqual(replay.types.banker.skills?.[0].cost, { gold: 20 })
  assert.equal(gold[1], 10)
  assert.equal(gold[2], 10)
  assert.equal(gold[4], 10)
  const rejected = events.filter((e) => e.kind === "rejected").map((e) => (e as { reason: string }).reason)
  assert.ok(rejected.some((r) => r === "就是不让放"), rejected.join("\n"))
  assert.ok(rejected.some((r) => /gold 不够：花钱要 20，现有 10/.test(r)), rejected.join("\n"))
})

test("击退（D-197、D-206）：领主视野内的敌方单位各自往外推 3 格，建筑和中立的不推；视野里没敌人被拒", async () => {
  const { lordType, regicideCast } = await import("../rulesets/common/regicide.ts")
  const events: GameEvent[] = []
  const before: Entity[] = []
  let after: Entity[] = []
  const types = { ...TYPES, lord: lordType(["grunt"], "repel"), hut: { kind: "building" as const, w: 1, h: 1, maxHp: 100, look } }
  play(
    mini([], {
      maxTicks: 3,
      types,
      setup(ctx) {
        ctx.setTerrain(Array(9).fill(".".repeat(26)))
        ctx.spawn("lord", 0, 6, 4)
        ctx.spawn("grunt", 1, 8, 4)
        ctx.spawn("grunt", 1, 6, 6)
        ctx.spawn("hut", 1, 9, 5)
        ctx.spawn("grunt", -1, 5, 4)
        ctx.spawn("lord", 1, 24, 4)
      },
      onCast: regicideCast,
    }),
    (v, cmd) => {
      events.push(...v.events)
      if (v.tick === 0) {
        before.push(...v.entities)
        cmd.cast(mine(v, "lord")[0], "repel")
      }
      after = v.entities
    },
    (v, cmd) => {
      events.push(...v.events)
      // 视野里没有敌人：被拒
      if (v.tick === 0) cmd.cast(mine(v, "lord")[0], "repel")
    },
  )
  const far = (e: Entity) => Math.abs(e.x - 6) + Math.abs(e.y - 4)
  const grunts = after.filter((e) => e.type === "grunt" && e.owner === 1)
  assert.equal(grunts.length, 2)
  // 两个都离领主 2 格，推到 5 格
  assert.ok(grunts.every((e) => far(e) === 5), JSON.stringify(grunts.map((e) => [e.x, e.y])))
  // 建筑、中立的不动
  const at = (list: Entity[], type: string, owner: number) => list.find((e) => e.type === type && e.owner === owner)!
  assert.deepEqual([at(after, "hut", 1).x, at(after, "hut", 1).y], [9, 5])
  assert.deepEqual([at(after, "grunt", -1).x, at(after, "grunt", -1).y], [5, 4])
  assert.ok(events.some((e) => e.kind === "rejected" && /视野（8 格）里没有敌方单位/.test(e.reason)))
})

test("技能：规则包没导出 onCast 时都被拒", () => {
  const events: GameEvent[] = []
  play(
    mini([["chief", 0, 1, 1], ["grunt", 1, 10, 4]], { maxTicks: 2, onCast: undefined }),
    (v, cmd) => {
      events.push(...v.events)
      if (v.tick === 0) cmd.cast(mine(v, "chief")[0], "rage")
    },
  )
  assert.ok(events.some((e) => e.kind === "rejected" && /规则包没有实现技能的效果（onCast）/.test(e.reason)))
})

test("格式检查：技能、光环、被动写错会报出来；有技能没导出 onCast 也报", () => {
  const base = {
    id: "t",
    name: "测试",
    players: { min: 2, max: 2 },
    maxTicks: 100,
    tickRate: 10,
    decisionInterval: 1,
    fuel: 100,
    unitCap: 0,
    fog: false,
    resources: ["gold"],
    terrain: { ".": { walkable: true, color: "#000000" } },
  }
  const fns = ["setup", "objectives", "result", "timeUp"]
  const types = {
    a: {
      kind: "unit",
      maxHp: 10,
      look,
      skills: [{ id: "X", name: "名字太长太长太长", cooldown: 0, desc: "" }, { id: "go", name: "去", cooldown: 5, desc: "走", target: "point" }],
      auras: [{ name: "环", affects: "everyone", types: ["nobody"] }],
      passives: [{ kind: "heal", name: "回" }],
    },
  }
  const errs = checkRulesetData({ ...base, types }, fns).join("\n")
  for (const want of [
    /skills\[0\]\.id 要是小写字母开头/,
    /skills\[0\]\.name 要写 1～6 个字/,
    /skills\[0\]\.desc 要写 1～80 字/,
    /skills\[0\]\.cooldown 要是 1～100000/,
    /skills\[1\]：target 是 point 时要写 range/,
    /auras\[0\]\.affects 要是 own、allies、enemies/,
    /auras\[0\]\.types 要是已定义的类型名数组/,
    /auras\[0\]：damagePct、defensePct 至少写一项/,
    /passives\[0\] 现在只支持 \{ kind: "regen"/,
    /a 有技能（skills），要导出 onCast/,
  ])
    assert.match(errs, want)
  assert.doesNotMatch(checkRulesetData({ ...base, types }, [...fns, "onCast"]).join("\n"), /要导出 onCast/)
})

test("野怪定时刷新（D-193）：每 900 tick 把死掉的野怪补满，营地没清空也补；赏金按规则包写的给", async () => {
  const { campInfo, creepTick, creepType, setupCamps } = await import("../rulesets/common/creeps.ts")
  const W = 30
  const H = 20
  const rules = mini([], {
    maxTicks: 905,
    types: { ...TYPES, creep: creepType(), brute: { kind: "unit", maxHp: 5000, moveTicks: 1, sight: 6, attack: { damage: 200, range: 1, cooldown: 2 }, look } },
    setup(ctx) {
      ctx.setTerrain(Array(H).fill(".".repeat(W)))
      setupCamps(ctx, W, H, { x: 12, y: 11 }, { x: 6, y: 15 }, { bounty: 150, respawn: "periodic" })
      const c = campInfo()[0]
      ctx.spawnNear("brute", 0, c.x, c.y - 1)
    },
    onTick: (ctx) => creepTick(ctx),
    objectives: () => campInfo(),
  })
  const seen: { tick: number; alive: number; respawnAt: number | null; gold: number }[] = []
  let target: number | undefined
  play(rules, (v, cmd) => {
    const c0 = (v.objectives as ReturnType<typeof campInfo>)[0]
    seen.push({ tick: v.tick, alive: c0.alive, respawnAt: c0.respawnAt, gold: v.resources.gold })
    const u = mine(v, "brute")[0]
    // 打死第一只就跑远（离营地 8 格以外，野怪回去）
    if (target === undefined) {
      const k = v.entities.find((e) => e.type === "creep" && Math.abs(e.x - c0.x) + Math.abs(e.y - c0.y) <= 2)
      if (k) {
        target = k.id
        cmd.attack(u, k)
      }
    } else if (!v.entities.some((e) => e.id === target) && u.order?.kind !== "move") cmd.move(u, 0, 0)
  })
  const after = seen.find((s) => s.alive === 2)!
  assert.equal(after.respawnAt, 900)
  assert.equal(after.gold - seen[0].gold, 150)
  const last = seen[seen.length - 1]
  assert.equal(last.alive, 3)
  assert.equal(last.respawnAt, null)
})

test("并行生产（D-196）：parallel 3 的建筑，队列里前 3 个同时造，第 4 个等前面的造完才开始", () => {
  const rax: TypeSpec = { kind: "building", w: 2, h: 2, maxHp: 500, produces: ["trooper"], parallel: 3, look }
  const trooper: TypeSpec = { ...TYPES.grunt, cost: { gold: 10 }, buildTicks: 10 }
  const count: number[] = []
  play(
    mini([], {
      maxTicks: 25,
      types: { ...TYPES, rax, trooper },
      setup(ctx) {
        ctx.setTerrain(Array(6).fill(".".repeat(12)))
        ctx.spawn("rax", 0, 4, 2)
        ctx.spawn("grunt", 1, 11, 5)
        ctx.setResources(0, { gold: 100 })
      },
    }),
    (v, cmd) => {
      if (v.tick === 0) for (let i = 0; i < 4; i++) cmd.produce(mine(v, "rax")[0], "trooper")
      count[v.tick] = mine(v, "trooper").length
    },
  )
  // 前 3 个第 10 tick 一起出来，第 4 个再等 10 tick
  assert.equal(count[9], 0)
  assert.equal(count[11], 3)
  assert.equal(count[19], 3)
  assert.equal(count[21], 4)
})

test("中央宝箱（D-202、D-206）：第 900 tick 在正中两格各刷一个，都打掉得 600 金；正中被挡就换离正中最近、中心对称的一对格子", async () => {
  const { setupTreasure, treasureInfo, treasureTick, treasureType, TREASURE_EVERY, TREASURE_GOLD } = await import("../rulesets/common/treasure.ts")
  const W = 20
  const H = 10
  const brute: TypeSpec = { kind: "unit", maxHp: 5000, moveTicks: 1, sight: 6, attack: { damage: 300, range: 1, cooldown: 2 }, look }
  const play2 = (terrain: string[]) => {
    const gold: number[] = []
    let info: ReturnType<typeof treasureInfo> | null = null
    play(
      mini([], {
        maxTicks: TREASURE_EVERY + 40,
        types: { ...TYPES, treasure: treasureType(), brute },
        setup(ctx) {
          ctx.setTerrain(terrain)
          ctx.spawn("brute", 0, 0, 0)
          ctx.spawn("grunt", 1, W - 1, H - 1)
          setupTreasure(ctx, W, H)
        },
        onTick: (ctx) => treasureTick(ctx),
        objectives: (ctx) => treasureInfo(ctx),
      }),
      (v, cmd) => {
        gold[v.tick] = v.resources.gold
        info = v.objectives as ReturnType<typeof treasureInfo>
        // 宝箱出来就过去打
        const box = v.entities.find((e) => e.type === "treasure")
        const u = mine(v, "brute")[0]
        if (box && u && u.order?.kind !== "attack") cmd.attack(u, box)
      },
    )
    return { gold, info: info! }
  }
  // 正中能放：正中 2×2 里斜对着的两格，两个都打掉得 600
  const open = play2(Array(H).fill(".".repeat(W)))
  assert.deepEqual(open.info.spots, [{ x: W / 2 - 1, y: H / 2 - 1 }, { x: W / 2, y: H / 2 }])
  assert.equal(open.gold[TREASURE_EVERY - 1], 0)
  assert.equal(open.gold[TREASURE_EVERY + 39], TREASURE_GOLD)
  // 正中是墙：离正中最近、中心对称的一对格子
  const rows = Array(H).fill(".".repeat(W))
  rows[4] = ".".repeat(8) + "####" + ".".repeat(8)
  rows[5] = ".".repeat(8) + "####" + ".".repeat(8)
  const walled = play2(rows)
  assert.equal(walled.info.spots.length, 2)
  const [a, b] = walled.info.spots
  assert.deepEqual([b.x, b.y], [W - 1 - a.x, H - 1 - a.y])
  assert.deepEqual(a, { x: 9, y: 3 })
})

test("中央宝箱（D-205、D-206）：刷新那一刻站在宝箱格子上的一方直接捡到这个宝箱（放特效）；站着野怪就等它走开", async () => {
  const { setupTreasure, treasureTick, treasureType, TREASURE_EVERY, TREASURE_GOLD } = await import("../rulesets/common/treasure.ts")
  // 在 20×10 的空地上，两个宝箱的格子是 (9, 4)、(10, 5)；放好 P0、P1、中立的兵，看第 900 tick 之后的结果
  const half = TREASURE_GOLD / 2
  const run = (units: [number, number, number][]) => {
    const gold: number[][] = [[], []]
    let boxes: [number, number][] = []
    const replay = play(
      mini([], {
        maxTicks: TREASURE_EVERY + 2,
        types: { ...TYPES, treasure: treasureType() },
        setup(ctx) {
          ctx.setTerrain(Array(10).fill(".".repeat(20)))
          for (const [owner, x, y] of units) ctx.spawn("grunt", owner, x, y)
          if (!units.some((u) => u[0] === 0)) ctx.spawn("grunt", 0, 0, 0)
          if (!units.some((u) => u[0] === 1)) ctx.spawn("grunt", 1, 19, 9)
          setupTreasure(ctx, 20, 10)
        },
        onTick: (ctx) => treasureTick(ctx),
      }),
      (v) => {
        gold[0][v.tick] = v.resources.gold
        boxes = v.entities.filter((e) => e.type === "treasure").map((e) => [e.x, e.y])
      },
      (v) => {
        gold[1][v.tick] = v.resources.gold
      },
    )
    const fx = replay.frames.flatMap((f) => f.fx ?? [])
    return { g0: gold[0][TREASURE_EVERY + 1], g1: gold[1][TREASURE_EVERY + 1], boxes, fx }
  }
  // P0 两格都占：两个都捡到，一个都不刷出来，放两个特效
  const both = run([[0, 9, 4], [0, 10, 5]])
  assert.deepEqual([both.g0, both.g1, both.boxes], [TREASURE_GOLD, 0, []])
  assert.deepEqual(both.fx, [
    { x: 9, y: 4, w: 1, h: 1, text: `P0 +${half}`, color: "#f2c14e" },
    { x: 10, y: 5, w: 1, h: 1, text: `P0 +${half}`, color: "#f2c14e" },
  ])
  // 一人一格：各捡一个
  const split = run([[0, 9, 4], [1, 10, 5]])
  assert.deepEqual([split.g0, split.g1, split.boxes], [half, half, []])
  // 只占一格：捡到这一个，另一格照常刷出
  const one = run([[0, 9, 4]])
  assert.deepEqual([one.g0, one.g1, one.boxes], [half, 0, [[10, 5]]])
  // 中立的单位站着：那一格等着不刷，另一格照常刷出
  const neutral = run([[-1, 9, 4]])
  assert.deepEqual([neutral.g0, neutral.g1, neutral.boxes], [0, 0, [[10, 5]]])
})

test("死亡事件带 killerType（D-203）：最后一击的实体类型，规则包据此可以让某些实体打死的不算分", () => {
  const died: RuleEvent[] = []
  const turret: TypeSpec = { kind: "building", w: 1, h: 1, maxHp: 500, attack: { damage: 50, range: 3, cooldown: 2 }, look }
  play(
    mini([["grunt", 1, 4, 2]], {
      maxTicks: 20,
      types: { ...TYPES, turret },
      setup(ctx) {
        ctx.setTerrain(Array(6).fill(".".repeat(12)))
        ctx.spawn("turret", 0, 2, 2)
        ctx.spawn("grunt", 1, 4, 2)
      },
      onTick(ctx) {
        died.push(...ctx.events.filter((e) => e.kind === "died"))
      },
    }),
    () => {},
  )
  assert.equal(died.length, 1)
  assert.deepEqual([died[0].kind === "died" && died[0].killer, died[0].kind === "died" && died[0].killerType], [0, "turret"])
})

test("attackMove 写 { neutral: true } 也打中立单位，射程里有对手的先打对手的；不写就不打中立的（D-191）", () => {
  const hpOf = (v: View, owner: number) => v.entities.find((e) => e.owner === owner && e.type === "grunt")?.hp
  // 不写 neutral：从中立的旁边走过去，一下都不打它
  let neutralHp: (number | undefined)[] = []
  play(mini([["grunt", 0, 1, 2], ["grunt", -1, 2, 3]], { maxTicks: 12 }), (v, cmd) => {
    if (v.tick === 0) cmd.attackMove(mine(v, "grunt")[0], 11, 2)
    neutralHp.push(hpOf(v, -1))
  })
  assert.ok(neutralHp.every((h) => h === 100))
  // 写了 neutral：停下来打旁边的中立单位
  neutralHp = []
  let order: Entity["order"] | undefined
  play(mini([["grunt", 0, 2, 2], ["grunt", -1, 2, 3]], { maxTicks: 12 }), (v, cmd) => {
    if (v.tick === 0) cmd.attackMove(mine(v, "grunt")[0], 11, 2, { neutral: true })
    neutralHp.push(hpOf(v, -1))
    order = mine(v, "grunt")[0]?.order
  })
  assert.ok(neutralHp[neutralHp.length - 1]! < 100)
  assert.deepEqual(order, { kind: "attackMove", x: 11, y: 2, neutral: true })
  // 中立单位和对手的兵都在射程里：先打对手的
  let hp: { neutral?: number; foe?: number } = {}
  play(mini([["grunt", 0, 2, 2], ["grunt", -1, 2, 3], ["grunt", 1, 3, 2]], { maxTicks: 10 }), (v, cmd) => {
    if (v.tick === 0) cmd.attackMove(mine(v, "grunt")[0], 11, 2, { neutral: true })
    hp = { neutral: hpOf(v, -1), foe: hpOf(v, 1) }
  })
  assert.equal(hp.neutral, 100)
  assert.ok(hp.foe! < 100)
})

test("野怪营地（D-189）：两两中心对称；打死一只给最后一击的玩家赏金，清空后记下 900 tick 后刷新", async () => {
  const { campInfo, creepBounty, creepTick, creepTimeUp, creepType, setupCamps, CREEP_BOUNTY, CREEP_RESPAWN } = await import("../rulesets/common/creeps.ts")
  const W = 30
  const H = 20
  const rules = mini([], {
    maxTicks: 60,
    types: { ...TYPES, creep: creepType(), brute: { kind: "unit", maxHp: 5000, moveTicks: 1, sight: 6, attack: { damage: 200, range: 1, cooldown: 2 }, look } },
    setup(ctx) {
      ctx.setTerrain(Array(H).fill(".".repeat(W)))
      setupCamps(ctx, W, H, { x: 12, y: 11 }, { x: 6, y: 15 })
      const c = campInfo()[0]
      // 贴着第一个营地放两个打手
      ctx.spawnNear("brute", 0, c.x, c.y - 1)
      ctx.spawnNear("brute", 0, c.x + 1, c.y - 1)
    },
    onTick: (ctx) => creepTick(ctx),
    objectives: () => campInfo(),
    // 到时间：原来的判法是平局，比野怪赏金（D-191）
    timeUp: (ctx) => creepTimeUp(ctx, { winner: null, reason: "时间到，平局" }),
  })
  let last: View | null = null
  let gold0 = 0
  const replay = play(rules, (v, cmd) => {
    if (v.tick === 0) gold0 = v.resources.gold
    last = v
    // 只打第一个营地的
    const c0 = (v.objectives as ReturnType<typeof campInfo>)[0]
    const creeps = v.entities.filter((e) => e.type === "creep" && Math.abs(e.x - c0.x) + Math.abs(e.y - c0.y) <= 3)
    for (const u of mine(v, "brute")) {
      let best: Entity | undefined
      for (const c of creeps) if (!best || Math.abs(c.x - u.x) + Math.abs(c.y - u.y) < Math.abs(best.x - u.x) + Math.abs(best.y - u.y)) best = c
      if (best) cmd.attack(u, best)
    }
  })
  const camps = last!.objectives as ReturnType<typeof campInfo>
  // 4 个营地：两对，每对中心对称
  assert.equal(camps.length, 4)
  assert.deepEqual([camps[1].x, camps[1].y], [W - 1 - camps[0].x, H - 1 - camps[0].y])
  assert.deepEqual([camps[3].x, camps[3].y], [W - 1 - camps[2].x, H - 1 - camps[2].y])
  assert.deepEqual(camps.map((c) => c.size), [3, 3, 2, 2])
  // 第一个营地被打光：3 只的赏金，记下刷新时间
  assert.equal(camps[0].alive, 0)
  assert.equal(last!.resources.gold - gold0, 3 * CREEP_BOUNTY)
  assert.ok(camps[0].respawnAt !== null && camps[0].respawnAt > CREEP_RESPAWN && camps[0].respawnAt <= 60 + CREEP_RESPAWN)
  assert.ok(camps.slice(1).every((c) => c.alive === c.size && c.respawnAt === null))
  // 每个营地的格子（D-191）：第一格就是 x、y，中心对称的营地格子也是镜像
  assert.deepEqual(camps.map((c) => c.cells.length), [3, 3, 2, 2])
  assert.deepEqual(camps[0].cells[0], { x: camps[0].x, y: camps[0].y })
  assert.deepEqual(camps[1].cells, camps[0].cells.map((p) => ({ x: W - 1 - p.x, y: H - 1 - p.y })))
  assert.ok(camps.slice(1).every((c) => c.angry === false))
  assert.deepEqual(creepBounty(2), [3 * CREEP_BOUNTY, 0])
  // 到时间平局时赏金多的赢
  assert.deepEqual(replay.result.winners, [0])
  assert.match(replay.result.reason, new RegExp(`野怪赏金 ${3 * CREEP_BOUNTY} : 0`))
})
