// 联赛的精彩对局：从回放算每局的"看点"（逆转、优势换手、大战、险胜、爆冷），打个精彩度，挑出最值得看的几局。
// 只用回放里的通用信息（实体造价、生命、死亡、分数），所有规则包都能用。
import { applyFrame, ReplayModel } from "../core/replay-model.ts"
import type { Replay } from "../core/types.ts"
import { groupBattles, MIN_BATTLE } from "./battles.ts"

/** 一局的看点（和联赛排名无关的部分，打完一局就能算） */
export interface GameFacts {
  /** 各方（队伍编号；各自为战时就是座位） */
  sides: number[]
  /** 赢的一方；平局 null */
  winner: number | null
  /** 赢家兵力（单位和建筑按造价算）落后、后来又反超的那段里最落后的时候：tick、赢家 / 当时最强的对手 */
  materialLow: { t: number; ratio: number; foe: number } | null
  /** 赢家比分最落后的时候：tick、赢家的分、当时领先的对手的分、对手是谁（规则包有分数时） */
  scoreLow: { t: number; mine: number; theirs: number; foe: number } | null
  /** 兵力领先的一方换了几次（领先要超过 15% 才算） */
  leadChanges: number
  /** 死 3 个以上的战斗场数、最大一场死了几个 */
  battles: number
  biggestBattle: number
  /** 打死的（按造价）占双方所有单位和建筑造价的比例 */
  killedRatio: number
  /** 赢家的主建筑（开局最大生命的建筑）最低剩多少血（比例）；没有主建筑时 null */
  winnerBaseMin: number | null
  /** 最后的分数：赢家和最高的对手（规则包有分数时） */
  finalScores: { winner: number; foe: number } | null
  /** 有 bot 报错、燃料耗尽或停止运行 */
  trouble: boolean
}

const costOf = (replay: Replay, type: string) => Object.values(replay.types[type]?.cost ?? {}).reduce((a: number, c) => a + (c ?? 0), 0)

