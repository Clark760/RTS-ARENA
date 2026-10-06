import assert from "node:assert/strict"
import { test } from "node:test"
import { compileBot, createBot, type QuickJSBot } from "../src/sandbox/quickjs.ts"

const GAME = JSON.stringify({ me: 0, width: 10, height: 10 })
const VIEW = (tick: number) => JSON.stringify({ tick, me: 0, entities: [{ id: 5, x: 1, y: 1, w: 1, h: 1 }], events: [] })

async function bot(src: string, fuel = 50, seed = 1, memoryBytes?: number): Promise<QuickJSBot> {
  const c = compileBot(src)
  if ("error" in c) throw new Error(c.error)
  return createBot(c.code, seed, { fuel, memoryBytes })
}

test("正常调用：命令、日志、实体或 id 都能当参数", async () => {
  const b = await bot(`
    let n: number = 0
    export function onTick(view: View, cmd: Commands): void {
      n++
      console.log("tick", view.tick, { n })
      cmd.move(view.entities[0], 3, 4)
      cmd.attack(5, view.entities[0])
    }`)
  assert.equal(b.start(GAME).fatal, undefined)
  const r = b.tick(VIEW(0))
  assert.deepEqual(r.commands, [
    { kind: "move", unit: 5, x: 3, y: 4 },
    { kind: "attack", unit: 5, target: 5 },
  ])
  assert.deepEqual(r.logs, ['tick 0 {"n":1}'])
  assert.deepEqual(b.tick(VIEW(1)).logs, ['tick 1 {"n":2}'])
  b.dispose()
})

test("死循环：燃料耗尽、命令作废，下次调用照常", async () => {
  const b = await bot(`
    export function onTick(view: View, cmd: Commands) {
      cmd.stop(1)
      console.log("before")
      if (view.tick === 0) while (true) {}
      cmd.stop(2)
    }`)
  b.start(GAME)
  const r = b.tick(VIEW(0))
  assert.equal(r.fuelOut, true)
  assert.match(r.error!, /燃料耗尽/)
  assert.deepEqual(r.commands, [])
  assert.deepEqual(r.logs, ["before"])
  const r2 = b.tick(VIEW(1))
  assert.equal(r2.error, undefined)
  assert.equal(r2.commands.length, 2)
  b.dispose()
})

test("燃料计数确定：同样的代码两次用量相同", async () => {
  const src = `export function onTick(view: View) { let s = 0; for (let i = 0; i < 200000; i++) s += i % 7; console.log(s) }`
  const a = await bot(src, 1000)
  const b = await bot(src, 1000)
  a.start(GAME)
  b.start(GAME)
  const ra = a.tick(VIEW(0))
  const rb = b.tick(VIEW(0))
  assert.ok(ra.fuel > 10)
  assert.equal(ra.fuel, rb.fuel)
  a.dispose()
  b.dispose()
})

test("抛错：带源文件行号，命令作废", async () => {
  const b = await bot(`
type X = { a: number }
export function onTick(view: View, cmd: Commands) {
  cmd.stop(1)
  const x: X | undefined = undefined
  return (x as any).a
}`)
  b.start(GAME)
  const r = b.tick(VIEW(0))
  assert.match(r.error!, /TypeError/)
  assert.match(r.error!, /bot\.ts:6/)
  assert.deepEqual(r.commands, [])
  b.dispose()
})

test("Date 不可用，Math.random 按种子确定", async () => {
  const src = `export function onTick(view: View) { console.log(Math.random()); if (view.tick === 1) Date.now() }`
  const a = await bot(src, 50, 9)
  const b = await bot(src, 50, 9)
  const c = await bot(src, 50, 10)
  for (const x of [a, b, c]) x.start(GAME)
  const la = a.tick(VIEW(0)).logs[0]
  assert.equal(la, b.tick(VIEW(0)).logs[0])
  assert.notEqual(la, c.tick(VIEW(0)).logs[0])
  assert.match(a.tick(VIEW(1)).error!, /不能用 Date/)
  for (const x of [a, b, c]) x.dispose()
})

