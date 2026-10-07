// 视频页面里跑的代码：画每一帧、用 WebCodecs 编成 H.264、交给 mp4-muxer 封装成 MP4。
// installVideoPage 会被 toString() 后原样注入无头浏览器，所以必须自包含：不能引用这个文件外面的任何东西。
// Node 那边每帧算好要画的东西（场景的固定内容用 __scene 送一次，回放的局面每帧用 __frames 送）

/** 一个场景的固定内容 */
export type SceneData =
  | { kind: "brandOpen"; frames: number; ruleset: string }
  | { kind: "title"; frames: number; ruleset: string; eyebrow: string; title: string; userText: string | null; theme: string | null; meta: string }
  | {
      kind: "player"
      frames: number
      color: string
      displayName: string
      name: string
      byline: string | null
      tagline: string
      intro: string[]
      codeHeader: string[]
      facts: string[]
      /** 战绩，一两行 */
      record: string[]
      rank: number
      total: number
    }
  | { kind: "standings"; frames: number; title: string; rows: { name: string; color: string; rank: number; record: string; rate: number; elo: number }[] }
  | { kind: "hlTitle"; frames: number; no: number; title: string; sides: { name: string; color: string }[]; result: string; reasons: string[]; commentary: string | null }
  | {
      kind: "replay"
      frames: number
      no: number
      title: string
      commentary: string | null
      width: number
      height: number
      terrain: string[]
      colors: Record<string, string>
      types: { name: string; kind: string; shape: string; label: string; color: string | null; worker: boolean }[]
      /** 每个座位的名字和颜色 */
      seats: { name: string; color: string }[]
      result: string
    }
  | { kind: "brandClose"; frames: number; outro: string | null; credits: string[] }

/** 回放场景每帧变化的部分 */
export interface ReplayFrame {
  t: number
  /** [x, y, w, h, 座位(-1 中立), 类型下标, 生命百分比, 建造进度(100 是建好)] 一组 8 个 */
  ents: number[]
  /** [x1, y1, x2, y2, 座位] 一组 5 个 */
  shots: number[]
  /** 刚死的：[x, y, 第几帧前死的] 一组 3 个 */
  deaths: number[]
  /** 每个座位：兵、工人、建筑、分数（歼灭是击杀价值、夺点是控制分……看规则包） */
  counts: { army: number; workers: number; buildings: number; score: number; alive: boolean }[]
  events: string[]
  progress: number
  /** 最后定格时显示结果 */
  final: boolean
  /** 这段没什么动静，正在快进 */
  fast: boolean
  /** 规则包画在地图上的标记（控制点、台址……），和回放页面一样 */
  markers: ({ kind: "zone"; x: number; y: number; w: number; h: number; owner: number | null; label?: string; color?: string } | { kind: "label"; x: number; y: number; text: string; owner?: number | null })[]
  /** 规则包的状态栏文字（比分、目标……） */
  status: string
}