export function gameFacts(replay: Replay): GameFacts {
  const n = replay.players.length
  const side = (p: number) => replay.players[p]?.team ?? p
  const sides = [...new Set(replay.players.map((_, p) => side(p)))]
  const won = replay.result.winners ?? []
  const winner = won.length > 0 && new Set(won.map(side)).size === 1 ? side(won[0]) : null
  const kind = (type: string) => replay.types[type]?.kind
  const model = new ReplayModel(replay)
  const s = model.initialState()
  const T = Math.max(1, replay.result.tick)
  const every = Math.max(10, Math.round(T / 200))

  // 主建筑：每个座位开局时生命最大的建筑
  const mainOf = new Map<number, number>()
  for (const e of s.ents.values()) {
    if (e.owner < 0 || e.owner >= n || kind(e.type) !== "building") continue
    const cur = mainOf.get(e.owner)
    const hp = replay.types[e.type]?.maxHp ?? 0
    if (cur === undefined || hp > (replay.types[s.ents.get(cur)!.type]?.maxHp ?? 0)) mainOf.set(e.owner, e.id)
  }
  const mainIds = new Map([...mainOf].map(([p, id]) => [id, p]))
  const baseMin = new Map<number, number>()
  for (const [id, p] of mainIds) baseMin.set(p, 1)
  const noteHp = (id: number, hp: number) => {
    const p = mainIds.get(id)
    if (p === undefined) return
    const max = replay.types[s.ents.get(id)?.type ?? ""]?.maxHp || 1
    baseMin.set(p, Math.min(baseMin.get(p) ?? 1, Math.max(0, hp) / max))
  }

  let built = 0
  for (const e of s.ents.values()) if (e.owner >= 0 && kind(e.type) !== "resource") built += costOf(replay, e.type)
  let killed = 0
  const deaths: { t: number; x: number; y: number }[] = []
  const samples: { t: number; mat: number[]; score: number[] }[] = []
  const sample = (t: number) => {
    const mat = sides.map(() => 0)
    for (const e of s.ents.values()) {
      if (e.owner < 0 || e.owner >= n || kind(e.type) === "resource") continue
      mat[sides.indexOf(side(e.owner))] += costOf(replay, e.type)
    }
    const score = sides.map(() => 0)
    s.players.forEach((ps, p) => (score[sides.indexOf(side(p))] += ps.score))
    samples.push({ t, mat, score })
  }
  sample(0)
  for (const f of replay.frames) {
    const removed = new Set(f.removed ?? [])
    for (const id of f.die ?? []) {
      const e = s.ents.get(id)
      if (!e || removed.has(id) || kind(e.type) === "resource") continue
      if (mainIds.has(id)) noteHp(id, 0)
      if (e.owner < 0) continue
      killed += costOf(replay, e.type)
      deaths.push({ t: f.t, x: e.x, y: e.y })
    }
    const hp = f.hp ?? []
    for (let i = 0; i < hp.length; i += 2) noteHp(hp[i], hp[i + 1])
    applyFrame(s, f)
    for (const e of f.spawn ?? []) if (e.owner >= 0 && kind(e.type) !== "resource") built += costOf(replay, e.type)
    if (f.t % every === 0 || f.t === T) sample(f.t)
  }

  // 兵力：领先的一方换了几次、赢家最落后的时候（兵力太少的开局阶段不算）
  const maxTotal = Math.max(1, ...samples.map((x) => x.mat.reduce((a, b) => a + b, 0)))
  let leader = -1
  let leadChanges = 0
  let materialLow: GameFacts["materialLow"] = null
  let dip: GameFacts["materialLow"] = null
  for (const x of samples) {
    if (x.mat.reduce((a, b) => a + b, 0) < maxTotal * 0.3) continue
    const order = x.mat.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0])
    const [top, second] = [order[0], order[1] ?? [0, -1]]
    if (top[0] > 0 && (top[0] - second[0]) / (top[0] + second[0]) >= 0.15 && top[1] !== leader) {
      if (leader >= 0) leadChanges++
      leader = top[1]
    }
    if (winner !== null) {
      const w = sides.indexOf(winner)
      const foes = x.mat.map((v, i) => [v, i]).filter(([, i]) => i !== w)
      const best = foes.sort((a, b) => b[0] - a[0])[0]
      if (best && best[0] > 0) {
        // 逆转只算"落后之后又反超了"的：记下这段落后里最低的一刻，反超时才算数
        const ratio = x.mat[w] / best[0]
        if (!dip || ratio < dip.ratio) dip = { t: x.t, ratio, foe: sides[best[1]] }
        if (ratio >= 1.1 && dip.ratio < 1 && (!materialLow || dip.ratio < materialLow.ratio)) materialLow = dip
        if (ratio >= 1.1) dip = null
      }
    }
  }
  // 分数：赢家最落后的时候
  const finalScore = samples[samples.length - 1].score
  const maxScore = Math.max(0, ...finalScore)
  let scoreLow: GameFacts["scoreLow"] = null
  let finalScores: GameFacts["finalScores"] = null
  if (maxScore > 0 && winner !== null) {
    const w = sides.indexOf(winner)
    for (const x of samples) {
      const foes = x.score.map((v, i) => [v, i]).filter(([, i]) => i !== w)
      const best = foes.sort((a, b) => b[0] - a[0])[0]
      if (best && best[0] - x.score[w] > (scoreLow ? scoreLow.theirs - scoreLow.mine : 0)) scoreLow = { t: x.t, mine: x.score[w], theirs: best[0], foe: sides[best[1]] }
    }
    const foe = Math.max(...finalScore.filter((_, i) => i !== w))
    finalScores = { winner: finalScore[w], foe }
  }

  // 战斗：切分规则见 battles.ts（和战报、联赛视频一样）
  const big = groupBattles(deaths).filter((g) => g.length >= MIN_BATTLE)

  // 险胜看赢家里主建筑活到最后的（分队时队友已经出局的不算"差点被拆"）
  const winnerSeats = replay.players.map((_, p) => p).filter((p) => winner !== null && side(p) === winner)
  const alive = winnerSeats.filter((p) => mainOf.has(p) && s.ents.has(mainOf.get(p)!))
  const mins = (alive.length ? alive : winnerSeats).map((p) => baseMin.get(p)).filter((v): v is number => v !== undefined)
  return {
    sides,
    winner,
    materialLow,
    scoreLow,
    leadChanges,
    battles: big.length,
    biggestBattle: Math.max(0, ...big.map((g) => g.length)),
    killedRatio: built > 0 ? killed / built : 0,
    winnerBaseMin: mins.length ? Math.min(...mins) : null,
    finalScores,
    trouble: replay.bots.some((b) => b.status === "dead" || b.errors > 0 || b.fuelOuts > 0),
  }
}

