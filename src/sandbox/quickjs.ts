// QuickJS 沙箱里的 bot 运行器。
// - 隔离：每个 bot 一个独立的 WebAssembly 实例和内存，一个 bot 出事不影响别的 bot。
// - 内存：用 WebAssembly.Memory 的 maximum 做硬上限（QuickJS 自带的 setMemoryLimit 在这个构建里不生效）。
// - 燃料：QuickJS 中断回调被调用的次数（约每 1 万次跳转 / 函数调用一次），同一局重跑结果一致。
// - 墙钟：只用来兜底不计燃料的内置函数（大数组排序、超长字符串等），触发即判 bot 停止运行。
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  RELEASE_SYNC,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten"
import { MAX_COMMANDS } from "../core/commands.ts"
import type { BotCall, BotRunner } from "../core/types.ts"
import { preludeSource } from "./prelude.ts"

const PAGE = 65536

export interface SandboxLimits {
  /** 每次 onTick 的燃料 */
  fuel: number
  /** 加载 bot（顶层代码 + onStart）的燃料，默认 fuel 的 20 倍 */
  startFuel?: number
  /** WebAssembly 内存上限，默认 128 MB（QuickJS 自身约占 1~2 MB） */
  memoryBytes?: number
  /** 默认 1 MB */
  stackBytes?: number
  /** 单次调用墙钟上限，默认 2000 毫秒；加载时为 5 倍 */
  hardMs?: number
}

export const DEFAULT_MEMORY_BYTES = 128 * 1024 * 1024

let wasmPromise: Promise<WebAssembly.Module> | null = null
/** QuickJS 的 wasm 只编译一次，每个 bot 用它实例化出自己的一份 */
function wasmModule(): Promise<WebAssembly.Module> {
  if (!wasmPromise) {
    const pkg = dirname(fileURLToPath(import.meta.resolve("@jitl/quickjs-wasmfile-release-sync")))
    wasmPromise = WebAssembly.compile(readFileSync(join(pkg, "emscripten-module.wasm")))
  }
  return wasmPromise
}

/** 把 bot 的 TypeScript 变成能在沙箱里按 ES 模块加载的 JavaScript。只擦掉类型（行列号不变，报错行号就是源文件行号） */
export function compileBot(source: string): { code: string } | { error: string } {
  let js: string
  const emit = process.emitWarning
  try {
    // 屏蔽 stripTypeScriptTypes 的"实验功能"警告
    process.emitWarning = (() => {}) as typeof process.emitWarning
    js = stripTypeScriptTypes(source, { mode: "strip" })
  } catch (e) {
    return { error: `TypeScript 语法错误，或用了不能直接擦除的语法（enum、namespace、构造函数参数属性）：${(e as Error).message}` }
  } finally {
    process.emitWarning = emit
  }
  if (/^\s*import\s/m.test(js)) return { error: "bot 只能是单个文件，不能 import（import type 可以）" }
  return { code: js }
}

/** 建一个 bot：独立的 WebAssembly 实例 + 内存 */
export async function createBot(code: string, seed: number, limits: SandboxLimits): Promise<QuickJSBot> {
  const maxBytes = limits.memoryBytes ?? DEFAULT_MEMORY_BYTES
  const memory = new WebAssembly.Memory({ initial: Math.min(256, maxBytes / PAGE), maximum: Math.ceil(maxBytes / PAGE) })
  const qjs = await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmModule: await wasmModule(), wasmMemory: memory }))
  return new QuickJSBot(qjs.newRuntime(), memory, maxBytes, code, seed, limits)
}

function errorText(dumped: unknown): string {
  if (dumped && typeof dumped === "object") {
    const d = dumped as { name?: string; message?: string; stack?: string }
    const head = `${d.name ?? "Error"}: ${d.message ?? ""}`
    return d.stack ? `${head}\n${d.stack}` : head
  }
  return String(dumped)
}

export class QuickJSBot implements BotRunner {
  private rt: QuickJSRuntime
  private vm: QuickJSContext
  private memory: WebAssembly.Memory
  private maxBytes: number
  private fns: { init: QuickJSHandle; start: QuickJSHandle; tick: QuickJSHandle; drain: QuickJSHandle }
  private code: string
  private seed: number
  private fuelLimit: number
  private startFuel: number
  private hardMs: number
  private used = 0
  private budget = 0
  private deadline = 0
  private fuelOut = false
  private wallOut = false
  /** 内存耗尽或 wasm 崩溃后不能再碰这个实例（释放也可能崩），只能丢掉 */
  private broken = false
  private disposed = false

