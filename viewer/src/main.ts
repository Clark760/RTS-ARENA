// 回放播放器：选回放、播放控制、侧栏（玩家、选中实体、bot 日志）
import type { Replay } from "../../src/core/types.ts"
import { applyFrame, ReplayModel, type State } from "./model.ts"
import { initArena } from "./arena.ts"
import { playerColor, Renderer } from "./render.ts"

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const select = $<HTMLSelectElement>("replay-select")
const slider = $<HTMLInputElement>("slider")
const playBtn = $<HTMLButtonElement>("play")
const speedSel = $<HTMLSelectElement>("speed")

const renderer = new Renderer()
let model: ReplayModel | null = null
let state: State | null = null
/** 带小数的当前 tick（动画用） */
let now = 0
let playing = false
let logFilter: number | null = null
let lastLogDraw = 0

/** 回放文件可能是别人给的，拼进 HTML 的值一律转义 */
function esc(v: unknown): string {
  return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

/** 已经拼好的 HTML，放进 html`` 时不再转义 */
class Raw {
  readonly s: string
  constructor(s: string) {
    this.s = s
  }
}

/** 模板里的 ${} 一律转义；Raw 和 Raw 数组原样放入 */
function html(strings: TemplateStringsArray, ...vals: unknown[]): Raw {
  let out = strings[0]
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i]
    const part = v instanceof Raw ? v.s : Array.isArray(v) ? v.map((x) => (x instanceof Raw ? x.s : esc(x))).join("") : esc(v)
    out += part + strings[i + 1]
  }
  return new Raw(out)
}

function hex(c: number): string {
  return "#" + c.toString(16).padStart(6, "0")
}

// ---------- 加载 ----------

async function refreshList(prefer?: string): Promise<void> {
  let list: { name: string; mtime: number; size: number }[] = []
  try {
    const res = await fetch("/api/replays")
    if (res.ok) list = await res.json()
  } catch {
    // 静态部署时没有列表接口，只能打开本地文件
  }
  select.innerHTML = html`${list.map((r) => html`<option value="${r.name}">${r.name}（${(r.size / 1024).toFixed(0)} KB）</option>`)}`.s
  const want = prefer ?? new URLSearchParams(location.search).get("replay") ?? list[0]?.name
  if (want && list.some((r) => r.name === want)) {
    select.value = want
    await loadByName(want)
  }
}

async function loadByName(name: string): Promise<void> {
  const res = await fetch(`/replays/${encodeURIComponent(name)}`)
  if (!res.ok) return alert(`读取 ${name} 失败：${res.status}`)
  load(await res.json())
  const url = new URL(location.href)
  url.searchParams.set("replay", name)
  history.replaceState(null, "", url)
}

function load(replay: Replay): void {
  try {
    model = new ReplayModel(replay)
  } catch (e) {
    alert((e as Error).message)
    return
  }
  state = model.stateAt(0)
  now = 0
  playing = false
  renderer.selected = null
  renderer.load(replay, state)
  slider.max = String(model.lastTick)
  $("empty").hidden = true
  const r = replay
  $("match-title").textContent = `${r.ruleset.name}（${r.ruleset.id}）· 种子 ${r.seed} · ${r.players.map((p) => p.name).join(" vs ")}`
  drawFilter()
  drawBotStats()
  updateUI(true)
}

// ---------- 播放 ----------

function seek(t: number): void {
  if (!model) return
  state = model.stateAt(t)
  now = state.tick
  renderer.jump(state)
  updateUI(true)
}

function advanceTo(t: number): void {
  if (!model || !state) return
  if (t - state.tick > 300) return seek(t)
  while (state.tick < t) {
    const f = model.frame(state.tick + 1)
    if (!f) break
    renderer.advance(state, applyFrame(state, f))
  }
}

function setPlaying(p: boolean): void {
  if (!model) return
  if (p && state!.tick >= model.lastTick) seek(0)
  playing = p
  playBtn.textContent = p ? "⏸" : "▶"
}

renderer.onSelect = () => updateUI(true)

// ---------- 侧栏 ----------

