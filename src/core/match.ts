// 对局循环：调 bot → 执行命令 → 结算 → 规则包 → 判胜负 → 记回放
import { applyCommands } from "./commands.ts"
import { Recorder } from "./recorder.ts"
import { step } from "./sim.ts"
import type { BotCall, BotRunner, BotStats, Frame, MatchResult, Replay, Ruleset } from "./types.ts"
import { buildView } from "./view.ts"
import { World } from "./world.ts"

/** 每个 bot 整局最多记多少行日志 */
const MAX_LOG_LINES = 5000
/** 每个 bot 每 tick 最多记几条报错 / 被拒命令 */
const MAX_ERRS_PER_TICK = 5
const MAX_ERR_CHARS = 2000

export interface MatchBot {
  /** 显示名 */
  name: string
  /** bot 文件路径（只做记录） */
  file: string
  /** null 表示加载失败，loadError 说明原因 */
  runner: BotRunner | null
  loadError?: string
}

export interface MatchOptions {
  ruleset: Ruleset
  bots: MatchBot[]
  seed: number
  /** 每个座位的队伍编号；不填就是每人一队 */
  teams?: number[]
  /** 每 tick 结束时回调（进度显示用） */
  onTick?: (tick: number) => void
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s
}

/** 补全结果：winners 不填就是 [winner]；名次不填就按 winners 推，给了但漏了人，漏的并列最后 */
function complete(r: MatchResult, n: number, tick: number): MatchResult & { tick: number } {
  const winners = r.winners ?? (r.winner === null ? [] : [r.winner])
  return { ...r, winner: r.winner ?? winners[0] ?? null, winners, ranking: fullRanking({ ...r, winners }, n), tick }
}

function fullRanking(r: MatchResult, n: number): number[][] {
  const won = r.winners ?? []
  const ranks = r.ranking ? r.ranking.map((g) => [...g]) : won.length === 0 ? [[...Array(n).keys()]] : [[...won]]
  const seen = new Set(ranks.flat())
  const rest = [...Array(n).keys()].filter((p) => !seen.has(p))
  if (rest.length) ranks.push(rest)
  return ranks
}

export function runMatch(opts: MatchOptions): Replay {
  const rules = opts.ruleset
  const n = opts.bots.length
  if (n < rules.players.min || n > rules.players.max)
    throw new Error(`规则包 ${rules.id} 需要 ${rules.players.min}~${rules.players.max} 个玩家，给了 ${n} 个`)
  try {
    return play(opts, new World(rules, opts.bots.map((b) => b.name), opts.seed, opts.teams))
  } finally {
    // 正常结束、出错都要释放：bot 的沙箱，以及沙箱规则包这一局的上下文
    for (const b of opts.bots) b.runner?.dispose()
    rules.release?.()
  }
}

