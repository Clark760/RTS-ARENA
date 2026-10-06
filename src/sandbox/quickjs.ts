// QuickJS 沙箱里的 bot 运行器。
// - 隔离：每个 bot 一个独立的 WebAssembly 实例和内存，一个 bot 出事不影响别的 bot。
// - 内存：用 WebAssembly.Memory 的 maximum 做硬上限（QuickJS 自带的 setMemoryLimit 在这个构建里不生效）。
// - 栈：QuickJS 栈上限要远低于宿主的原生栈，让深递归在沙箱里抛出能接住的错误，而不是撑爆宿主。
// - 燃料：QuickJS 中断回调被调用的次数（约每 1 万次跳转 / 函数调用一次），同一局重跑结果一致。
// - 墙钟：不计燃料的内置函数（大数组排序、超长字符串等）执行期间不会触发中断回调，所以单次超时和整局累计超时
//   都在调用结束后判，触发即判 bot 停止运行。墙钟不可复现，只用来处理极端情况。
// - 输出：prelude 里的上限可以被 bot 改原型绕过，宿主收到结果后按同样的上限再强制一遍。
import { readFileSync } from "node:fs"
import { createRequire, stripTypeScriptTypes } from "node:module"
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
/** 每次调用最多记几行日志、每行最多几个字 */
export const LOG_LINES = 20
export const LOG_LINE = 300
/** 沙箱一次返回的 JSON 最长多少字（正常情况：2000 条命令 + 20 行日志也不到 20 万字） */
const MAX_OUTPUT_CHARS = 2_000_000
const MAX_ERROR_CHARS = 4000

export interface SandboxLimits {
  /** 每次 onTick 的燃料 */
  fuel: number
  /** 加载 bot（顶层代码 + onStart）的燃料，默认 fuel 的 20 倍 */
  startFuel?: number
  /** WebAssembly 内存上限，默认 128 MB（QuickJS 自身约占 1~2 MB） */
  memoryBytes?: number
  /** QuickJS 栈上限，默认 256 KB（约 1000 层递归）；设到 512 KB 会先撑爆宿主的栈 */
  stackBytes?: number
  /** 单次调用墙钟上限，默认 2000 毫秒；加载时为 5 倍 */
  hardMs?: number
  /** 整局累计墙钟上限，默认 120000 毫秒 */
  matchMs?: number
}

export const DEFAULT_MEMORY_BYTES = 128 * 1024 * 1024

let wasmPromise: Promise<WebAssembly.Module> | null = null
/** QuickJS 的 wasm 只编译一次，每个 bot 用它实例化出自己的一份 */
function wasmModule(): Promise<WebAssembly.Module> {
  if (!wasmPromise) {
    // wasm 文件在 quickjs-emscripten 的依赖里；从 quickjs-emscripten 所在位置去找，装成依赖时没被提升也找得到
    const req = createRequire(fileURLToPath(import.meta.resolve("quickjs-emscripten")))
    const pkg = dirname(req.resolve("@jitl/quickjs-wasmfile-release-sync"))
    wasmPromise = WebAssembly.compile(readFileSync(join(pkg, "emscripten-module.wasm")))
  }
  return wasmPromise
}

/** 把 bot 的 TypeScript 变成能在沙箱里按 ES 模块加载的 JavaScript。只擦掉类型（行列号不变，报错行号就是源文件行号） */
export function compileBot(source: string): { code: string } | { error: string } {
  const emit = process.emitWarning
  try {
    // 屏蔽 stripTypeScriptTypes 的"实验功能"警告
    process.emitWarning = (() => {}) as typeof process.emitWarning
    return { code: stripTypeScriptTypes(source, { mode: "strip" }) }
  } catch (e) {
    return { error: `TypeScript 语法错误，或用了不能直接擦除的语法（enum、namespace、构造函数参数属性）：${(e as Error).message}` }
  } finally {
    process.emitWarning = emit
  }
}