  constructor(rt: QuickJSRuntime, memory: WebAssembly.Memory, maxBytes: number, code: string, seed: number, limits: SandboxLimits) {
    this.rt = rt
    this.memory = memory
    this.maxBytes = maxBytes
    this.code = code
    this.seed = seed
    this.fuelLimit = limits.fuel
    this.startFuel = limits.startFuel ?? limits.fuel * 20
    this.hardMs = limits.hardMs ?? 2000
    this.rt.setMaxStackSize(limits.stackBytes ?? 1024 * 1024)
    this.rt.setInterruptHandler(() => {
      this.used++
      if (this.used > this.budget) {
        this.fuelOut = true
        return true
      }
      if (performance.now() > this.deadline) {
        this.wallOut = true
        return true
      }
      return false
    })
    this.vm = this.rt.newContext()
    this.budget = Number.MAX_SAFE_INTEGER
    this.deadline = Number.POSITIVE_INFINITY
    this.vm.unwrapResult(this.vm.evalCode(preludeSource(MAX_COMMANDS), "prelude.js")).dispose()
    // 先拿到宿主要调的函数，bot 之后改 __arena 也没用
    const arena = this.vm.getProp(this.vm.global, "__arena")
    this.fns = {
      init: this.vm.getProp(arena, "init"),
      start: this.vm.getProp(arena, "start"),
      tick: this.vm.getProp(arena, "tick"),
      drain: this.vm.getProp(arena, "drain"),
    }
    arena.dispose()
  }

  private begin(fuel: number, ms: number): number {
    this.used = 0
    this.budget = fuel
    this.fuelOut = false
    this.wallOut = false
    const t0 = performance.now()
    this.deadline = t0 + ms
    return t0
  }

  /** WebAssembly 内存只增不减，这里只用来给宿主侧崩溃找原因，不能用来判断普通报错 */
  private nearMemoryCap(): boolean {
    return this.memory.buffer.byteLength >= this.maxBytes - 4 * PAGE
  }

  private fatal(t0: number, reason: string): BotCall {
    this.broken = true
    return { commands: [], logs: [], fuel: this.used, ms: performance.now() - t0, fatal: reason }
  }

  private wallText(phase: string): string {
    return `${phase}墙钟超时（超过 ${this.hardMs} 毫秒，多半是大数组排序、超长字符串、console.log 大对象之类不计燃料的内置操作）`
  }

  /** 调用出错（含燃料耗尽）后的统一处理 */
  private failed(errHandle: QuickJSHandle, t0: number, phase: string): BotCall {
    let text: string
    try {
      text = errorText(this.vm.dump(errHandle))
      errHandle.dispose()
    } catch {
      text = "（错误信息读取失败）"
    }
    if (/out of memory/i.test(text))
      return this.fatal(t0, `${phase}内存超限（上限 ${Math.round(this.maxBytes / 1048576)} MB）`)
    if (this.wallOut) return this.fatal(t0, this.wallText(phase))
    const fuel = this.used
    const budget = this.budget
    const fuelOut = this.fuelOut
    const ms = performance.now() - t0
    const logs = this.drainLogs()
    if (fuelOut) return { commands: [], logs, fuel, ms, fuelOut: true, error: `${phase}燃料耗尽（上限 ${budget}），这次的命令作废` }
    return { commands: [], logs, fuel, ms, error: `${phase}${text}` }
  }

  private drainLogs(): string[] {
    this.begin(this.fuelLimit, this.hardMs)
    const r = this.vm.callFunction(this.fns.drain, this.vm.undefined)
    if (r.error) {
      r.error.dispose()
      return []
    }
    const out = JSON.parse(this.vm.getString(r.value)) as { l: string[] }
    r.value.dispose()
    return out.l
  }

