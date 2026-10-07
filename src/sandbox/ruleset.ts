// 沙箱里的规则包。所有规则包都在这里跑（平台自带的、别人写的、大模型写的一视同仁，D-123）。
// - 隔离：整个规则包一个独立的 WebAssembly 实例和内存；每局新开一个 QuickJS 上下文重新加载规则包，
//   规则包顶层变量里的状态不会带到下一局。
// - 导入：只能 import 规则包自己目录里的文件和平台的 "rts-arena/standard"（rulesets/common/standard.ts）；import type 随便写。
// - 燃料、墙钟：每次回调（setup、onTick、result、objectives、timeUp）各有燃料上限，单次和整局还有墙钟上限；
//   超了就当规则包出错，这一局作废（抛错，命令行报告原因）。
// - 和内核打交道只通过宿主函数（见 hostFunctions），每个调用都检查参数和上限；规则包拿不到内核对象。
import { existsSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import type { QuickJSContext, QuickJSHandle, QuickJSRuntime } from "quickjs-emscripten"
import { mixSeed } from "../core/rng.ts"
import { PATCHED, resolveType } from "../core/world.ts"
import type { Marker, MatchResult, RuleContext, RuleEntity, Ruleset, SetupContext } from "../core/types.ts"
import { PKG_ROOT } from "../paths.ts"
import { clip, compileBot, errorText, newSandboxRuntime } from "./quickjs.ts"
import { checkResult, checkRulesetData, RULES_HARD } from "./rules-check.ts"
import { rulesPreludeSource } from "./rules-prelude.ts"

/** 沙箱规则包的上限 */
export const RULES_LIMITS = {
  /** 加载（规则包的顶层代码）的燃料；1 燃料约 5000 次简单循环 */
  loadFuel: 2000,
  setupFuel: 4000,
  /** onTick、result 每次各自的燃料 */
  tickFuel: 400,
  /** objectives 每次（每个玩家每次决策调一次） */
  objectivesFuel: 100,
  timeUpFuel: 1000,
  memoryBytes: 256 * 1024 * 1024,
  stackBytes: 256 * 1024,
  /** 单次回调的墙钟上限（加载和 setup 是 5 倍） */
  callMs: 2000,
  /** 整局所有回调累计的墙钟上限 */
  matchMs: 120_000,
  objectivesChars: 64_000,
  markersChars: 200_000,
  statusChars: 200,
  /** console.log：每次回调最多几行、每行几个字，整局最多几行 */
  logLines: 20,
  logLine: 300,
  matchLogLines: 2000,
}

/** 平台提供给规则包 import 的模块 */
const STANDARD = join(PKG_ROOT, "rulesets", "common", "standard.ts")
const COMMON_DIR = dirname(STANDARD)

/**
 * 解析失败时 QuickJS 不会把原因带出来（加载器拿到的是空名字），所以解析器返回一个带这个前缀的假名字，
 * 加载器认出它再报告原因
 */
const BAD_IMPORT = "rts-arena:不能导入:"

/** 模块名用正斜杠的绝对路径（QuickJS 里路径分隔符统一） */
const toName = (p: string) => p.split(sep).join("/")
const inside = (dir: string, file: string) => {
  const r = relative(dir, file)
  return r !== "" && !r.startsWith("..") && !r.includes(":")
}

type Ctx = SetupContext & RuleContext

/**
 * 规则包看到的实体快照。为了少传字符串，和默认值一样的字段不传（宽高同类型、储量 0、idle、没带资源、空队列、建好了），
 * 沙箱里按类型补全成完整的 RuleEntity（见 rules-prelude.ts 的 ents）
 */
function entJson(e: RuleEntity): Record<string, unknown> {
  const o: Record<string, unknown> = { id: e.id, type: e.type, owner: e.owner, x: e.x, y: e.y, hp: e.hp }
  if (e.w !== e.def.w || e.h !== e.def.h) {
    o.w = e.w
    o.h = e.h
  }
  if (e.amount !== 0) o.amount = e.amount
  if (e.order.kind !== "idle") o.order = e.order
  if (e.carrying) o.carrying = e.carrying
  if (e.queue.length > 0) o.queue = e.queue
  if (e.construction) o.construction = e.construction
  // 局中改过数值的实体（D-153）：带上现在的数值，沙箱里不按类型补
  if (PATCHED.has(e.def)) o.def = e.def
  return o
}

class RulesBox {
  name = "规则包"
  /** 解析好的实体类型（JSON），每局开始时交给沙箱，实体快照的 def 按它补上 */
  typesJson = "{}"
  private rt: QuickJSRuntime
  private memory: WebAssembly.Memory
  private dir: string
  private onLog: (tick: number, lines: string[]) => void
  private vm: QuickJSContext | null = null
  private fns: Record<"bind" | "describe" | "begin" | "call", QuickJSHandle> | null = null
  private ctx: Ctx | null = null
  /** command 是对局中执行玩家命令的时候（buildCheck）：局面和上一次回调之后不一样了，快照不能共用 */
  private phase: "load" | "setup" | "tick" | "command" = "load"
  private used = 0
  private budget = 0
  private deadline = 0
  private fuelOut = false
  private totalMs = 0
  private logged = 0
  /** 内存耗尽或 wasm 崩溃后整个实例不能再用 */
  private broken: string | null = null

  constructor(rt: QuickJSRuntime, memory: WebAssembly.Memory, dir: string, onLog: (tick: number, lines: string[]) => void) {
    this.name = basename(dir)
    this.rt = rt
    this.memory = memory
    this.dir = dir
    this.onLog = onLog
    rt.setMaxStackSize(RULES_LIMITS.stackBytes)
    rt.setModuleLoader(
      (name) => this.loadModule(name),
      (base, requested) => this.resolveModule(base, requested),
    )
    rt.setInterruptHandler(() => {
      this.used++
      if (this.used > this.budget) {
        this.fuelOut = true
        return true
      }
      return performance.now() > this.deadline
    })
  }

  private resolveModule(base: string, requested: string): string {
    if (requested === "rts-arena/standard") return toName(STANDARD)
    if (requested.startsWith("./") || requested.startsWith("../")) return toName(resolve(dirname(base), requested))
    return BAD_IMPORT + requested
  }

  private loadModule(name: string): string | { error: Error } {
    if (name.startsWith(BAD_IMPORT))
      return { error: new Error(`规则包只能 import 自己目录里的文件（./ 或 ../ 开头）和 "rts-arena/standard"，不能 import "${name.slice(BAD_IMPORT.length)}"`) }
    const file = resolve(name)
    if (!inside(this.dir, file) && !inside(COMMON_DIR, file)) return { error: new Error(`不能 import 规则包目录以外的文件：${name}`) }
    if (!/\.(ts|js)$/.test(file) || !existsSync(file) || !statSync(file).isFile()) return { error: new Error(`找不到要 import 的文件：${name}`) }
    const c = compileBot(readFileSync(file, "utf8"))
    return "error" in c ? { error: new Error(`${name}：${c.error}`) } : c.code
  }

  private begin(fuel: number, ms: number): number {
    this.used = 0
    this.budget = fuel
    this.fuelOut = false
    const t0 = performance.now()
    this.deadline = t0 + ms
    return t0
  }

  /** 平台自己的代码（prelude、每局初始化）不限燃料 */
  private unlimited(): void {
    this.used = 0
    this.budget = Number.MAX_SAFE_INTEGER
    this.deadline = Number.POSITIVE_INFINITY
  }

  private fail(what: string, msg: string): never {
    const tick = (this.phase === "tick" || this.phase === "command") && this.ctx ? `，第 ${this.ctx.tick} tick` : ""
    throw new Error(`规则包「${this.name}」出错（${what}${tick}）：${msg}`)
  }

  /** 把沙箱里抛出的错误变成宿主的报错；区分燃料、墙钟、内存 */
  private explain(errHandle: QuickJSHandle, what: string, fuel: number, ms: number): never {
    let text: string
    try {
      text = errorText(this.vm!.dump(errHandle))
      errHandle.dispose()
    } catch {
      text = "（错误信息读取失败）"
    }
    if (/out of memory/i.test(text)) {
      this.broken = "内存超限"
      this.fail(what, `内存超限（上限 ${RULES_LIMITS.memoryBytes / 1048576} MB）`)
    }
    if (this.fuelOut) this.fail(what, `燃料耗尽（上限 ${fuel}），多半是死循环，或者每次做的计算太多`)
    if (performance.now() > this.deadline) this.fail(what, `超时（超过 ${ms} 毫秒）`)
    this.fail(what, text)
  }

  /** 宿主侧兜底：wasm 崩溃、调用结束后才发现的超时 */
  private guarded<T>(what: string, fuel: number, ms: number, fn: () => T): T {
    if (this.broken) this.fail(what, `沙箱已损坏（${this.broken}）`)
    const t0 = this.begin(fuel, ms)
    let out: T
    try {
      out = fn()
    } catch (e) {
      if ((e as Error).message.startsWith(`规则包「${this.name}」`)) throw e
      const near = this.memory.buffer.byteLength >= RULES_LIMITS.memoryBytes - 4 * 65536
      this.broken = near ? "内存超限" : "沙箱崩溃"
      this.fail(what, near ? `内存超限（上限 ${RULES_LIMITS.memoryBytes / 1048576} MB）` : `沙箱崩溃：${(e as Error).message}`)
    }
    const spent = performance.now() - t0
    this.totalMs += spent
    if (spent > ms) this.fail(what, `超时（用了 ${Math.round(spent)} 毫秒，上限 ${ms}）`)
    if (this.totalMs > RULES_LIMITS.matchMs) this.fail(what, `整局累计耗时超过 ${RULES_LIMITS.matchMs / 1000} 秒`)
    return out
  }

  /** 新开一个上下文、执行规则包的顶层代码；返回它导出的静态数据和有哪些回调 */
  open(): { d: unknown; f: string[] } {
    if (this.broken) throw new Error(`规则包「${this.name}」的沙箱已损坏（${this.broken}），不能再开新的一局`)
    this.close()
    this.totalMs = 0
    this.logged = 0
    this.phase = "load"
    this.unlimited()
    const vm = this.rt.newContext()
    this.vm = vm
    const host = vm.newObject()
    for (const [name, fn] of Object.entries(this.hostFunctions(vm))) {
      const h = vm.newFunction(name, fn)
      vm.setProp(host, name, h)
      h.dispose()
    }
    vm.setProp(vm.global, "__host", host)
    host.dispose()
    vm.unwrapResult(vm.evalCode(rulesPreludeSource(RULES_LIMITS.logLines, RULES_LIMITS.logLine), "rules-prelude.js")).dispose()
    const api = vm.getProp(vm.global, "__rules")
    this.fns = { bind: vm.getProp(api, "bind"), describe: vm.getProp(api, "describe"), begin: vm.getProp(api, "begin"), call: vm.getProp(api, "call") }
    api.dispose()
    const index = join(this.dir, "index.ts")
    const c = compileBot(readFileSync(index, "utf8"))
    if ("error" in c) this.fail("index.ts", c.error)
    const fuel = RULES_LIMITS.loadFuel
    const ms = RULES_LIMITS.callMs * 5
    const raw = this.guarded("加载", fuel, ms, () => {
      const r = vm.evalCode(c.code, toName(index), { type: "module" })
      if (r.error) this.explain(r.error, "加载", fuel, ms)
      let st = vm.getPromiseState(r.value)
      if (st.type === "pending") {
        this.rt.executePendingJobs().dispose()
        st = vm.getPromiseState(r.value)
      }
      if (st.type !== "fulfilled" || !st.notAPromise) r.value.dispose()
      if (st.type === "rejected") this.explain(st.error, "加载", fuel, ms)
      if (st.type === "pending") this.fail("加载", "顶层代码在等一个永远不会完成的 await")
      const ns = st.value
      vm.callFunction(this.fns!.bind, vm.undefined, ns).dispose()
      ns.dispose()
      const d = vm.unwrapResult(vm.callFunction(this.fns!.describe, vm.undefined))
      const s = vm.getString(d)
      d.dispose()
      return s
    })
    let out: { d?: unknown; f?: unknown; e?: string }
    try {
      out = JSON.parse(raw)
    } catch {
      this.fail("加载", "规则包对象转不成 JSON（是否改动了 JSON、Array 或 Object 的原型？）")
    }
    if (out?.e) this.fail("加载", out.e)
    return { d: out?.d, f: Array.isArray(out?.f) ? out.f.filter((x): x is string => typeof x === "string") : [] }
  }

  /** 一局开始：新上下文，告诉沙箱实体类型、队伍和种子 */
  start(ctx: Ctx): void {
    this.open()
    this.ctx = ctx
    this.unlimited()
    const vm = this.vm!
    const types = vm.newString(this.typesJson)
    const teams = vm.newString(JSON.stringify(ctx.teams))
    const seed = vm.newNumber(mixSeed(ctx.seed, "rules-math"))
    vm.unwrapResult(vm.callFunction(this.fns!.begin, vm.undefined, types, teams, seed)).dispose()
    types.dispose()
    teams.dispose()
    seed.dispose()
  }

  /** 调规则包的一个回调，返回它的返回值（已经过 JSON） */
  call(ctx: Ctx, name: string, args: unknown[], fuel: number, phase: "setup" | "tick" | "command"): unknown {
    if (!this.vm || !this.fns) this.fail(name, "这一局还没开始（没有调用 setup）")
    this.ctx = ctx
    this.phase = phase
    const ms = phase === "setup" ? RULES_LIMITS.callMs * 5 : RULES_LIMITS.callMs
    const vm = this.vm
    const raw = this.guarded(name, fuel, ms, () => {
      const n = vm.newString(name)
      const a = vm.newString(JSON.stringify(args))
      // 同一 tick 的 onTick、result 和下一轮的 objectives 之间内核不会动局面，沙箱里的快照可以接着用
      const st = vm.newNumber(phase === "tick" ? ctx.tick : -1)
      const r = vm.callFunction(this.fns!.call, vm.undefined, n, a, st)
      n.dispose()
      a.dispose()
      st.dispose()
      if (r.error) this.explain(r.error, name, fuel, ms)
      const s = vm.getString(r.value)
      r.value.dispose()
      return s
    })
    if (raw.length > RULES_LIMITS.objectivesChars * 4) this.fail(name, `返回内容过大（${raw.length} 字）`)
    let out: { v?: unknown; e?: string; l?: unknown; d?: unknown }
    try {
      out = JSON.parse(raw)
    } catch {
      this.fail(name, "返回值无法解析（是否改动了 JSON、Array 或 Object 的原型？）")
    }
    if (out === null || typeof out !== "object") this.fail(name, "返回值格式不对（是否改动了 Object 的原型？）")
    this.forwardLogs(out.l, out.d)
    if (typeof out.e === "string") {
      // 内存耗尽在沙箱里能被 try/catch 接住，也要判成内存超限
      if (/out of memory/i.test(out.e)) {
        this.broken = "内存超限"
        this.fail(name, `内存超限（上限 ${RULES_LIMITS.memoryBytes / 1048576} MB）`)
      }
      if (this.fuelOut) this.fail(name, `燃料耗尽（上限 ${fuel}），多半是死循环，或者每次做的计算太多`)
      this.fail(name, clip(out.e, 4000))
    }
    return out.v ?? null
  }

  private forwardLogs(lines: unknown, dropped: unknown): void {
    if (!Array.isArray(lines) || lines.length === 0 || this.logged >= RULES_LIMITS.matchLogLines) return
    const text = lines.slice(0, RULES_LIMITS.logLines).map((x) => clip(String(x), RULES_LIMITS.logLine))
    if (typeof dropped === "number" && dropped > 0) text.push(`（另有 ${dropped} 行超出每次 ${RULES_LIMITS.logLines} 行的上限）`)
    this.logged += text.length
    if (this.logged >= RULES_LIMITS.matchLogLines) text.push(`（规则包日志已达整局上限 ${RULES_LIMITS.matchLogLines} 行，之后不再输出）`)
    this.onLog(this.phase !== "setup" && this.ctx ? this.ctx.tick : 0, text)
  }

  close(): void {
    const vm = this.vm
    this.vm = null
    this.ctx = null
    if (!vm || this.broken) return // 损坏的实例直接丢掉
    try {
      for (const h of Object.values(this.fns ?? {})) h.dispose()
      vm.dispose()
    } catch {
      this.broken = "释放失败"
    }
    this.fns = null
  }

  /** 沙箱能调的宿主函数。参数都是沙箱给的，一律检查 */
  private hostFunctions(vm: QuickJSContext): Record<string, (...args: QuickJSHandle[]) => QuickJSHandle | undefined> {
    const w = (): Ctx => {
      if (!this.ctx) throw new Error("这里还不能用 ctx（规则包的顶层代码里拿不到对局）")
      return this.ctx
    }
    const num = (h: QuickJSHandle | undefined, what: string): number => {
      const v = h && vm.typeof(h) === "number" ? vm.getNumber(h) : NaN
      if (!Number.isFinite(v)) throw new Error(`${what} 要是数字`)
      return v
    }
    const int = (h: QuickJSHandle | undefined, what: string): number => {
      const v = num(h, what)
      if (!Number.isInteger(v)) throw new Error(`${what} 要是整数`)
      return v
    }
    const str = (h: QuickJSHandle | undefined, what: string, max = 10_000): string => {
      if (!h || vm.typeof(h) !== "string") throw new Error(`${what} 要是字符串`)
      const s = vm.getString(h)
      if (s.length > max) throw new Error(`${what} 太长（${s.length} 字，最多 ${max}）`)
      return s
    }
    const json = (h: QuickJSHandle | undefined, what: string, max: number): unknown => {
      const s = h && vm.typeof(h) === "string" ? vm.getString(h) : undefined
      if (s === undefined) throw new Error(`${what} 不能转成 JSON`)
      if (s.length > max) throw new Error(`${what} 太大（${s.length} 字，最多 ${max}）`)
      return JSON.parse(s)
    }
    const player = (h: QuickJSHandle | undefined): number => {
      const p = int(h, "玩家编号")
      if (p < 0 || p >= w().playerCount) throw new Error(`玩家编号 ${p} 不存在（共 ${w().playerCount} 个玩家）`)
      return p
    }
    const setupOnly = (what: string) => {
      if (this.phase !== "setup") throw new Error(`${what} 只能在 setup 里用`)
    }
    const amount = (h: QuickJSHandle | undefined) => (h && vm.typeof(h) === "number" ? { amount: int(h, "amount") } : undefined)
    const roomForMore = () => {
      if (w().entities().length >= RULES_HARD.entities) throw new Error(`实体数已到沙箱规则包的上限 ${RULES_HARD.entities}`)
    }
    const n = (v: number) => vm.newNumber(v)
    const s = (v: string) => vm.newString(v)
    return {
      seed: () => n(w().seed),
      playerCount: () => n(w().playerCount),
      tick: () => n(w().tick),
      maxTicks: () => n(w().maxTicks),
      width: () => n(w().width),
      height: () => n(w().height),
      terrain: () => s(JSON.stringify(w().terrain)),
      rng: () => n(w().rng.next()),
      setTerrain: (h) => {
        setupOnly("setTerrain")
        if (w().width > 0) throw new Error("setTerrain 只能调一次")
        const rows = json(h, "地图", RULES_HARD.mapSide * (RULES_HARD.mapSide + 4) + 16)
        if (!Array.isArray(rows) || rows.some((r) => typeof r !== "string")) throw new Error("setTerrain 要传字符串数组，每行一个字符串")
        if (rows.length > RULES_HARD.mapSide || rows.some((r: string) => r.length > RULES_HARD.mapSide))
          throw new Error(`地图边长最多 ${RULES_HARD.mapSide} 格`)
        w().setTerrain(rows as string[])
        return undefined
      },
      spawn: (type, owner, x, y, amt) => {
        setupOnly("spawn（对局中用 spawnNear）")
        roomForMore()
        return n(w().spawn(str(type, "类型"), int(owner, "owner"), int(x, "x"), int(y, "y"), amount(amt)))
      },
      setResources: (p, res) => {
        setupOnly("setResources（对局中用 addResource）")
        const r = json(res, "资源", 10_000)
        if (r === null || typeof r !== "object" || Object.values(r).some((v) => typeof v !== "number" || !Number.isFinite(v)))
          throw new Error("setResources 要传 { 资源名: 数量 }")
        w().setResources(player(p), r as Record<string, number>)
        return undefined
      },
      setMarkers: (h) => {
        w().setMarkers(checkMarkers(json(h, "叠加层", RULES_LIMITS.markersChars)))
        return undefined
      },
      setStatus: (h) => {
        w().setStatus(clip(str(h, "状态文字", 100_000), RULES_LIMITS.statusChars))
        return undefined
      },
      isVisible: (p, x, y) => n(w().isVisible(player(p), int(x, "x"), int(y, "y")) ? 1 : 0),
      note: (h, p) => {
        const who = p && vm.typeof(p) === "number" ? int(p, "玩家编号") : -1
        w().note(str(h, "事件文字", 10_000), who)
        return undefined
      },
      entities: () => s(JSON.stringify(w().entities().map(entJson))),
      entitiesWhere: (h) => {
        const f = json(h, "筛选条件", 1000) as Record<string, unknown> | null
        if (f === null || typeof f !== "object") throw new Error("entities 的筛选条件要写成 { owner, type, kind }")
        const owner = f.owner === undefined ? undefined : Number.isInteger(f.owner) ? (f.owner as number) : NaN
        const type = f.type === undefined || typeof f.type === "string" ? (f.type as string | undefined) : null
        const kind = f.kind === undefined || ["unit", "building", "resource"].includes(f.kind as string) ? (f.kind as "unit" | undefined) : null
        if (Number.isNaN(owner) || type === null || kind === null) throw new Error("entities 的筛选条件：owner 要是整数，type 要是字符串，kind 要是 unit、building、resource")
        return s(JSON.stringify(w().entities({ owner, type, kind }).map(entJson)))
      },
      entitiesIn: (x, y, ww, hh) => s(JSON.stringify(w().entitiesIn(num(x, "x"), num(y, "y"), num(ww, "w"), num(hh, "h")).map(entJson))),
      players: () => s(JSON.stringify(w().players.map((p) => ({ id: p.id, name: p.name, alive: p.alive, score: p.score, resources: p.resources })))),
      events: () => s(JSON.stringify(w().events)),
      addScore: (p, v) => {
        w().addScore(player(p), num(v, "分数"))
        return undefined
      },
      setScore: (p, v) => {
        w().setScore(player(p), num(v, "分数"))
        return undefined
      },
      addResource: (p, r, v) => {
        w().addResource(player(p), str(r, "资源名", 64), num(v, "数量"))
        return undefined
      },
      spawnNear: (type, owner, x, y, amt) => {
        roomForMore()
        return n(w().spawnNear(str(type, "类型"), int(owner, "owner"), int(x, "x"), int(y, "y"), amount(amt)) ?? -1)
      },
      remove: (id) => {
        w().remove(int(id, "id"))
        return undefined
      },
      eliminate: (p) => {
        w().eliminate(player(p))
        return undefined
      },
      orderNeutral: (id, h) => {
        const o = json(h, "命令", 1000) as Record<string, unknown> | null
        if (o === null || typeof o !== "object") throw new Error("orderNeutral 的命令要写成 { kind: ... }")
        w().orderNeutral(int(id, "id"), o as never)
        return undefined
      },
      setHp: (id, hp) => {
        w().setHp(int(id, "id"), num(hp, "生命"))
        return undefined
      },
      setOwner: (id, owner) => {
        w().setOwner(int(id, "id"), int(owner, "owner"))
        return undefined
      },
      setTypeStats: (p, type, h) => {
        w().setTypeStats(int(p, "玩家编号"), str(type, "类型", 64), json(h, "数值", 1000) as never)
        return undefined
      },
      setStats: (id, h) => {
        w().setStats(int(id, "id"), json(h, "数值", 1000) as never)
        return undefined
      },
    }
  }
}

/** 叠加层：播放器要画，字段类型不对会让播放器出错 */
function checkMarkers(m: unknown): Marker[] {
  if (!Array.isArray(m) || m.length > 500) throw new Error("setMarkers 要传数组，最多 500 个")
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v)
  const owner = (v: unknown) => v === null || v === undefined || (Number.isInteger(v) && (v as number) >= -1)
  const text = (v: unknown, opt: boolean) => (opt && v === undefined) || (typeof v === "string" && v.length <= 40)
  const color = (v: unknown) => v === undefined || (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v))
  for (const x of m) {
    const ok =
      x !== null &&
      typeof x === "object" &&
      ((x.kind === "zone" && num(x.x) && num(x.y) && num(x.w) && num(x.h) && owner(x.owner) && text(x.label, true) && color(x.color)) ||
        (x.kind === "label" && num(x.x) && num(x.y) && text(x.text, false) && owner(x.owner)))
    if (!ok) throw new Error(`叠加层格式不对：${clip(JSON.stringify(x) ?? "", 200)}（zone 要 x、y、w、h、owner，可选 label、color: "#rrggbb"；label 要 x、y、text，可选 owner；文字最多 40 字）`)
  }
  return m as Marker[]
}