test("内存超限：bot 停止运行，别的 bot 不受影响", async () => {
  const other = await bot(`export function onTick(view: View, cmd: Commands) { cmd.stop(1) }`)
  other.start(GAME)
  for (const src of [
    `const keep: number[][] = []; export function onTick() { for (;;) keep.push(new Array(1000).fill(1)) }`,
    `const keep: string[] = []; export function onTick() { for (;;) keep.push("x".repeat(100000) + Math.random()) }`,
    `const keep: object[] = []; export function onTick() { for (;;) keep.push({ a: 1, b: [1, 2] }) }`,
  ]) {
    const b = await bot(src, 1e9, 1, 32 * 1024 * 1024)
    b.start(GAME)
    const r = b.tick(VIEW(0))
    assert.match(r.fatal ?? "", /内存超限/, src)
    assert.match(b.tick(VIEW(1)).fatal ?? "", /沙箱已损坏/)
    b.dispose()
    assert.deepEqual(other.tick(VIEW(0)).commands, [{ kind: "stop", unit: 1 }])
  }
  other.dispose()
})

test("没有导出 onTick、顶层出错：加载失败", async () => {
  const a = await bot(`export function onStart() {}`)
  assert.match(a.start(GAME).fatal ?? "", /没有导出 onTick/)
  a.dispose()
  const b = await bot(`throw new Error("顶层炸了")\nexport function onTick() {}`)
  assert.match(b.start(GAME).fatal ?? "", /顶层炸了/)
  b.dispose()
})

test("编译与导出：export const、同一行、export { } 都行；enum、import 不行（注释里的 import 不算）", async () => {
  for (const src of [
    `export const onTick = (view: View, cmd: Commands) => cmd.stop(7)`,
    `const n = 1; export function onTick(view: View, cmd: Commands) { cmd.stop(7) }`,
    `function onTick(view: View, cmd: Commands) { cmd.stop(7) }\nexport { onTick }`,
  ]) {
    const ok = await bot(src)
    assert.equal(ok.start(GAME).fatal, undefined, src)
    assert.deepEqual(ok.tick(VIEW(0)).commands, [{ kind: "stop", unit: 7 }], src)
    ok.dispose()
  }
  const def = await bot(`export default function onTick() {}`)
  assert.match(def.start(GAME).fatal ?? "", /没有导出 onTick/)
  def.dispose()
  assert.ok("error" in compileBot(`enum A { x }\nexport function onTick() {}`))
  const imp = await bot(`import { x } from "./y"\nexport function onTick() {}`)
  assert.match(imp.start(GAME).fatal ?? "", /不能 import/)
  imp.dispose()
  // 注释和字符串里的 import 不算
  const fake = await bot("/*\nimport 什么都行\n*/\nconst s = `\nimport x`\nexport function onTick(view: View, cmd: Commands) { cmd.stop(1) }")
  assert.equal(fake.start(GAME).fatal, undefined)
  fake.dispose()
  assert.ok("code" in compileBot(`import type { X } from "./y"\nexport function onTick() {}`))
})

test("bot 改不了宿主拿到的函数", async () => {
  const b = await bot(`
    (globalThis as any).__arena = { tick: () => "hacked" }
    JSON.stringify = () => "{}"
    export function onTick(view: View, cmd: Commands) { cmd.stop(3) }`)
  b.start(GAME)
  assert.deepEqual(b.tick(VIEW(0)).commands, [{ kind: "stop", unit: 3 }])
  b.dispose()
})

test("不计燃料的内置操作超过墙钟：调用结束后判停止", async () => {
  const c = compileBot(`export function onTick() { const a: number[] = []; for (let i = 0; i < 2e6; i++) a.push((i * 7919) % 1000003); a.sort(); a.sort(); a.sort() }`)
  if ("error" in c) throw new Error(c.error)
  const b = await createBot(c.code, 1, { fuel: 1e6, hardMs: 30 })
  b.start(GAME)
  assert.match(b.tick(VIEW(0)).fatal ?? "", /墙钟超时/)
  b.dispose()
})