/**
 * 精彩度（大约 0～100）和看点。upset 是爆冷程度（0～1：赢家的联赛得分率比对手低多少），
 * name(side) 是一方的显示名
 */
export function excitement(f: GameFacts, upset: { level: number; text: string } | null, name: (side: number) => string): { score: number; reasons: string[] } {
  const parts: { v: number; text: string | null }[] = []
  const W = f.winner === null ? "" : name(f.winner)
  // 逆转：兵力或比分一度明显落后
  const matBack = f.materialLow ? 1 - f.materialLow.ratio : 0
  const scoreBack = f.scoreLow && f.finalScores ? (f.scoreLow.theirs - f.scoreLow.mine) / Math.max(1, f.finalScores.winner, f.finalScores.foe) : 0
  const back = Math.max(matBack, scoreBack)
  parts.push({
    v: 35 * Math.min(back / 0.6, 1),
    text:
      back < 0.3
        ? null
        : scoreBack >= matBack
          ? `逆转：t${f.scoreLow!.t} 时 ${W} 比分落后 ${Math.round(f.scoreLow!.mine)} : ${Math.round(f.scoreLow!.theirs)}`
          : `逆转：t${f.materialLow!.t} 时 ${W} 的兵力和建筑只有 ${name(f.materialLow!.foe)} 的 ${Math.round(f.materialLow!.ratio * 100)}%`,
  })
  parts.push({ v: 15 * (Math.min(f.leadChanges, 4) / 4), text: f.leadChanges >= 2 ? `优势换手 ${f.leadChanges} 次` : null })
  parts.push({ v: 15 * Math.min(f.killedRatio / 0.6, 1), text: f.killedRatio >= 0.4 ? `造出来的单位和建筑打掉了 ${Math.round(f.killedRatio * 100)}%` : null })
  parts.push({ v: 10 * (Math.min(f.battles, 5) / 5), text: f.battles >= 2 ? `${f.battles} 场大战（最大一场死了 ${f.biggestBattle} 个）` : null })
  // 险胜：赢家的主建筑差点被拆，或者比分咬得很紧
  const baseClose = f.winnerBaseMin === null ? 0 : 1 - f.winnerBaseMin
  // 比分接近：只在赢家比分不落后时算（落后还赢了是拆了家，那算逆转）
  const fs0 = f.finalScores
  const scoreClose = fs0 && fs0.winner > 0 && fs0.winner >= fs0.foe ? 1 - (fs0.winner - fs0.foe) / fs0.winner : 0
  const close = Math.max(baseClose, scoreClose)
  parts.push({
    v: 15 * close,
    text:
      f.winner === null
        ? null
        : scoreClose >= baseClose && scoreClose >= 0.85
          ? `比分咬得很紧：${Math.round(f.finalScores!.winner)} : ${Math.round(f.finalScores!.foe)}`
          : baseClose >= 0.5
            ? `险胜：${W} 的主基地一度只剩 ${Math.round(f.winnerBaseMin! * 100)}% 血`
            : null,
  })
  // 爆冷：得分率差 20 个百分点以上才写出来（差得少的只是正常波动）
  if (upset) parts.push({ v: 20 * upset.level, text: upset.level >= 0.5 ? upset.text : null })
  let score = Math.min(100, parts.reduce((a, p) => a + p.v, 0))
  const quiet = f.battles === 0 && f.killedRatio < 0.05
  if (quiet) score -= 20
  if (f.winner === null) score -= 10
  if (f.trouble) score -= 30
  const reasons = parts
    .filter((p) => p.text)
    .sort((a, b) => b.v - a.v)
    .map((p) => p.text!)
  // 每项都没到写出来的门槛（几样都沾一点凑出来的分）：往后排，看点写占分最多那项的实际数字，免得标题卡上空着
  if (!reasons.length) {
    score -= 10
    const soft = [
      back <= 0 ? null : scoreBack >= matBack ? `t${f.scoreLow!.t} 时 ${W} 比分落后 ${Math.round(f.scoreLow!.mine)} : ${Math.round(f.scoreLow!.theirs)}` : `t${f.materialLow!.t} 时 ${W} 的兵力和建筑只有 ${name(f.materialLow!.foe)} 的 ${Math.round(f.materialLow!.ratio * 100)}%`,
      f.leadChanges > 0 ? `优势换手 ${f.leadChanges} 次` : null,
      f.killedRatio > 0 ? `造出来的单位和建筑打掉了 ${Math.round(f.killedRatio * 100)}%` : null,
      f.battles > 0 ? `${f.battles} 场大战（最大一场死了 ${f.biggestBattle} 个）` : null,
      f.winner === null ? null : scoreClose >= baseClose && fs0 ? `比分 ${Math.round(fs0.winner)} : ${Math.round(fs0.foe)}` : baseClose > 0 ? `${W} 的主基地一度只剩 ${Math.round(f.winnerBaseMin! * 100)}% 血` : null,
    ]
    const best = soft.map((text, i) => ({ text, v: parts[i].v })).filter((p) => p.text && p.v > 0).sort((a, b) => b.v - a.v)[0]
    if (best) reasons.push(best.text!)
  }
  if (f.trouble) reasons.push("（有 bot 出错，扣了分）")
  return { score: Math.round(score), reasons }
}