/** 新建一个独立的 QuickJS 运行时：自己的 WebAssembly 实例和内存（maxBytes 是硬上限） */
export async function newSandboxRuntime(maxBytes: number): Promise<{ rt: QuickJSRuntime; memory: WebAssembly.Memory }> {
  const memory = new WebAssembly.Memory({ initial: Math.min(256, maxBytes / PAGE), maximum: Math.ceil(maxBytes / PAGE) })
  const qjs = await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmModule: await wasmModule(), wasmMemory: memory }))
  return { rt: qjs.newRuntime(), memory }
}

/** 建一个 bot：独立的 WebAssembly 实例 + 内存 */
export async function createBot(code: string, seed: number, limits: SandboxLimits): Promise<QuickJSBot> {
  const maxBytes = limits.memoryBytes ?? DEFAULT_MEMORY_BYTES
  const { rt, memory } = await newSandboxRuntime(maxBytes)
  return new QuickJSBot(rt, memory, maxBytes, code, seed, limits)
}

export function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s
}

export function errorText(dumped: unknown): string {
  if (dumped && typeof dumped === "object") {
    const d = dumped as { name?: unknown; message?: unknown; stack?: unknown }
    const head = `${String(d.name ?? "Error")}: ${String(d.message ?? "")}`
    return clip(d.stack ? `${head}\n${String(d.stack)}` : head, MAX_ERROR_CHARS)
  }
  return clip(String(dumped), MAX_ERROR_CHARS)
}

/** 沙箱返回的结果，已按上限清洗 */
interface Out {
  commands: unknown[]
  logs: string[]
  error?: string
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
  private matchMs: number
  private totalMs = 0
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
    this.matchMs = limits.matchMs ?? 120_000
    this.rt.setMaxStackSize(limits.stackBytes ?? 256 * 1024)
    // bot 只能是单个文件：任何 import 都在加载时报错
    this.rt.setModuleLoader((name) => ({ error: new Error(`bot 只能是单个文件，不能 import "${name}"（import type 可以）`) }))
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
    this.vm.unwrapResult(this.vm.evalCode(preludeSource(MAX_COMMANDS, LOG_LINES, LOG_LINE), "prelude.js")).dispose()
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

  private memText(phase: string): string {
    return `${phase}内存超限（上限 ${Math.round(this.maxBytes / 1048576)} MB）`
  }

  private wallText(phase: string): string {
    return `${phase}墙钟超时（超过 ${this.hardMs} 毫秒，多半是大数组排序、超长字符串、console.log 大对象之类不计燃料的内置操作）`
  }

  private fatal(t0: number, reason: string, logs: string[] = []): BotCall {
    this.broken = true
    return { commands: [], logs, fuel: this.used, ms: performance.now() - t0, fatal: reason }
  }