export function installVideoPage(): void {
  // 画面按 1280×720 排版，输出时整体放大（1920×1080 是 1.5 倍）；文字和图形都是矢量画的，放大不糊
  const W = 1280
  const H = 720
  let SCALE = 1.5
  const FONT = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif'
  const MONO = 'Consolas, "Cascadia Mono", "Microsoft YaHei", monospace'
  /** 平台的远程仓库（片头下方、片尾署名里） */
  const REPO = "gitee.com/mingomin/rts-arena"
  const C = { bg1: "#0b1220", bg2: "#14203a", text: "#e8edf7", muted: "#8fa0bf", accent: "#f5b942", line: "#26344f", panel: "rgba(16,26,46,0.92)" }
  let canvas = new OffscreenCanvas(W * SCALE, H * SCALE)
  let g = canvas.getContext("2d")!
  type Any = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const w = globalThis as unknown as Any
  let scene: Any | null = null
  let terrainLayer: OffscreenCanvas | null = null
  let encoder: VideoEncoder | null = null
  let muxer: Any | null = null
  let frameNo = 0
  let fps = 30
  let output: Uint8Array | null = null

  const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - Math.pow(1 - x, 3))
  const font = (px: number, bold = false, mono = false) => `${bold ? "bold " : ""}${px}px ${mono ? MONO : FONT}`

  function background(): void {
    const grad = g.createLinearGradient(0, 0, W, H)
    grad.addColorStop(0, C.bg1)
    grad.addColorStop(1, C.bg2)
    g.fillStyle = grad
    g.fillRect(0, 0, W, H)
    // 淡淡的格子，像地图
    g.strokeStyle = "rgba(255,255,255,0.035)"
    g.lineWidth = 1
    for (let x = 0; x <= W; x += 32) {
      g.beginPath()
      g.moveTo(x + 0.5, 0)
      g.lineTo(x + 0.5, H)
      g.stroke()
    }
    for (let y = 0; y <= H; y += 32) {
      g.beginPath()
      g.moveTo(0, y + 0.5)
      g.lineTo(W, y + 0.5)
      g.stroke()
    }
  }

  /** 不能放在行首的标点：宁可让这一行稍微超出一点 */
  const NO_START = "，。、；：？！”’）》」』】…,.;:?!)"
  /** 按字折行（中文没有空格），返回每行；英文单词尽量不拆开 */
  function wrap(text: string, maxWidth: number): string[] {
    const out: string[] = []
    let line = ""
    for (const ch of text) {
      if (ch === "\n") {
        out.push(line)
        line = ""
        continue
      }
      if (g.measureText(line + ch).width > maxWidth && line && !NO_START.includes(ch)) {
        // 正在写一个英文单词：把它整个挪到下一行
        const m = /[A-Za-z0-9.]+$/.exec(line)
        if (m && /[A-Za-z0-9]/.test(ch) && m[0].length < line.length) {
          out.push(line.slice(0, -m[0].length))
          line = m[0] + ch
          continue
        }
        out.push(line)
        line = ch
      } else line += ch
    }
    if (line) out.push(line)
    return out
  }

  /**
   * 好看的折行：行数和 wrap 一样少，在这个前提下各行尽量一样长，并且尽量在标点后面断行（不把"谷歌之罪"拆到两行）；
   * 英文单词和数字不拆开。按当前字体量，结果缓存起来（每帧都会画）
   */
  const niceCache = new Map<string, string[]>()
  /** 句读：在它后面断行最自然 */
  const PUNCT = "，。、；：？！”’）》」』】…,.;:?!)"
  /** 除了最后一行，每行都停在标点上 */
  const endsAtPunct = (lines: string[]) => lines.slice(0, -1).every((l) => PUNCT.includes(l.at(-1) ?? ""))
  function wrapBalanced(text: string, maxWidth: number): string[] {
    const key = `${g.font}|${maxWidth}|${text}`
    const hit = niceCache.get(key)
    if (hit) return hit
    const ch = [...text]
    const N = ch.length
    const alnum = (c: string | undefined) => !!c && /[A-Za-z0-9.]/.test(c)
    // 第 i 个字前面能不能断
    const canBreak = (i: number) => i === N || (!NO_START.includes(ch[i]) && !(alnum(ch[i - 1]) && alnum(ch[i])))
    const width = (i: number, j: number) => g.measureText(ch.slice(i, j).join("").trim()).width
    const P = (0.35 * maxWidth) ** 2
    // best[j]：前 j 个字排好的最小代价（先比行数，再比各行剩下的空白平方和 + 不在标点后断行的罚分）
    const best: { lines: number; cost: number; from: number }[] = [{ lines: 0, cost: 0, from: -1 }]
    for (let j = 1; j <= N; j++) {
      best[j] = { lines: Infinity, cost: Infinity, from: -1 }
      if (!canBreak(j)) continue
      for (let i = j - 1; i >= 0; i--) {
        if (best[i].lines === Infinity || (i > 0 && !canBreak(i))) continue
        const w = width(i, j)
        if (w > maxWidth && j - i > 1) break
        const cost = best[i].cost + (maxWidth - w) ** 2 + (j < N && !PUNCT.includes(ch[j - 1]) ? P : 0)
        const lines = best[i].lines + 1
        if (lines < best[j].lines || (lines === best[j].lines && cost < best[j].cost)) best[j] = { lines, cost, from: i }
      }
    }
    let out: string[]
    if (best[N].lines === Infinity) out = wrap(text, maxWidth)
    else {
      out = []
      for (let j = N; j > 0; j = best[j].from) out.unshift(ch.slice(best[j].from, j).join("").trim())
    }
    niceCache.set(key, out)
    return out
  }

  function text(s: string, x: number, y: number, px: number, color: string, opts: { bold?: boolean; align?: CanvasTextAlign; mono?: boolean; alpha?: number } = {}): void {
    g.globalAlpha = opts.alpha ?? 1
    g.font = font(px, opts.bold, opts.mono)
    g.fillStyle = color
    g.textAlign = opts.align ?? "left"
    g.textBaseline = "alphabetic"
    g.fillText(s, x, y)
    g.globalAlpha = 1
  }

  function roundRect(x: number, y: number, ww: number, hh: number, r: number, fill: string, stroke?: string): void {
    g.beginPath()
    g.roundRect(x, y, ww, hh, r)
    g.fillStyle = fill
    g.fill()
    if (stroke) {
      g.strokeStyle = stroke
      g.lineWidth = 1.5
      g.stroke()
    }
  }

  /** 角落里的小署名（除片头片尾外每个画面都有） */
  function watermark(): void {
    text("RTS Arena", W - 24, H - 18, 16, "rgba(232,237,247,0.45)", { bold: true, align: "right" })
  }

  function fade(i: number, n: number): void {
    const k = 12
    const a = i < k ? 1 - i / k : i > n - k ? (i - (n - k)) / k : 0
    if (a > 0) {
      g.globalAlpha = Math.min(1, a)
      g.fillStyle = "#000"
      g.fillRect(0, 0, W, H)
      g.globalAlpha = 1
    }
  }

  // ---------- 各个场景 ----------
  function brandOpen(s: Any, i: number): void {
    background()
    const p = ease(i / 30)
    g.save()
    g.translate(0, (1 - p) * 30)
    text("RTS Arena", W / 2, 320, 104, C.text, { bold: true, align: "center", alpha: p })
    g.fillStyle = C.accent
    g.globalAlpha = p
    g.fillRect(W / 2 - 220 * p, 352, 440 * p, 4)
    g.globalAlpha = 1
    text("大模型写 bot 的即时战略竞技平台", W / 2, 410, 34, C.text, { align: "center", alpha: ease((i - 12) / 25) })
    text(`联赛视频 · ${s.ruleset} · 由 RTS Arena 平台生成`, W / 2, 470, 24, C.muted, { align: "center", alpha: ease((i - 24) / 25) })
    g.restore()
    // 下方：远程仓库地址
    text(REPO, W / 2, H - 64, 24, C.accent, { align: "center", alpha: ease((i - 30) / 25) })
  }

  function title(s: Any, i: number): void {
    background()
    text(s.eyebrow, 80, 110, 26, C.accent, { bold: true, alpha: ease(i / 20) })
    text(s.title, 80, 190, 64, C.text, { bold: true, alpha: ease((i - 5) / 20) })
    let y = 260
    if (s.userText) {
      const a = ease((i - 20) / 25)
      // 字号 38；只比一行多一点时缩小字号放进一行，否则均衡折行
      const maxW = W - 300
      let px = 38
      g.font = font(px, true)
      const full = g.measureText(s.userText).width
      if (full > maxW && full <= maxW * 1.2) px = Math.floor((38 * maxW) / full)
      else if (full > maxW) {
        // 多行：字号缩一点（最多到 34）就能每行都停在标点上的话，就缩
        const n0 = wrapBalanced(s.userText, maxW).length
        for (let p = 38; p >= 34; p--) {
          g.font = font(p, true)
          const ls = wrapBalanced(s.userText, maxW)
          if (ls.length <= n0 && endsAtPunct(ls)) {
            px = p
            break
          }
        }
      }
      g.font = font(px, true)
      const lines = wrapBalanced(s.userText, maxW)
      const lh = Math.round(px * 1.42)
      const pad = 30
      // 按字形的实际高度排：上下留白一样
      const m = g.measureText(lines[0])
      const asc = m.fontBoundingBoxAscent * 0.86
      const boxH = pad * 2 + asc + (lines.length - 1) * lh + px * 0.14
      const top = y
      g.globalAlpha = a
      roundRect(64, top, W - 128, boxH, 14, "rgba(245,185,66,0.08)", "rgba(245,185,66,0.35)")
      g.globalAlpha = 1
      const base0 = top + pad + asc
      lines.forEach((l, k) => text(l, 150, base0 + k * lh, px, C.text, { bold: true, alpha: a }))
      // 前后引号：开引号顶住第一行的字顶，收引号跟在最后一行后面
      g.font = font(72, true)
      const qo = g.measureText("“")
      text("“", 140, base0 - asc + qo.actualBoundingBoxAscent - 4, 72, C.accent, { bold: true, align: "right", alpha: a }) // 全角引号的字形在右半边，右对齐才不贴字
      g.font = font(px, true)
      const lastW = g.measureText(lines[lines.length - 1]).width
      g.font = font(72, true)
      const qc = g.measureText("”")
      text("”", 150 + lastW + 10, base0 + (lines.length - 1) * lh - asc + qc.actualBoundingBoxAscent - 4, 72, C.accent, { bold: true, alpha: a })
      y = top + boxH + 50
    }
    if (s.theme) {
      g.font = font(28)
      wrapBalanced(s.theme, W - 180).forEach((l, k) => text(l, 84, y + 30 + k * 40, 28, C.accent, { alpha: ease((i - 50) / 25) }))
    }
    text(s.meta, 80, H - 60, 22, C.muted, { alpha: ease((i - 30) / 25) })
    watermark()
  }

  function player(s: Any, i: number): void {
    background()
    const p = ease(i / 18)
    // 左边一条选手颜色
    g.fillStyle = s.color
    g.fillRect(0, 0, 14 * p, H)
    text(`选手 ${s.rank <= s.total ? `· 联赛第 ${s.rank} 名` : ""}`, 70, 92, 24, s.color, { bold: true, alpha: p })
    text(s.displayName, 70, 164, 58, C.text, { bold: true, alpha: p })
    let y = 206
    if (s.byline) {
      text(s.byline, 72, y, 24, C.muted, { alpha: p })
      y += 8
    }
    text(s.tagline, 72, y + 46, 32, C.accent, { bold: true, alpha: ease((i - 10) / 18) })
    y += 106
    g.font = font(27)
    s.intro.forEach((line: string, k: number) => {
      const a = ease((i - 20 - k * 9) / 12)
      const ls = wrapBalanced(line, 660)
      g.fillStyle = s.color
      g.globalAlpha = a
      g.beginPath()
      g.arc(80, y - 9, 5, 0, Math.PI * 2)
      g.fill()
      g.globalAlpha = 1
      ls.forEach((l, j) => text(l, 100, y + j * 38, 27, C.text, { alpha: a }))
      y += ls.length * 38 + 16
    })
    // 右边：代码卡片和战绩
    const x0 = 820
    const a2 = ease((i - 14) / 20)
    g.globalAlpha = a2
    roundRect(x0, 70, 400, 380, 12, "#0a0f1a", C.line)
    g.globalAlpha = 1
    text(s.name + ".ts", x0 + 18, 100, 16, C.muted, { mono: true, alpha: a2 })
    // 文件开头的 12 行：注释绿色、代码灰色
    s.codeHeader.slice(0, 12).forEach((l: string, k: number) => {
      g.font = font(15, false, true)
      let shown = l
      while (shown && g.measureText(shown).width > 364) shown = shown.slice(0, -1)
      const isComment = /^\s*(\/\/|\/\*|\*)/.test(l)
      text(shown + (shown.length < l.length ? "…" : ""), x0 + 18, 132 + k * 24, 15, isComment ? "#7fb37a" : "#c9d3e6", { mono: true, alpha: a2 })
    })
    g.globalAlpha = a2
    roundRect(x0, 470, 400, 200, 12, C.panel, C.line)
    g.globalAlpha = 1
    text("代码", x0 + 20, 504, 18, C.muted, { bold: true, alpha: a2 })
    s.facts.forEach((f: string, k: number) => text(f, x0 + 20, 532 + k * 26, 18, C.text, { alpha: a2 }))
    s.record.forEach((r: string, k: number) => text(r, x0 + 20, 622 + k * 26, 19, s.color, { bold: true, alpha: a2 }))
    watermark()
  }

  function standings(s: Any, i: number): void {
    background()
    text(s.title, 80, 110, 44, C.text, { bold: true, alpha: ease(i / 15) })
    s.rows.forEach((r: Any, k: number) => {
      const a = ease((i - 10 - k * 10) / 15)
      const y = 180 + k * 96
      g.globalAlpha = a
      roundRect(80, y, W - 160, 80, 12, C.panel, C.line)
      g.fillStyle = r.color
      g.fillRect(80, y, 8, 80)
      g.globalAlpha = 1
      text(`#${r.rank}`, 112, y + 52, 34, r.color, { bold: true, alpha: a })
      text(r.name, 190, y + 38, 28, C.text, { bold: true, alpha: a })
      text(r.record, 190, y + 66, 18, C.muted, { alpha: a })
      // 得分率条
      const bw = 220 * r.rate * ease((i - 20 - k * 10) / 30)
      g.globalAlpha = a
      roundRect(850, y + 30, 220, 20, 10, "rgba(255,255,255,0.08)")
      if (bw > 1) roundRect(850, y + 30, bw, 20, 10, r.color)
      g.globalAlpha = 1
      text(`${Math.round(r.rate * 100)}%`, W - 104, y + 48, 22, C.text, { bold: true, align: "right", alpha: a })
    })
    watermark()
  }

  function hlTitle(s: Any, i: number): void {
    background()
    const p = ease(i / 15)
    text(`精彩对局 ${s.no}`, 80, 130, 30, C.accent, { bold: true, alpha: p })
    text(s.title, 80, 205, 54, C.text, { bold: true, alpha: p })
    let x = 80
    s.sides.forEach((sd: Any, k: number) => {
      if (k > 0) {
        text("对", x + 8, 285, 28, C.muted, { alpha: p })
        x += 56
      }
      g.font = font(30, true)
      const tw = g.measureText(sd.name).width
      g.globalAlpha = p
      roundRect(x, 252, tw + 36, 46, 10, sd.color)
      g.globalAlpha = 1
      text(sd.name, x + 18, 286, 30, "#0b1220", { bold: true, alpha: p })
      x += tw + 44
    })
    text(s.result, 80, 345, 26, C.text, { alpha: ease((i - 8) / 15) })
    let y = 410
    g.font = font(24)
    s.reasons.slice(0, 4).forEach((r: string, k: number) => {
      const a = ease((i - 16 - k * 6) / 12)
      wrap(r, W - 220).forEach((l, j) => {
        if (j === 0) text("▸", 84, y, 24, C.accent, { alpha: a })
        text(l, 116, y, 24, C.text, { alpha: a })
        y += 34
      })
      y += 6
    })
    if (s.commentary) {
      g.font = font(28, true)
      wrapBalanced(s.commentary, W - 200).forEach((l, k) => text(l, 84, y + 34 + k * 40, 28, C.accent, { bold: true, alpha: ease((i - 30) / 15) }))
    }
    watermark()
  }

  /** 一格多大：按地图大小算，尽量铺满左边（输出时是整数像素，地形不会有缝） */
  let TILE = 18
  const MX = 24
  const MY = 92
  function fitTile(s: Any): void {
    const t = Math.min(26, (H - MY - 44) / s.height, (W - MX - 20 - 330 - 20) / s.width)
    TILE = Math.floor(t * SCALE) / SCALE
  }
  function replay(s: Any, f: Any, i: number): void {
    g.fillStyle = C.bg1
    g.fillRect(0, 0, W, H)
    // 顶部
    text(`精彩对局 ${s.no}`, 24, 38, 20, C.accent, { bold: true })
    text(s.title, 140, 38, 22, C.text, { bold: true })
    if (s.commentary) {
      // 解说放一行：放不下就缩小字号，最小 14 号还放不下就折成两行
      let px = 18
      g.font = font(px)
      while (px > 14 && g.measureText(s.commentary).width > W - 60) g.font = font(--px)
      const ls = wrap(s.commentary, W - 60)
      if (ls.length === 1) text(ls[0], 24, 70, px, C.muted)
      else ls.slice(0, 2).forEach((l, k) => text(l, 24, 62 + k * 18, px, C.muted))
    }
    // 地图
    if (!terrainLayer) {
      // 按输出的实际像素画一次地形，之后每帧贴上去
      terrainLayer = new OffscreenCanvas(Math.ceil(s.width * TILE * SCALE), Math.ceil(s.height * TILE * SCALE))
      const t = terrainLayer.getContext("2d")!
      t.scale(SCALE, SCALE)
      for (let y = 0; y < s.height; y++)
        for (let x = 0; x < s.width; x++) {
          t.fillStyle = s.colors[s.terrain[y][x]] ?? "#333"
          t.fillRect(x * TILE, y * TILE, TILE, TILE)
        }
      t.strokeStyle = "rgba(0,0,0,0.12)"
      for (let x = 0; x <= s.width; x++) {
        t.beginPath()
        t.moveTo(x * TILE + 0.5, 0)
        t.lineTo(x * TILE + 0.5, s.height * TILE)
        t.stroke()
      }
      for (let y = 0; y <= s.height; y++) {
        t.beginPath()
        t.moveTo(0, y * TILE + 0.5)
        t.lineTo(s.width * TILE, y * TILE + 0.5)
        t.stroke()
      }
    }
    g.drawImage(terrainLayer, MX, MY, s.width * TILE, s.height * TILE)
    const colorOf = (seat: number) => (seat >= 0 ? (s.seats[seat]?.color ?? "#ccc") : "#9aa0a6")
    // 规则包的标记：区域按归属上色（没人的灰色），文字标在格子上
    for (const m of (f.markers ?? []) as Any[]) {
      const col = m.color ?? (m.owner === null || m.owner === undefined || m.owner < 0 ? "#c8ccd4" : colorOf(m.owner))
      if (m.kind === "zone") {
        g.globalAlpha = 0.22
        g.fillStyle = col
        g.fillRect(MX + m.x * TILE, MY + m.y * TILE, m.w * TILE, m.h * TILE)
        g.globalAlpha = 0.9
        g.strokeStyle = col
        g.lineWidth = 2
        g.setLineDash([6, 4])
        g.strokeRect(MX + m.x * TILE + 1, MY + m.y * TILE + 1, m.w * TILE - 2, m.h * TILE - 2)
        g.setLineDash([])
        g.globalAlpha = 1
        if (m.label) text(m.label, MX + m.x * TILE + 3, MY + m.y * TILE - 4, 13, col, { bold: true })
      } else text(m.text, MX + (m.x + 0.5) * TILE, MY + (m.y + 0.5) * TILE, 13, col, { bold: true, align: "center" })
    }
    const e = f.ents as number[]
    for (let k = 0; k < e.length; k += 8) {
      const [x, y, ew, eh, seat, ti, hp, bp] = e.slice(k, k + 8)
      const ty = s.types[ti]
      const px = MX + x * TILE
      const py = MY + y * TILE
      const pw = ew * TILE
      const ph = eh * TILE
      const col = ty.color ?? colorOf(seat)
      g.globalAlpha = ty.kind === "building" ? (bp < 100 ? 0.45 : 0.85) : 1
      g.fillStyle = col
      g.strokeStyle = "rgba(0,0,0,0.6)"
      g.lineWidth = 1.2
      const cx = px + pw / 2
      const cy = py + ph / 2
      // 单位几乎占满一格，好放下汉字；工人小一点
      const r = Math.min(pw, ph) / 2 - (ty.kind === "unit" ? (ty.worker ? 1.8 : 0.8) : 1.5)
      g.beginPath()
      if (ty.shape === "square") g.roundRect(px + 1.5, py + 1.5, pw - 3, ph - 3, 3)
      else if (ty.shape === "triangle") {
        g.moveTo(cx, py + 0.5)
        g.lineTo(px + pw - 0.5, py + ph - 0.5)
        g.lineTo(px + 0.5, py + ph - 0.5)
        g.closePath()
      } else if (ty.shape === "diamond") {
        g.moveTo(cx, py + 0.3)
        g.lineTo(px + pw - 0.3, cy)
        g.lineTo(cx, py + ph - 0.3)
        g.lineTo(px + 0.3, cy)
        g.closePath()
      } else if (ty.shape === "hex") {
        for (let a = 0; a < 6; a++) {
          const ang = (Math.PI / 3) * a + Math.PI / 6
          const hx = cx + r * Math.cos(ang)
          const hy = cy + r * Math.sin(ang)
          if (a === 0) g.moveTo(hx, hy)
          else g.lineTo(hx, hy)
        }
        g.closePath()
      } else g.arc(cx, cy, r, 0, Math.PI * 2)
      g.fill()
      g.stroke()
      g.globalAlpha = 1
      // 和回放页面一样标上汉字：建筑大字，单位小字
      if (ty.kind === "building" && ty.label) text(ty.label, cx, cy + TILE / 2, (TILE * 4) / 3, "rgba(255,255,255,0.9)", { bold: true, align: "center" })
      else if (ty.kind === "unit" && ty.label) {
        // 白字加深色描边：在哪种颜色上都看得清
        g.font = font(TILE * (ty.worker ? 0.56 : 0.6), true)
        g.textAlign = "center"
        g.textBaseline = "middle"
        const ly = cy + (ty.shape === "triangle" ? 3 : 0.5)
        g.lineWidth = 1.8
        g.strokeStyle = "rgba(0,0,0,0.5)"
        g.lineJoin = "round"
        g.strokeText(ty.label, cx, ly)
        g.fillStyle = "#ffffff"
        g.fillText(ty.label, cx, ly)
        g.textBaseline = "alphabetic"
      }
      // 血条：没满血的单位和建筑
      if (ty.kind !== "resource" && hp < 100) {
        g.fillStyle = "rgba(0,0,0,0.6)"
        g.fillRect(px + 1, py - 4, pw - 2, 3)
        g.fillStyle = hp > 50 ? "#5ee08a" : hp > 25 ? "#f5c542" : "#ff5d5d"
        g.fillRect(px + 1, py - 4, ((pw - 2) * hp) / 100, 3)
      }
    }
    // 攻击线
    const sh = f.shots as number[]
    g.lineWidth = 1.6
    for (let k = 0; k < sh.length; k += 5) {
      g.strokeStyle = colorOf(sh[k + 4])
      g.globalAlpha = 0.8
      g.beginPath()
      g.moveTo(MX + (sh[k] + 0.5) * TILE, MY + (sh[k + 1] + 0.5) * TILE)
      g.lineTo(MX + (sh[k + 2] + 0.5) * TILE, MY + (sh[k + 3] + 0.5) * TILE)
      g.stroke()
      g.globalAlpha = 1
    }
    // 刚死的：一圈扩散的红圈
    const d = f.deaths as number[]
    for (let k = 0; k < d.length; k += 3) {
      const age = d[k + 2]
      g.strokeStyle = `rgba(255,120,90,${Math.max(0, 0.9 - age * 0.12)})`
      g.lineWidth = 2
      g.beginPath()
      g.arc(MX + (d[k] + 0.5) * TILE, MY + (d[k + 1] + 0.5) * TILE, ((6 + age * 2.5) * TILE) / 18, 0, Math.PI * 2)
      g.stroke()
    }
    // 右边面板
    const x0 = MX + s.width * TILE + 20
    const pw = W - x0 - 20
    roundRect(x0, MY, pw, s.height * TILE, 12, C.panel, C.line)
    let y = MY + 34
    s.seats.forEach((st: Any, k: number) => {
      const c = f.counts[k]
      g.fillStyle = st.color
      g.fillRect(x0 + 16, y - 18, 6, 64)
      g.font = font(20, true)
      let nm = st.name
      while (g.measureText(nm).width > pw - 50) nm = nm.slice(0, -1)
      text(nm + (nm.length < st.name.length ? "…" : ""), x0 + 32, y, 20, st.color, { bold: true })
      text(c.alive ? `兵 ${c.army}  工人 ${c.workers}  建筑 ${c.buildings}` : "已出局", x0 + 32, y + 26, 17, C.text)
      text(`分数 ${c.score}`, x0 + 32, y + 48, 17, C.muted)
      y += 88
    })
    g.strokeStyle = C.line
    g.beginPath()
    g.moveTo(x0 + 14, y - 14)
    g.lineTo(x0 + pw - 14, y - 14)
    g.stroke()
    // 规则包的状态栏（比分、目标……）
    if (f.status) {
      g.font = font(16)
      for (const l of wrapBalanced(f.status, pw - 32).slice(0, 2)) {
        text(l, x0 + 16, y + 10, 16, C.accent)
        y += 23
      }
      y += 12
    }
    text("战况", x0 + 16, y + 12, 17, C.muted, { bold: true })
    y += 40
    g.font = font(16)
    // 面板里放得下几条放几条，留最新的（每条最多两行）
    const bottom = MY + s.height * TILE - 14
    const blocks = (f.events as string[]).map((ev) => wrapBalanced(ev, pw - 32).slice(0, 2))
    let first = blocks.length
    let used = 0
    while (first > 0 && y + used + (blocks[first - 1].length - 1) * 23 <= bottom) used += blocks[--first].length * 23 + 4
    for (const ls of blocks.slice(first)) {
      for (const l of ls) {
        text(l, x0 + 16, y, 16, C.text)
        y += 23
      }
      y += 4
    }
    // 进度条
    const by = MY + s.height * TILE + 22
    roundRect(MX, by, s.width * TILE, 8, 4, "rgba(255,255,255,0.1)")
    roundRect(MX, by, Math.max(8, s.width * TILE * f.progress), 8, 4, C.accent)
    text(`第 ${f.t} tick`, MX + s.width * TILE, by - 6, 15, C.muted, { align: "right" })
    // 没什么动静的时候快进，打起来放慢
    if (f.fast && !f.final) text("▸▸ 快进", MX, by - 6, 15, C.accent, { bold: true })
    if (f.final) {
      g.globalAlpha = 0.85
      roundRect(MX + 120, MY + (s.height * TILE) / 2 - 60, s.width * TILE - 240, 120, 16, "#0b1220", C.accent)
      g.globalAlpha = 1
      text(s.result, MX + (s.width * TILE) / 2, MY + (s.height * TILE) / 2 + 15, 36, C.accent, { bold: true, align: "center" })
    }
    watermark()
    void i
  }

  function brandClose(s: Any, i: number): void {
    background()
    const p = ease(i / 20)
    let y = 120
    if (s.outro) {
      g.font = font(30, true)
      for (const l of wrapBalanced(s.outro, W - 240)) {
        text(l, W / 2, y, 30, C.accent, { bold: true, align: "center", alpha: p })
        y += 44
      }
      y += 30
    }
    text("RTS Arena", W / 2, y + 70, 80, C.text, { bold: true, align: "center", alpha: p })
    text("本视频由 RTS Arena 联赛视频接口自动生成", W / 2, y + 130, 28, C.text, { align: "center", alpha: ease((i - 10) / 20) })
    text(REPO, W / 2, y + 172, 24, C.accent, { align: "center", alpha: ease((i - 15) / 20) })
    text("选手", W / 2, y + 226, 18, C.muted, { bold: true, align: "center", alpha: ease((i - 20) / 20) })
    s.credits.forEach((c: string, k: number) => text(c, W / 2, y + 258 + k * 30, 20, k === s.credits.length - 1 ? C.muted : C.text, { align: "center", alpha: ease((i - 25 - k * 5) / 20) }))
  }

  function draw(f: Any | null, i: number): void {
    const s = scene!
    g.setTransform(SCALE, 0, 0, SCALE, 0, 0)
    g.save()
    if (s.kind === "brandOpen") brandOpen(s, i)
    else if (s.kind === "title") title(s, i)
    else if (s.kind === "player") player(s, i)
    else if (s.kind === "standings") standings(s, i)
    else if (s.kind === "hlTitle") hlTitle(s, i)
    else if (s.kind === "replay") replay(s, f ?? {}, i)
    else if (s.kind === "brandClose") brandClose(s, i)
    g.restore()
    fade(i, s.frames)
    g.setTransform(1, 0, 0, 1, 0, 0)
  }

  // ---------- 和 Node 那边的接口 ----------
  /** 输出尺寸（16:9，宽度 / 1280 就是放大倍数） */
  w.__size = (width: number, height: number) => {
    SCALE = width / W
    canvas = new OffscreenCanvas(width, height)
    g = canvas.getContext("2d")!
    terrainLayer = null
    return true
  }
  w.__init = (opts: { fps: number; bitrate: number }) => {
    fps = opts.fps
    const Muxer = w.Mp4Muxer
    muxer = new Muxer.Muxer({ target: new Muxer.ArrayBufferTarget(), video: { codec: "avc", width: canvas.width, height: canvas.height, frameRate: fps }, fastStart: "in-memory" })
    encoder = new VideoEncoder({
      output: (chunk, meta) => muxer!.addVideoChunk(chunk, meta),
      error: (e) => {
        w.__encodeError = String(e)
      },
    })
    // High 4.2：1080p 到 60 帧都够
    encoder.configure({ codec: "avc1.64002a", width: canvas.width, height: canvas.height, bitrate: opts.bitrate, framerate: fps })
    frameNo = 0
    return true
  }
  w.__scene = (s: Any) => {
    scene = s
    terrainLayer = null
    if (s.kind === "replay") fitTile(s)
    return true
  }
  /** 画并编码一批帧：items[k] 是 [场景里第几帧, 回放的局面或 null] */
  w.__frames = async (items: [number, Any | null][]) => {
    for (const [i, f] of items) {
      draw(f, i)
      const vf = new VideoFrame(canvas, { timestamp: Math.round((frameNo * 1e6) / fps), duration: Math.round(1e6 / fps) })
      encoder!.encode(vf, { keyFrame: frameNo % (fps * 2) === 0 })
      vf.close()
      frameNo++
      if (encoder!.encodeQueueSize > 30) await new Promise((r) => setTimeout(r, 0))
    }
    if (w.__encodeError) throw new Error(w.__encodeError)
    return frameNo
  }
  /** 画一帧，返回 PNG 的 data URL（预览用，不编码） */
  w.__png = async (i: number, f: Any | null) => {
    draw(f, i)
    const blob = await canvas.convertToBlob({ type: "image/png" })
    const buf = new Uint8Array(await blob.arrayBuffer())
    let s = ""
    for (let k = 0; k < buf.length; k += 0x8000) s += String.fromCharCode(...buf.subarray(k, k + 0x8000))
    return btoa(s)
  }
  w.__finish = async () => {
    await encoder!.flush()
    muxer!.finalize()
    output = new Uint8Array(muxer!.target.buffer)
    return output.length
  }
  /** 取第 k 段（每段 3 MB）的 base64 */
  w.__chunk = (k: number) => {
    const part = output!.subarray(k * 3_000_000, (k + 1) * 3_000_000)
    let s = ""
    for (let j = 0; j < part.length; j += 0x8000) s += String.fromCharCode(...part.subarray(j, j + 0x8000))
    return btoa(s)
  }
  /** 把编好的 MP4 用 <video> 解码，取第 sec 秒的画面（检查成品用） */
  w.__probe = async (secs: number[]) => {
    const url = URL.createObjectURL(new Blob([output! as BlobPart], { type: "video/mp4" }))
    const v = document.createElement("video")
    v.muted = true
    v.src = url
    await new Promise<void>((ok, bad) => {
      v.onloadeddata = () => ok()
      v.onerror = () => bad(new Error("浏览器解不开生成的 MP4"))
    })
    const shots: string[] = []
    const c2 = document.createElement("canvas")
    c2.width = canvas.width
    c2.height = canvas.height
    const g2 = c2.getContext("2d")!
    for (const sec of secs) {
      await new Promise<void>((ok) => {
        v.onseeked = () => ok()
        v.currentTime = Math.min(sec, Math.max(0, v.duration - 0.05))
      })
      g2.drawImage(v, 0, 0)
      shots.push(c2.toDataURL("image/png").split(",")[1])
    }
    return { duration: v.duration, width: v.videoWidth, height: v.videoHeight, shots }
  }
}
