// 压测：不同地图大小、单位数、决策间隔下的速度和回放大小，用来定建议上限。
// npm run bench [-- --ticks 2000]
import { runMatch } from "../core/match.ts"
import type { Ruleset, TypeSpec } from "../core/types.ts"
import { compileBot, createBot } from "../sandbox/quickjs.ts"

interface Case {
  side: number
  players: number
  perPlayer: number
  interval: number
}

const ONLY = process.argv.includes("--one")
const ALL_CASES: Case[] = [
  { side: 64, players: 2, perPlayer: 100, interval: 5 },
  { side: 128, players: 2, perPlayer: 200, interval: 5 },
  { side: 128, players: 2, perPlayer: 300, interval: 5 },
  { side: 128, players: 2, perPlayer: 200, interval: 1 },
  { side: 128, players: 4, perPlayer: 150, interval: 5 },
  { side: 256, players: 2, perPlayer: 300, interval: 5 },
]
const CASES = ONLY ? ALL_CASES.slice(1, 2) : ALL_CASES

const ticksArg = process.argv.indexOf("--ticks")
const TICKS = ticksArg > 0 ? Number(process.argv[ticksArg + 1]) : 2000

const TYPES: Record<string, TypeSpec> = {
  hq: { kind: "building", w: 3, h: 3, maxHp: 100000, sight: 8, look: { shape: "square" } },
  soldier: { kind: "unit", maxHp: 200, moveTicks: 3, sight: 6, attack: { damage: 5, range: 1, cooldown: 8 }, look: { shape: "diamond" } },
  archer: { kind: "unit", maxHp: 120, moveTicks: 3, sight: 7, attack: { damage: 4, range: 4, cooldown: 10 }, look: { shape: "triangle" } },
}

function stressRuleset(c: Case): Ruleset {
  const corners = [
    [2, 2],
    [c.side - 5, c.side - 5],
    [c.side - 5, 2],
    [2, c.side - 5],
  ]
  return {
    id: "stress",
    name: "压测",
    players: { min: c.players, max: c.players },
    maxTicks: TICKS,
    tickRate: 10,
    decisionInterval: c.interval,
    fuel: 500,
    unitCap: 0,
    fog: true,
    resources: [],
    terrain: { ".": { walkable: true, color: "#333" }, "#": { walkable: false, color: "#666" } },
    types: TYPES,
    setup(ctx) {
      // 每隔 16 格一道带缺口的墙，让寻路有事做
      const rows: string[] = []
      for (let y = 0; y < c.side; y++) {
        let row = ""
        for (let x = 0; x < c.side; x++) row += x % 16 === 8 && y % 16 < 10 && x > c.side / 4 && x < (c.side * 3) / 4 ? "#" : "."
        rows.push(row)
      }
      ctx.setTerrain(rows)
      for (let p = 0; p < c.players; p++) {
        const [hx, hy] = corners[p]
        ctx.spawn("hq", p, hx, hy)
        // 在主基地朝地图中心的方向排成方阵
        const dx = hx < c.side / 2 ? 1 : -1
        const dy = hy < c.side / 2 ? 1 : -1
        const cols = Math.ceil(Math.sqrt(c.perPlayer))
        for (let i = 0; i < c.perPlayer; i++) {
          const x = hx + 1 + dx * (4 + (i % cols))
          const y = hy + 1 + dy * (4 + Math.floor(i / cols))
          ctx.spawn(i % 3 === 0 ? "archer" : "soldier", p, x, y)
        }
      }
    },
    objectives: (_ctx, p) => ({ enemy: corners.slice(0, c.players).filter((_, i) => i !== p) }),
    result: () => null,
    timeUp: () => ({ winner: null, reason: "压测结束" }),
  }
}

// 每次调用：给闲着的单位下 attackMove，再给每个单位找最近的敌人（n² 的计算，模拟偏重的 bot）
const BOT = `
export function onTick(view: View, cmd: Commands) {
  const mine = view.entities.filter((e) => e.owner === view.me && e.type !== "hq")
  const enemies = view.entities.filter((e) => e.owner !== view.me && e.owner >= 0)
  const target = (view.objectives as any).enemy[view.tick % (view.objectives as any).enemy.length]
  let work = 0
  for (const u of mine) {
    let best = 1e9
    for (const e of enemies) { const d = Math.abs(e.x - u.x) + Math.abs(e.y - u.y); if (d < best) best = d; work++ }
    if (u.order && u.order.kind === "idle") cmd.attackMove(u, target[0] + 1, target[1] + 1)
  }
}`

console.log(`每局 ${TICKS} tick，燃料上限 500，bot 每次对每个单位扫一遍可见敌人`)
console.log("地图\t玩家\t每方单位\t决策间隔\t实体峰值\t总耗时s\t内核ms/tick\tbot ms/次\t燃料均值/最高\t回放MB")
for (const c of CASES) {
  const rules = stressRuleset(c)
  const compiled = compileBot(BOT)
  if ("error" in compiled) throw new Error(compiled.error)
  const bots = []
  for (let p = 0; p < c.players; p++) bots.push({ name: `P${p}`, file: "bench", runner: await createBot(compiled.code, p, { fuel: rules.fuel }) })
  const t0 = performance.now()
  const replay = runMatch({ ruleset: rules, bots, seed: 1 })
  const total = (performance.now() - t0) / 1000
  const calls = replay.bots.reduce((a, b) => a + b.calls, 0)
  const fuelAvg = replay.bots.reduce((a, b) => a + b.fuelTotal, 0) / Math.max(1, calls)
  const fuelMax = Math.max(...replay.bots.map((b) => b.fuelMax))
  const size = JSON.stringify(replay).length / 1e6
  console.log(
    [
      `${c.side}×${c.side}`,
      c.players,
      c.perPlayer,
      c.interval,
      replay.perf.peakEntities,
      total.toFixed(1),
      (replay.perf.simMs / TICKS).toFixed(2),
      (replay.perf.botMs / Math.max(1, calls)).toFixed(2),
      `${fuelAvg.toFixed(0)}/${fuelMax}`,
      size.toFixed(1),
    ].join("\t"),
  )
}