test("命令参数里的 toJSON、getter 不会在序列化时执行；命令最多 2000 条", async () => {
  const b = await bot(`
    export function onTick(view: View, cmd: Commands) {
      cmd.move(1, { toJSON() { for (;;) {} } } as any, 0)
      if (view.tick === 1) for (let i = 0; i < 2500; i++) cmd.stop(1)
    }`)
  b.start(GAME)
  const r = b.tick(VIEW(0))
  assert.equal(r.error, undefined)
  assert.deepEqual(r.commands, [{ kind: "move", unit: 1, x: null, y: 0 }])
  const r2 = b.tick(VIEW(1))
  assert.equal(r2.commands.length, 2000)
  assert.match(r2.logs.join("\n"), /另有 501 条命令/)
  b.dispose()
})

test("改原型绕过 prelude 的上限：宿主照样截断，不崩", async () => {
  // 改根对象的 toJSON，再耗尽燃料：取回日志时拿到的是乱的结构
  const a = await bot(`
    (Object.prototype as any).toJSON = function () { return 1 }
    export function onTick(view: View) { if (view.tick === 0) for (;;) {} }`)
  a.start(GAME)
  const ra = a.tick(VIEW(0))
  assert.equal(ra.fuelOut, true)
  assert.deepEqual(ra.logs, [])
  a.dispose()
  // 改 slice 和 push：每行超长、行数超限、命令超限
  const b = await bot(`
    String.prototype.slice = function (this: string) { return String(this) } as any
    Array.prototype.push = function (this: unknown[], ...xs: unknown[]) { for (const x of xs) this[this.length] = x; return this.length }
    export function onTick(view: View, cmd: Commands) {
      for (let i = 0; i < 50; i++) console.log("x".repeat(5000))
      for (let i = 0; i < 2500; i++) cmd.stop(1)
    }`, 1000)
  b.start(GAME)
  const rb = b.tick(VIEW(0))
  assert.equal(rb.commands.length, 2000)
  assert.ok(rb.logs.length <= 22)
  for (const l of rb.logs) assert.ok(l.length <= 301)
  b.dispose()
})

test("深递归：沙箱里抛出能接住的错误，不撑爆宿主", async () => {
  const b = await bot(`
    function r(n: number): number { return n === 0 ? 0 : r(n - 1) + 1 }
    export function onTick(view: View) {
      try { r(100000) } catch (e) { console.log("接住了", String(e)) }
      console.log("还活着", r(500))
    }`, 1e6)
  b.start(GAME)
  const r = b.tick(VIEW(0))
  assert.equal(r.fatal, undefined)
  assert.match(r.logs.join("\n"), /接住了.*stack overflow/)
  assert.match(r.logs.join("\n"), /还活着 500/)
  b.dispose()
})

test("整局累计耗时超限：判停止", async () => {
  const c = compileBot(`export function onTick() { let s = 0; for (let i = 0; i < 300000; i++) s += i }`)
  if ("error" in c) throw new Error(c.error)
  const b = await createBot(c.code, 1, { fuel: 1e6, matchMs: 30 })
  b.start(GAME)
  let fatal: string | undefined
  for (let i = 0; i < 50 && !fatal; i++) fatal = b.tick(VIEW(i)).fatal
  assert.match(fatal ?? "", /整局累计耗时/)
  b.dispose()
})

