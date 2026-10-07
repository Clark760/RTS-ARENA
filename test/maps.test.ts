// 随机地图（D-141）：每个自带规则包按种子生成对称的地图，同一个种子永远一样，生成器校验连通
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { test } from "node:test"
import { randomSymmetricMap, STANDARD_TERRAIN, symmetricTerrain } from "../rulesets/common/standard.ts"
import { importRuleset, listRulesets } from "../src/cli/catalog.ts"
import { buildPrompt, setupWorld } from "../src/cli/docgen.ts"
import { Mulberry32 } from "../src/core/rng.ts"
import { PKG_ROOT } from "../src/paths.ts"

const CLI = join(PKG_ROOT, "src", "cli", "arena.ts")

/** 四方向能不能从 a 走到 b（实体占的格子当成走不通，起点终点除外） */
function reachable(w: ReturnType<typeof setupWorld>, a: { x: number; y: number }, b: { x: number; y: number }, walk: (ch: string) => boolean): boolean {
  const W = w.width
  const H = w.height
  const blocked = new Uint8Array(W * H)
  for (const e of w.entities()) if (e.def.kind !== "unit") for (let y = e.y; y < e.y + e.h; y++) for (let x = e.x; x < e.x + e.w; x++) blocked[y * W + x] = 1
  const seen = new Uint8Array(W * H)
  const q = [a.y * W + a.x]
  seen[q[0]] = 1
  for (let h = 0; h < q.length; h++) {
    const i = q[h]
    const x = i % W
    const y = (i - x) / W
    if (x === b.x && y === b.y) return true
    for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
      const j = ny * W + nx
      if (seen[j] || (blocked[j] && !(nx === b.x && ny === b.y)) || !walk(w.terrain[ny][nx])) continue
      seen[j] = 1
      q.push(j)
    }
  }
  return false
}

test("每个自带规则包：地图随种子变、同一个种子一样、严格对称，各家主基地之间走得通", async () => {
  for (const id of listRulesets()) {
    const rules = await importRuleset(id)
    const n = rules.players.max >= 4 && id !== "koth" ? 4 : rules.players.min
    const seen = new Set<string>()
    for (let s = 1; s <= 30; s++) {
      const w = setupWorld(rules, n, undefined, s)
      const T = w.terrain
      seen.add(T.join("\n"))
      assert.deepEqual(setupWorld(rules, n, undefined, s).terrain, T, `${id} 种子 ${s} 两次生成不一样`)
      const W = w.width
      const H = w.height
      const rot4 = W === H && n >= 3
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) assert.equal(T[y][x], rot4 ? T[x][W - 1 - y] : T[H - 1 - y][W - 1 - x], `${id} 种子 ${s} (${x}, ${y}) 不对称`)
      const res = w.entities().filter((e) => e.def.kind === "resource")
      const at = new Set(res.map((e) => `${e.x},${e.y}`))
      for (const e of res) {
        const m = rot4 ? { x: W - e.y - e.h, y: e.x } : { x: W - e.x - e.w, y: H - e.y - e.h }
        assert.ok(at.has(`${m.x},${m.y}`), `${id} 种子 ${s} 资源点 (${e.x}, ${e.y}) 没有对称的`)
      }
      const bases = w.entities().filter((e) => e.type === "base")
      const walk = (ch: string) => rules.terrain[ch]?.walkable === true
      for (const b of bases.slice(1)) assert.ok(reachable(w, { x: bases[0].x, y: bases[0].y }, { x: b.x, y: b.y }, walk), `${id} 种子 ${s} 主基地之间走不通`)
    }
    // 30 个种子都是不同的地图（退回经典布局的话会重复）
    assert.equal(seen.size, 30, `${id} 30 个种子只有 ${seen.size} 种地图`)
  }
})

test("randomSymmetricMap：生成不出合格的地图时返回 null（规则包用经典布局）", () => {
  const spec = {
    width: 20,
    height: 12,
    symmetry: "point" as const,
    base: symmetricTerrain(20, 12, ".", []),
    terrain: STANDARD_TERRAIN,
    obstacles: { count: [2, 3] as [number, number], shapes: [{ w: [2, 3] as [number, number], h: [1, 2] as [number, number] }], chars: [["#", 1]] as [string, number][] },
    connect: [{ x: 2, y: 2 }],
  }
  const ok = randomSymmetricMap(new Mulberry32(5), spec)
  assert.ok(ok && ok.terrain.join("").includes("#"))
  // 能走的格子要 99%：放了障碍就不够，一直不合格
  assert.equal(randomSymmetricMap(new Mulberry32(5), { ...spec, minOpen: 0.99, tries: 20 }), null)
})

test("说明书和 map 命令：随机地图的规则包写明每局不同、哪些固定，别写死坐标", async () => {
  const rules = await importRuleset("annihilation")
  const prompt = buildPrompt(rules, join(PKG_ROOT, "rulesets", "annihilation"), "")
  assert.match(prompt, /这个规则包的地图每局按种子随机生成/)
  assert.match(prompt, /每局都一样的：各家开局的建筑和单位、8 个资源点（每局位置不变的那些，不一定都在家门口）/)
  assert.match(prompt, /每局不同的：其余 6 个资源点的位置、墙、水这些地形/)
  const r = spawnSync(process.execPath, [CLI, "map", "koth", "--seed", "3"], { encoding: "utf8" })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /种子 3 时的样子/)
  assert.match(r.stdout, /rts-arena map koth --seed 2/)
})
