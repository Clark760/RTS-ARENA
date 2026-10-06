// 视频页面里跑的代码：画每一帧、用 WebCodecs 编成 H.264、交给 mp4-muxer 封装成 MP4。
// installVideoPage 会被 toString() 后原样注入无头浏览器，所以必须自包含：不能引用这个文件外面的任何东西。
// Node 那边每帧算好要画的东西（场景的固定内容用 __scene 送一次，回放的局面每帧用 __frames 送）

/** 一个场景的固定内容 */
export type SceneData =
  | { kind: "brandOpen"; frames: number; ruleset: string }
  | { kind: "title"; frames: number; ruleset: string; title: string; userText: string | null; theme: string | null; meta: string }
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
  /** 每个座位：兵、工人、建筑、击杀价值 */
  counts: { army: number; workers: number; buildings: number; score: number; alive: boolean }[]
  events: string[]
  progress: number
  /** 最后定格时显示结果 */
  final: boolean
}

export function installVideoPage(): void {
  const W = 1280
  const H = 720
  const FONT = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif'
  const MONO = 'Consolas, "Cascadia Mono", "Microsoft YaHei", monospace'
  const C = { bg1: "#0b1220", bg2: "#14203a", text: "#e8edf7", muted: "#8fa0bf", accent: "#f5b942", line: "#26344f", panel: "rgba(16,26,46,0.92)" }
  const canvas = new OffscreenCanvas(W, H)
  const g = canvas.getContext("2d")!
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
  }

  function title(s: Any, i: number): void {
    background()
    text(`${s.ruleset} · 联赛`, 80, 110, 26, C.accent, { bold: true, alpha: ease(i / 20) })
    text(s.title, 80, 190, 64, C.text, { bold: true, alpha: ease((i - 5) / 20) })
    let y = 270
    if (s.userText) {
      const a = ease((i - 20) / 25)
      g.font = font(38, true)
      const lines = wrap(s.userText, W - 260)
      roundRect(64, y - 10, W - 128, lines.length * 54 + 56, 14, "rgba(245,185,66,0.08)", "rgba(245,185,66,0.35)")
      text("“", 84, y + 62, 90, C.accent, { bold: true, alpha: a })
      lines.forEach((l, k) => text(l, 150, y + 48 + k * 54, 38, C.text, { bold: true, alpha: a }))
      y += lines.length * 54 + 90
    }
    if (s.theme) {
      g.font = font(28)
      wrap(s.theme, W - 180).forEach((l, k) => text(l, 84, y + 30 + k * 40, 28, C.accent, { alpha: ease((i - 50) / 25) }))
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
      const a = ease((i - 24 - k * 16) / 14)
      const ls = wrap(line, 660)
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
      roundRect(900, y + 30, 220, 20, 10, "rgba(255,255,255,0.08)")
      if (bw > 1) roundRect(900, y + 30, bw, 20, 10, r.color)
      g.globalAlpha = 1
      text(`${Math.round(r.rate * 100)}%`, 1140, y + 48, 22, C.text, { bold: true, alpha: a })
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
      const ls = wrap(s.commentary, W - 200)
      ls.forEach((l, k) => text(l, 84, Math.max(y + 30, H - 60 - (ls.length - 1 - k) * 40), 28, C.accent, { bold: true, alpha: ease((i - 30) / 15) }))
    }
    watermark()
  }

  const TILE = 18
  const MX = 24
  const MY = 92
  function replay(s: Any, f: Any, i: number): void {
    g.fillStyle = C.bg1
    g.fillRect(0, 0, W, H)
    // 顶部
    text(`精彩对局 ${s.no}`, 24, 38, 20, C.accent, { bold: true })
    text(s.title, 140, 38, 22, C.text, { bold: true })
    if (s.commentary) {
      g.font = font(18)
      text(wrap(s.commentary, W - 60)[0], 24, 70, 18, C.muted)
    }
    // 地图
    if (!terrainLayer) {
      terrainLayer = new OffscreenCanvas(s.width * TILE, s.height * TILE)
      const t = terrainLayer.getContext("2d")!
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
    g.drawImage(terrainLayer, MX, MY)
    const colorOf = (seat: number) => (seat >= 0 ? (s.seats[seat]?.color ?? "#ccc") : "#9aa0a6")
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
      const r = Math.min(pw, ph) / 2 - (ty.kind === "unit" ? (ty.worker ? 4 : 2.5) : 1.5)
      g.beginPath()
      if (ty.shape === "square") g.roundRect(px + 1.5, py + 1.5, pw - 3, ph - 3, 3)
      else if (ty.shape === "triangle") {
        g.moveTo(cx, py + 2)
        g.lineTo(px + pw - 2, py + ph - 2)
        g.lineTo(px + 2, py + ph - 2)
        g.closePath()
      } else if (ty.shape === "diamond") {
        g.moveTo(cx, py + 1.5)
        g.lineTo(px + pw - 1.5, cy)
        g.lineTo(cx, py + ph - 1.5)
        g.lineTo(px + 1.5, cy)
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
      if (ty.kind === "building" && ty.label) text(ty.label, cx, cy + 9, 24, "rgba(255,255,255,0.9)", { bold: true, align: "center" })
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
      g.arc(MX + (d[k] + 0.5) * TILE, MY + (d[k + 1] + 0.5) * TILE, 6 + age * 2.5, 0, Math.PI * 2)
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
      text(`击杀价值 ${c.score}`, x0 + 32, y + 48, 17, C.muted)
      y += 88
    })
    g.strokeStyle = C.line
    g.beginPath()
    g.moveTo(x0 + 14, y - 14)
    g.lineTo(x0 + pw - 14, y - 14)
    g.stroke()
    text("战况", x0 + 16, y + 12, 17, C.muted, { bold: true })
    y += 40
    g.font = font(16)
    for (const ev of (f.events as string[]).slice(-7)) {
      for (const l of wrap(ev, pw - 32).slice(0, 2)) {
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
    if (f.final) {
      g.globalAlpha = 0.85
      roundRect(MX + 120, MY + 220, s.width * TILE - 240, 120, 16, "#0b1220", C.accent)
      g.globalAlpha = 1
      text(s.result, MX + (s.width * TILE) / 2, MY + 295, 36, C.accent, { bold: true, align: "center" })
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
      for (const l of wrap(s.outro, W - 240)) {
        text(l, W / 2, y, 30, C.accent, { bold: true, align: "center", alpha: p })
        y += 44
      }
      y += 30
    }
    text("RTS Arena", W / 2, y + 70, 80, C.text, { bold: true, align: "center", alpha: p })
    text("本视频由 RTS Arena 联赛视频接口自动生成", W / 2, y + 130, 28, C.text, { align: "center", alpha: ease((i - 10) / 20) })
    text("gitee.com/mingomin/rts-arena", W / 2, y + 172, 24, C.accent, { align: "center", alpha: ease((i - 15) / 20) })
    text("选手", W / 2, y + 226, 18, C.muted, { bold: true, align: "center", alpha: ease((i - 20) / 20) })
    s.credits.forEach((c: string, k: number) => text(c, W / 2, y + 258 + k * 30, 20, k === s.credits.length - 1 ? C.muted : C.text, { align: "center", alpha: ease((i - 25 - k * 5) / 20) }))
  }

  function draw(f: Any | null, i: number): void {
    const s = scene!
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
  }

  // ---------- 和 Node 那边的接口 ----------
  w.__init = (opts: { fps: number; bitrate: number }) => {
    fps = opts.fps
    const Muxer = w.Mp4Muxer
    muxer = new Muxer.Muxer({ target: new Muxer.ArrayBufferTarget(), video: { codec: "avc", width: W, height: H, frameRate: fps }, fastStart: "in-memory" })
    encoder = new VideoEncoder({
      output: (chunk, meta) => muxer!.addVideoChunk(chunk, meta),
      error: (e) => {
        w.__encodeError = String(e)
      },
    })
    encoder.configure({ codec: "avc1.640028", width: W, height: H, bitrate: opts.bitrate, framerate: fps })
    frameNo = 0
    return true
  }
  w.__scene = (s: Any) => {
    scene = s
    terrainLayer = null
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
    c2.width = W
    c2.height = H
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