  /** 解析 prelude 返回的 JSON：{ c: 命令, l: 日志, d: 丢弃行数, e?: 错误 } */
  private parseOut(h: QuickJSHandle, t0: number, phase: string): BotCall {
    const fuel = this.used
    const ms = performance.now() - t0
    let out: { c: unknown[]; l: string[]; d: number; o: number; e?: string }
    try {
      out = JSON.parse(this.vm.getString(h))
    } catch {
      return { commands: [], logs: [], fuel, ms, error: `${phase}返回值无法解析` }
    } finally {
      h.dispose()
    }
    const logs = Array.isArray(out.l) ? out.l.map(String) : []
    if (out.d > 0) logs.push(`（本次另有 ${out.d} 行日志超出每次 20 行的上限，已丢弃）`)
    if (out.o > 0) logs.push(`（本次另有 ${out.o} 条命令超出每次 ${MAX_COMMANDS} 条的上限，已丢弃）`)
    const commands = Array.isArray(out.c) ? out.c : []
    if (typeof out.e === "string") {
      // 内存耗尽在沙箱里是可以被 try/catch 接住的，也要判停止
      if (/out of memory/i.test(out.e)) return { ...this.fatal(t0, `${phase}内存超限（上限 ${Math.round(this.maxBytes / 1048576)} MB）`), logs }
      return { commands: [], logs, fuel, ms, error: `${phase}${out.e}` }
    }
    return { commands, logs, fuel, ms }
  }

  /**
   * 宿主侧兜底：wasm 崩溃；以及调用结束后才发现超过墙钟（不计燃料的内置操作执行期间不会触发中断回调，
   * 只能事后判）。墙钟超时不可复现，所以只用来处理极端情况。
   */
  private guard(t0: number, phase: string, limitMs: number, fn: () => BotCall): BotCall {
    if (this.broken) return this.fatal(t0, `${phase}沙箱已损坏`)
    try {
      const r = fn()
      if (!r.fatal && performance.now() - t0 > limitMs) return { ...this.fatal(t0, this.wallText(phase)), logs: r.logs }
      return r
    } catch (e) {
      const msg = this.nearMemoryCap() ? `内存超限（上限 ${Math.round(this.maxBytes / 1048576)} MB）` : `沙箱崩溃：${(e as Error).message}`
      return this.fatal(t0, phase + msg)
    }
  }

  start(gameJson: string): BotCall {
    const t0 = this.begin(this.startFuel, this.hardMs * 5)
    return this.guard(t0, "加载：", this.hardMs * 5, () => {
      const g = this.vm.newString(gameJson)
      const seed = this.vm.newNumber(this.seed)
      const ri = this.vm.callFunction(this.fns.init, this.vm.undefined, g, seed)
      g.dispose()
      seed.dispose()
      if (ri.error) return this.asFatal(this.failed(ri.error, t0, "初始化："))
      ri.value.dispose()
      const rc = this.vm.evalCode(this.code, "bot.ts", { type: "module" })
      // 顶层代码出错，之后也调不了 onTick
      if (rc.error) return this.asFatal(this.failed(rc.error, t0, "加载："))
      // 模块求值结果是导出对象，或兑现为导出对象的 Promise（顶层 await）
      let st = this.vm.getPromiseState(rc.value)
      if (st.type === "pending") {
        this.rt.executePendingJobs()
        st = this.vm.getPromiseState(rc.value)
      }
      if (st.type !== "fulfilled" || !st.notAPromise) rc.value.dispose()
      if (st.type === "rejected") return this.asFatal(this.failed(st.error, t0, "加载："))
      if (st.type === "pending") return this.fatal(t0, "加载：顶层代码不能用 await")
      const ns = st.value
      const tickFn = this.vm.getProp(ns, "onTick")
      const startFn = this.vm.getProp(ns, "onStart")
      ns.dispose()
      const rs = this.vm.callFunction(this.fns.start, this.vm.undefined, tickFn, startFn)
      tickFn.dispose()
      startFn.dispose()
      if (rs.error) return this.failed(rs.error, t0, "onStart：")
      const r = this.parseOut(rs.value, t0, "onStart：")
      return r.error?.includes("没有导出 onTick") ? this.asFatal(r) : r
    })
  }

  private asFatal(r: BotCall): BotCall {
    return r.fatal ? r : { ...r, fatal: r.error, error: undefined, fuelOut: undefined }
  }

  tick(viewJson: string): BotCall {
    const t0 = this.begin(this.fuelLimit, this.hardMs)
    return this.guard(t0, "", this.hardMs, () => {
      const v = this.vm.newString(viewJson)
      const r = this.vm.callFunction(this.fns.tick, this.vm.undefined, v)
      v.dispose()
      if (r.error) return this.failed(r.error, t0, "")
      return this.parseOut(r.value, t0, "")
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.broken) return // 损坏的实例直接丢给垃圾回收
    try {
      for (const h of Object.values(this.fns)) h.dispose()
      this.vm.dispose()
      this.rt.dispose()
    } catch {
      // 释放失败也只影响这个 bot 自己的实例
    }
  }
}