  /**
   * 读 prelude 返回的 JSON（{ c: 命令, l: 日志, d: 丢弃行数, o: 丢弃命令数, e?: 错误 }）并按上限清洗。
   * bot 改了原型就可能返回任何东西，这里不能信任它的结构和大小。
   */
  private readOut(h: QuickJSHandle): Out {
    let raw: string
    try {
      raw = this.vm.getString(h)
    } finally {
      h.dispose()
    }
    if (raw.length > MAX_OUTPUT_CHARS) return { commands: [], logs: [], error: `返回内容过大（${raw.length} 字），这次的命令和日志作废` }
    let out: unknown
    try {
      out = JSON.parse(raw)
    } catch {
      return { commands: [], logs: [], error: "返回值无法解析（是否改动了 JSON、Array 或 Object 的原型？）" }
    }
    if (out === null || typeof out !== "object") return { commands: [], logs: [], error: "返回值格式不对（是否改动了 Object 的原型？）" }
    const o = out as { c?: unknown; l?: unknown; d?: unknown; o?: unknown; e?: unknown }
    const lines = Array.isArray(o.l) ? o.l : []
    const logs = lines.slice(0, LOG_LINES).map((x) => clip(typeof x === "string" ? x : String(JSON.stringify(x)), LOG_LINE))
    const droppedLines = (typeof o.d === "number" ? o.d : 0) + Math.max(0, lines.length - LOG_LINES)
    if (droppedLines > 0) logs.push(`（本次另有 ${droppedLines} 行日志超出每次 ${LOG_LINES} 行的上限，已丢弃）`)
    const cmds = Array.isArray(o.c) ? o.c : []
    const droppedCmds = (typeof o.o === "number" ? o.o : 0) + Math.max(0, cmds.length - MAX_COMMANDS)
    if (droppedCmds > 0) logs.push(`（本次另有 ${droppedCmds} 条命令超出每次 ${MAX_COMMANDS} 条的上限，已丢弃）`)
    const r: Out = { commands: cmds.slice(0, MAX_COMMANDS), logs }
    if (typeof o.e === "string" && o.e !== "") r.error = clip(o.e, MAX_ERROR_CHARS)
    return r
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
    if (/out of memory/i.test(text)) return this.fatal(t0, this.memText(phase))
    if (this.wallOut) return this.fatal(t0, this.wallText(phase))
    const fuel = this.used
    const budget = this.budget
    const fuelOut = this.fuelOut
    const ms = performance.now() - t0
    const logs = this.drainLogs()
    if (fuelOut) return { commands: [], logs, fuel, ms, fuelOut: true, error: `${phase}燃料耗尽（上限 ${budget}），这次的命令作废` }
    return { commands: [], logs, fuel, ms, error: `${phase}${text}` }
  }

  /** 出错后把已经打出来的日志取回来 */
  private drainLogs(): string[] {
    this.begin(this.fuelLimit, this.hardMs)
    const r = this.vm.callFunction(this.fns.drain, this.vm.undefined)
    if (r.error) {
      r.error.dispose()
      return []
    }
    return this.readOut(r.value).logs
  }

  private parseOut(h: QuickJSHandle, t0: number, phase: string): BotCall {
    const out = this.readOut(h)
    const fuel = this.used
    const ms = performance.now() - t0
    if (out.error !== undefined) {
      // 内存耗尽在沙箱里是可以被 try/catch 接住的，也要判停止
      if (/out of memory/i.test(out.error)) return this.fatal(t0, this.memText(phase), out.logs)
      return { commands: [], logs: out.logs, fuel, ms, error: `${phase}${out.error}` }
    }
    return { commands: out.commands, logs: out.logs, fuel, ms }
  }

  /** 宿主侧兜底：wasm 崩溃；调用结束后才发现的单次和整局墙钟超时 */
  private guard(t0: number, phase: string, limitMs: number, fn: () => BotCall): BotCall {
    if (this.broken) return this.fatal(t0, `${phase}沙箱已损坏`)
    let r: BotCall
    try {
      r = fn()
    } catch (e) {
      const msg = this.nearMemoryCap() ? this.memText(phase) : `${phase}沙箱崩溃：${(e as Error).message}`
      return this.fatal(t0, msg)
    }
    const spent = performance.now() - t0
    this.totalMs += spent
    if (r.fatal) return r
    if (spent > limitMs) return this.fatal(t0, this.wallText(phase), r.logs)
    if (this.totalMs > this.matchMs) return this.fatal(t0, `${phase}整局累计耗时超过 ${this.matchMs / 1000} 秒`, r.logs)
    return r
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
      // 模块求值结果是导出对象，或兑现为导出对象的 Promise（顶层 await）：加载时把排队的异步任务跑完
      let st = this.vm.getPromiseState(rc.value)
      if (st.type === "pending") {
        this.rt.executePendingJobs().dispose()
        st = this.vm.getPromiseState(rc.value)
      }
      if (st.type !== "fulfilled" || !st.notAPromise) rc.value.dispose()
      if (st.type === "rejected") return this.asFatal(this.failed(st.error, t0, "加载："))
      if (st.type === "pending") return this.fatal(t0, "加载：顶层代码在等一个永远不会完成的 await")
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
    if (r.fatal) return r
    this.broken = true
    return { ...r, fatal: r.error, error: undefined, fuelOut: undefined }
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