/** 默认把规则包的 console.log 打到标准错误 */
function logToStderr(name: string) {
  return (tick: number, lines: string[]) => {
    for (const l of lines) process.stderr.write(`[规则包 ${name} 第 ${tick} tick] ${l}\n`)
  }
}

/**
 * 在沙箱里加载 dir 下的规则包（index.ts 默认导出规则包对象）。返回的 Ruleset 和自带的规则包用法一样，
 * 但同一时间只能跑一局（每局 setup 时重新加载，一局结束 release）。
 */
export async function loadSandboxedRuleset(dir: string, opts: { onLog?: (tick: number, lines: string[]) => void } = {}): Promise<Ruleset> {
  const abs = resolve(dir)
  if (!existsSync(join(abs, "index.ts"))) throw new Error(`${dir} 里没有 index.ts`)
  const { rt, memory } = await newSandboxRuntime(RULES_LIMITS.memoryBytes)
  let logger = opts.onLog
  const box = new RulesBox(rt, memory, abs, (t, l) => (logger ?? logToStderr(box.name))(t, l))
  let desc: { d: unknown; f: string[] }
  try {
    desc = box.open()
  } finally {
    box.close()
  }
  const errs = checkRulesetData(desc.d, desc.f)
  if (errs.length) throw new Error(`规则包 ${dir} 的定义有问题：\n- ${errs.join("\n- ")}`)
  const d = desc.d as Omit<Ruleset, "setup" | "onTick" | "objectives" | "result" | "timeUp">
  box.name = d.name
  box.typesJson = JSON.stringify(Object.fromEntries(Object.entries(d.types).map(([k, spec]) => [k, resolveType(k, spec)])))
  logger ??= logToStderr(d.name)
  const result = (v: unknown, n: number, allowNull: boolean, what: string): MatchResult | null => {
    const bad = checkResult(v, n, allowNull)
    if (bad) throw new Error(`规则包「${d.name}」的 ${what} 返回值不对：${bad}`)
    return v as MatchResult | null
  }
  return {
    ...d,
    setup(ctx) {
      box.start(ctx as Ctx)
      box.call(ctx as Ctx, "setup", [], RULES_LIMITS.setupFuel, "setup")
    },
    onTick: desc.f.includes("onTick") ? (ctx) => void box.call(ctx as Ctx, "onTick", [], RULES_LIMITS.tickFuel, "tick") : undefined,
    objectives(ctx, player) {
      const v = box.call(ctx as Ctx, "objectives", [player], RULES_LIMITS.objectivesFuel, "tick")
      const size = JSON.stringify(v).length
      if (size > RULES_LIMITS.objectivesChars) throw new Error(`规则包「${d.name}」的 objectives 返回内容太大（${size} 字，最多 ${RULES_LIMITS.objectivesChars}）`)
      return v
    },
    result: (ctx) => result(box.call(ctx as Ctx, "result", [], RULES_LIMITS.tickFuel, "tick"), ctx.playerCount, true, "result"),
    timeUp: (ctx) => result(box.call(ctx as Ctx, "timeUp", [], RULES_LIMITS.timeUpFuel, "tick"), ctx.playerCount, false, "timeUp")!,
    buildCheck: desc.f.includes("buildCheck")
      ? (ctx, player, type, x, y) => {
          const v = box.call(ctx as Ctx, "buildCheck", [player, type, x, y], RULES_LIMITS.objectivesFuel, "command")
          if (v !== null && typeof v !== "string") throw new Error(`规则包「${d.name}」的 buildCheck 要返回 null（允许）或字符串（拒绝原因）`)
          return v === null || v === "" ? null : clip(v, 200)
        }
      : undefined,
    release: () => box.close(),
  }
}