function play(opts: MatchOptions, w: World): Replay {
  const rules = opts.ruleset
  const n = opts.bots.length
  rules.setup(w)
  if (w.width === 0) throw new Error(`规则包 ${rules.id} 的 setup 没有调用 setTerrain`)
  w.computeVisibility()
  const rec = new Recorder(w)

  const runners = opts.bots.map((b) => b.runner)
  const logLines = new Array<number>(n).fill(0)
  const stats: BotStats[] = opts.bots.map((b, p) => ({
    player: p,
    bot: b.file,
    status: b.runner ? "ok" : "dead",
    deadReason: b.runner ? undefined : b.loadError,
    calls: 0,
    fuelTotal: 0,
    fuelMax: 0,
    errors: 0,
    fuelOuts: 0,
    rejected: 0,
    ms: 0,
  }))

  let logs: NonNullable<Frame["logs"]> = []
  let errs: NonNullable<Frame["errs"]> = []
  const errCount = new Array<number>(n).fill(0)
  const pushErr = (p: number, msg: string) => {
    if (errCount[p]++ < MAX_ERRS_PER_TICK) errs.push({ p, msg: clip(msg, MAX_ERR_CHARS) })
  }

  /** 处理一次调用结果，返回可以执行的命令 */
  const handle = (p: number, r: BotCall): unknown[] => {
    const s = stats[p]
    s.calls++
    s.fuelTotal += r.fuel
    s.fuelMax = Math.max(s.fuelMax, r.fuel)
    s.ms += r.ms
    if (r.logs.length > 0 && logLines[p] < MAX_LOG_LINES) {
      const text = r.logs.slice(0, MAX_LOG_LINES - logLines[p])
      logLines[p] += text.length
      if (logLines[p] >= MAX_LOG_LINES) text.push(`（日志已达整局上限 ${MAX_LOG_LINES} 行，之后不再记录）`)
      logs.push({ p, text })
    }
    if (r.fatal) {
      s.status = "dead"
      s.deadReason = r.fatal
      pushErr(p, `bot 停止运行：${r.fatal}`)
      runners[p]?.dispose()
      runners[p] = null
      return []
    }
    if (r.error) {
      if (r.fuelOut) s.fuelOuts++
      else s.errors++
      pushErr(p, r.error)
      w.pushEvent(p, { kind: "botError", tick: w.tick, message: clip(r.error, 1000) })
      return []
    }
    return r.commands
  }

  for (let p = 0; p < n; p++) {
    const runner = runners[p]
    if (!runner) {
      pushErr(p, `bot 没有加载：${opts.bots[p].loadError ?? "未知原因"}`)
      continue
    }
    handle(p, runner.start(JSON.stringify(w.gameInfo(p))))
  }

  const cmds: unknown[][] = []
  let peakEntities = w.ents.size
  let simMs = 0
  while (!w.ended) {
    w.computeVisibility()
    cmds.length = 0
    if (w.tick % rules.decisionInterval === 0) {
      for (let p = 0; p < n; p++) {
        const runner = runners[p]
        if (!runner || !w.players[p].alive) continue
        cmds[p] = handle(p, runner.tick(JSON.stringify(buildView(w, p))))
      }
    }
    for (let p = 0; p < n; p++) if (!runners[p] || !w.players[p].alive) w.players[p].pending.length = 0
    w.tick++
    for (let p = 0; p < n; p++) {
      if (!cmds[p] || cmds[p].length === 0) continue
      for (const [c, reason] of applyCommands(w, p, cmds[p])) {
        stats[p].rejected++
        pushErr(p, `命令被拒：${reason}  ${clip(JSON.stringify(c) ?? "", 200)}`)
      }
    }
    const t0 = performance.now()
    step(w)
    rules.onTick?.(w)
    const res = rules.result(w)
    if (res) w.ended = complete(res, n, w.tick)
    else if (w.tick >= rules.maxTicks) w.ended = complete(rules.timeUp(w), n, w.tick)
    rec.record(w, { logs, errs })
    simMs += performance.now() - t0
    peakEntities = Math.max(peakEntities, w.ents.size)
    logs = []
    errs = []
    errCount.fill(0)
    opts.onTick?.(w.tick)
  }
  const types: Replay["types"] = {}
  for (const [name, def] of Object.entries(w.types))
    types[name] = { kind: def.kind, w: def.w, h: def.h, maxHp: def.maxHp, moveTicks: def.moveTicks, sight: def.sight, look: rules.types[name].look }
  const colors: Record<string, string> = {}
  for (const [ch, t] of Object.entries(rules.terrain)) colors[ch] = t.color

  return {
    format: "rts-arena-replay",
    version: 1,
    ruleset: { id: rules.id, name: rules.name },
    seed: opts.seed,
    tickRate: rules.tickRate,
    maxTicks: rules.maxTicks,
    players: opts.bots.map((b, i) => ({ name: b.name, bot: b.file, team: w.teams[i] })),
    map: { width: w.width, height: w.height, terrain: w.terrain, colors },
    types,
    fog: rules.fog,
    initial: rec.initial,
    frames: rec.frames,
    result: w.ended,
    bots: stats,
    perf: { peakEntities, simMs: Math.round(simMs), botMs: Math.round(stats.reduce((a, s) => a + s.ms, 0)) },
  }
}
