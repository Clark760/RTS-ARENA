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

test("编译与导出：export const、同一行、export { } 都行；enum、import 不行", async () => {
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
  assert.ok("error" in compileBot(`import { x } from "./y"\nexport function onTick() {}`))
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