function updateUI(force = false): void {
  if (!model || !state) return
  const r = model.replay
  slider.value = String(state.tick)
  $("tick-label").textContent = `${state.tick} / ${model.lastTick}`
  $("status-line").textContent = state.status

  const teamed = new Set(r.players.map((p) => p.team)).size < r.players.length
  const rows = r.players.map((p, i) => {
    const ps = state!.players[i]
    const res = Object.entries(ps.resources)
      .map(([k, v]) => `${k} ${v}`)
      .join("，")
    const units = [...state!.ents.values()].filter((e) => e.owner === i && r.types[e.type]?.kind === "unit").length
    // 分队时在名字后面标队伍（老回放没有 team 字段）
    const team = teamed && typeof p.team === "number" ? ` [队${p.team + 1}]` : ""
    return html`<tr><td><span class="swatch" style="background:${hex(playerColor(i))}"></span><span class="${ps.alive ? "" : "out"}">P${i} ${p.name}${team}</span></td>
        <td>分 ${ps.score}</td><td>${res}</td><td>单位 ${units}</td></tr>`
  })
  $("players").innerHTML = html`${rows}`.s

  const sel = renderer.selected
  if (sel === null) $("selected").innerHTML = '<span class="muted">点画面上的实体查看</span>'
  else {
    const e = state.ents.get(sel)
    if (!e) $("selected").innerHTML = html`<span class="muted">#${sel} 已经不在了</span>`.s
    else {
      const info = r.types[e.type]
      const owner = e.owner < 0 ? "中立" : `P${e.owner} ${r.players[e.owner]?.name}`
      const hp = info?.kind === "resource" ? `储量 ${e.hp}` : `${e.hp} / ${info?.maxHp}`
      $("selected").innerHTML = html`<div class="kv"><span class="muted">id</span><span>#${e.id} ${e.type}</span>
        <span class="muted">归属</span><span>${owner}</span><span class="muted">位置</span><span>(${e.x}, ${e.y})</span>
        <span class="muted">生命</span><span>${hp}</span><span class="muted">命令</span><span>${e.ord}</span></div>`.s
    }
  }

  const banner = $("result-banner")
  if (state.tick >= model.lastTick) {
    const res = r.result
    const won = Array.isArray(res.winners) ? res.winners : res.winner === null ? [] : [res.winner]
    const head = won.length === 0 ? `平局——${res.reason}` : `${won.map((w) => `P${w} ${r.players[w]?.name}`).join("、")} 获胜——${res.reason}`
    const ranks =
      r.players.length > 2 && Array.isArray(res.ranking)
        ? "\n名次：" + res.ranking.map((g, i) => `${i + 1}. ${g.map((p) => `P${p} ${r.players[p]?.name}`).join(" = ")}`).join("　")
        : ""
    banner.textContent = head + ranks
    banner.hidden = false
  } else banner.hidden = true

  const t = performance.now()
  if (force || t - lastLogDraw > 120) {
    lastLogDraw = t
    drawLogs()
  }
}

function drawFilter(): void {
  if (!model) return
  const btns = [html`<button data-p="" class="${logFilter === null ? "on" : ""}">全部</button>`]
  model.replay.players.forEach((_, i) => btns.push(html`<button data-p="${i}" class="${logFilter === i ? "on" : ""}">P${i}</button>`))
  $("log-filter").innerHTML = html`${btns}`.s
}

$("log-filter").addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest("button")
  if (!b) return
  logFilter = b.dataset.p === "" ? null : Number(b.dataset.p)
  drawFilter()
  drawLogs()
})

/** 最近 200 tick 的日志和报错 */
function drawLogs(): void {
  if (!model || !state) return
  const lines: Raw[] = []
  const from = Math.max(1, state.tick - 200)
  for (let t = from; t <= state.tick; t++) {
    const f = model.frame(t)
    if (!f) continue
    const cls = t === state.tick ? " now" : ""
    for (const l of f.logs ?? []) {
      if (logFilter !== null && l.p !== logFilter) continue
      for (const text of Array.isArray(l.text) ? l.text : []) lines.push(html`<div class="line${cls}"><span class="t">${t} P${l.p}</span> ${text}</div>`)
    }
    for (const e of f.errs ?? []) {
      if (logFilter !== null && e.p !== logFilter) continue
      const kind = String(e.msg).startsWith("命令被拒") ? "rej" : "err"
      lines.push(html`<div class="line ${kind}${cls}"><span class="t">${t} P${e.p}</span> ${e.msg}</div>`)
    }
  }
  const box = $("logs")
  box.innerHTML = lines.length ? html`${lines.slice(-400)}`.s : '<span class="muted">最近 200 tick 没有日志</span>'
  box.scrollTop = box.scrollHeight
}