test("canBuild：地图内、地形可走、没有实体、有迷雾时每格都在己方视野里；cmd.build 的参数", async () => {
  const game = (fog: boolean) =>
    JSON.stringify({
      me: 0,
      width: 6,
      height: 4,
      fog,
      terrain: ["......", "..#...", "......", "......"],
      walkable: { ".": true, "#": false },
      types: { hut: { kind: "building", w: 2, h: 2, sight: 1 }, peon: { kind: "unit", w: 1, h: 1, sight: 4 } },
    })
  const view = JSON.stringify({
    tick: 0,
    me: 0,
    players: [{ team: 0 }, { team: 1 }],
    entities: [
      { id: 1, type: "peon", owner: 0, x: 0, y: 0, w: 1, h: 1 },
      { id: 2, type: "peon", owner: 1, x: 5, y: 3, w: 1, h: 1 },
    ],
    events: [],
  })
  const src = `
    export function onTick(view: View, cmd: Commands) {
      const spots: [string, number, number][] = [["hut", 0, 0], ["hut", 1, 0], ["hut", 0, 1], ["hut", 3, 2], ["hut", 5, 0], ["peon", 0, 2], ["hut", 0.5, 1], ["hut", 4, 2]]
      console.log(JSON.stringify(spots.map(([t, x, y]) => canBuild(view, t as TypeName, x, y))))
      console.log(JSON.stringify(spots.map(([t, x, y]) => buildProblem(view, t as TypeName, x, y))))
      cmd.build(view.entities[0], "hut", 0, 1)
    }`
  const results: unknown[] = []
  const reasons: (string | null)[][] = []
  for (const fog of [true, false]) {
    const b = await bot(src)
    b.start(game(fog))
    const r = b.tick(view)
    results.push(JSON.parse(r.logs[0]))
    reasons.push(JSON.parse(r.logs[1]))
    assert.deepEqual(r.commands, [{ kind: "build", unit: 1, type: "hut", x: 0, y: 1 }])
    b.dispose()
  }
  // 依次：压着自己的工人、压着岩石、可以、迷雾里看不见（无迷雾时可以）、超出地图、不是建筑、坐标不是整数、压着敌人
  assert.deepEqual(results, [
    [false, false, true, false, false, false, false, false],
    [false, false, true, true, false, false, false, false],
  ])
  // buildProblem：和 canBuild 判断一致，放不下时说原因
  assert.deepEqual(
    reasons.map((list) => list.map((x: string | null) => x === null)),
    results,
  )
  assert.match(reasons[0][0] ?? "", /有 #1（peon）挡着/)
  assert.match(reasons[0][1] ?? "", /地形不能建造/)
  assert.match(reasons[0][3] ?? "", /不在你方视野里/)
  assert.match(reasons[0][4] ?? "", /超出地图/)
  assert.match(reasons[0][5] ?? "", /不是建筑/)
  // 看不见的格子里的敌人：有迷雾时只说看不见
  assert.match(reasons[0][7] ?? "", /不在你方视野里/)
  assert.match(reasons[1][7] ?? "", /有 #2（peon）挡着/)
})

test("buildProblem 的顺序和引擎一样（地形、资源点先于视野）；findBuildSpot 找附近放得下的位置", async () => {
  const game = JSON.stringify({
    me: 0,
    width: 10,
    height: 5,
    fog: true,
    terrain: ["........#.", "..........", "..........", "..........", ".........."],
    walkable: { ".": true, "#": false },
    types: { hut: { kind: "building", w: 2, h: 2, sight: 1 }, peon: { kind: "unit", w: 1, h: 1, sight: 3 }, ore: { kind: "resource", w: 1, h: 1, sight: 0 } },
  })
  const view = JSON.stringify({
    tick: 0,
    me: 0,
    players: [{ team: 0 }, { team: 1 }],
    entities: [
      { id: 1, type: "peon", owner: 0, x: 0, y: 0, w: 1, h: 1 },
      { id: 5, type: "ore", owner: -1, x: 8, y: 3, w: 1, h: 1 },
      { id: 6, type: "ore", owner: -1, x: 2, y: 3, w: 1, h: 1 },
    ],
    events: [],
  })
  const b = await bot(`
    export function onTick(view: View, cmd: Commands) {
      console.log(JSON.stringify([buildProblem(view, "hut" as TypeName, 7, 0), buildProblem(view, "hut" as TypeName, 8, 2), buildProblem(view, "hut" as TypeName, 5, 2)]))
      const spot = findBuildSpot(view, "hut" as TypeName, { x: 0, y: 0 })
      console.log(JSON.stringify([spot, spot && buildProblem(view, "hut" as TypeName, spot.x, spot.y), findBuildSpot(view, "hut" as TypeName, { x: 0, y: 0 }, 1), findBuildSpot(view, "hut" as TypeName, { x: 0, y: 0 }, 8, 0)]))
    }`)
  b.start(game)
  const r = b.tick(view)
  const [a, c] = r.logs.map((l) => JSON.parse(l))
  assert.match(a[0], /\(8, 0\) 的地形不能建造/)
  assert.match(a[1], /\(8, 3\) 有 #5（ore）挡着/)
  assert.match(a[2], /不在你方视野里/)
  // 离 (0, 0) 最近、四周一格不挨着资源点 (2, 3) 的位置；半径 1 以内没有；不留空就能更近
  assert.deepEqual(c, [{ x: 1, y: 0 }, null, null, { x: 0, y: 1 }])
  b.dispose()
})