export interface Highlight {
  index: number
  seed: number
  replay: string
  /** 参赛的几方，比如 "my-bot 对 expand" */
  who: string
  /** 赢的一方的名字，平局 null */
  winner: string | null
  tick: number
  score: number
  reasons: string[]
}

/**
 * 挑精彩对局：按精彩度从高到低，同一组对手最多 2 局，太平淡的（不到 20 分）不要；最多 limit 局。
 * 同一组对手、同一方赢的先只挑 1 局（免得挑出两局一样的故事，比如两局都是同一个人爆冷赢同一个人），不够再补。
 * prefer 为 true 的局（在 bot 目录里跑联赛时，有自己的 bot 的局）排序时多算 15 分
 */
export function pickHighlights(all: (Highlight & { key: string })[], limit: number, prefer: (h: Highlight) => boolean = () => false): Highlight[] {
  const rank = (h: Highlight) => h.score + (prefer(h) ? 15 : 0)
  const sorted = [...all].filter((h) => h.score >= 20).sort((a, b) => rank(b) - rank(a) || a.index - b.index)
  const per = new Map<string, number>()
  const story = new Set<string>()
  const picked = new Set<number>()
  for (const strict of [true, false])
    for (const h of sorted) {
      if (picked.size >= limit) break
      if (picked.has(h.index) || (per.get(h.key) ?? 0) >= 2) continue
      const s = `${h.key}|${h.winner}`
      if (strict && story.has(s)) continue
      story.add(s)
      per.set(h.key, (per.get(h.key) ?? 0) + 1)
      picked.add(h.index)
    }
  return sorted.filter((h) => picked.has(h.index)).map(({ key: _, ...rest }) => rest)
}

/** 一局结束时各座位的分数（规则包的分数：歼灭是击杀价值、夺点是控制分……） */
export function finalScores(replay: Replay): number[] {
  let players = replay.initial.players
  for (const f of replay.frames) if (f.players) players = f.players
  return players.map((p) => Math.round(p.score))
}