function drawBotStats(): void {
  if (!model) return
  const r = model.replay
  const items = r.bots.map((b) => {
    const avg = b.calls ? (b.fuelTotal / b.calls).toFixed(1) : "0"
    const dead = b.status === "dead" ? html`<div class="err">已停止：${b.deadReason ?? ""}</div>` : ""
    return html`<div><b>P${b.player}</b> ${b.bot}<br>调用 ${b.calls}，燃料均值 ${avg} / 最高 ${b.fuelMax}，报错 ${b.errors}，燃料耗尽 ${b.fuelOuts}，被拒 ${b.rejected}，耗时 ${Math.round(Number(b.ms))} ms${dead}</div>`
  })
  $("bot-stats").innerHTML = html`${items}<div class="muted">实体峰值 ${r.perf?.peakEntities}，内核耗时 ${r.perf?.simMs} ms，bot 耗时 ${r.perf?.botMs} ms</div>`.s
}

// ---------- 控件 ----------

playBtn.addEventListener("click", () => setPlaying(!playing))
$("to-start").addEventListener("click", () => {
  setPlaying(false)
  seek(0)
})
$("step-back").addEventListener("click", () => {
  setPlaying(false)
  if (state) seek(state.tick - 1)
})
$("step-fwd").addEventListener("click", () => {
  setPlaying(false)
  if (state) {
    advanceTo(state.tick + 1)
    now = state.tick
    updateUI(true)
  }
})
$("fit").addEventListener("click", () => model && renderer.fit())
slider.addEventListener("input", () => seek(Number(slider.value)))
select.addEventListener("change", () => loadByName(select.value))
$("refresh").addEventListener("click", () => refreshList(select.value || undefined))
$<HTMLInputElement>("file-input").addEventListener("change", async (ev) => {
  const file = (ev.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    load(JSON.parse(await file.text()))
  } catch (e) {
    alert(`读取失败：${(e as Error).message}`)
  }
})
window.addEventListener("keydown", (ev) => {
  if (!model || !state || (ev.target as HTMLElement).tagName === "INPUT") return
  const big = ev.shiftKey ? 50 : 1
  if (ev.key === " ") {
    ev.preventDefault()
    setPlaying(!playing)
  } else if (ev.key === "ArrowRight") {
    setPlaying(false)
    seek(state.tick + big)
  } else if (ev.key === "ArrowLeft") {
    setPlaying(false)
    seek(state.tick - big)
  } else if (ev.key === "Home") {
    setPlaying(false)
    seek(0)
  } else if (ev.key === "End") {
    setPlaying(false)
    seek(model.lastTick)
  }
})

// ---------- 页签 ----------

function showTab(tab: "replay" | "arena"): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>(".tabs button")) b.classList.toggle("on", b.dataset.tab === tab)
  $("replay-page").hidden = tab !== "replay"
  $("replay-footer").hidden = tab !== "replay"
  for (const el of document.querySelectorAll<HTMLElement>(".replay-only")) el.hidden = tab !== "replay"
  $("arena-page").hidden = tab !== "arena"
  if (tab === "replay") {
    setPlaying(false)
    // 画布在隐藏时尺寸是 0，切回来要重新铺满
    requestAnimationFrame(() => model && renderer.fit())
  }
}

document.querySelector(".tabs")!.addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest("button")
  if (b?.dataset.tab === "replay" || b?.dataset.tab === "arena") showTab(b.dataset.tab)
})

initArena({
  openReplay: async (name) => {
    showTab("replay")
    await refreshList(name)
  },
})

// ---------- 主循环 ----------

await renderer.init($("stage"))
renderer.app.ticker.add((tk) => {
  if (model && state && playing) {
    now += (tk.deltaMS / 1000) * model.replay.tickRate * Number(speedSel.value)
    if (now >= model.lastTick) {
      now = model.lastTick
      setPlaying(false)
    }
    const target = Math.floor(now)
    if (target > state.tick) {
      advanceTo(target)
      updateUI()
    }
  }
  renderer.draw(now)
})
await refreshList()
