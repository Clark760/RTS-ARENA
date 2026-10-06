// 回放播放器：选回放、播放控制、侧栏（玩家、选中实体、bot 日志）
import type { Replay } from "../../src/core/types.ts"
import { applyFrame, ReplayModel, type State } from "./model.ts"
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

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
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
  select.innerHTML = list
    .map((r) => `<option value="${esc(r.name)}">${esc(r.name)}（${(r.size / 1024).toFixed(0)} KB）</option>`)
    .join("")
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

  $("players").innerHTML = r.players
    .map((p, i) => {
      const ps = state!.players[i]
      const res = Object.entries(ps.resources)
        .map(([k, v]) => `${k} ${v}`)
        .join("，")
      const units = [...state!.ents.values()].filter((e) => e.owner === i && r.types[e.type]?.kind === "unit").length
      return `<tr><td><span class="swatch" style="background:${hex(playerColor(i))}"></span><span class="${ps.alive ? "" : "out"}">P${i} ${esc(p.name)}</span></td>
        <td>分 ${ps.score}</td><td>${esc(res)}</td><td>单位 ${units}</td></tr>`
    })
    .join("")

  const sel = renderer.selected
  if (sel === null) $("selected").innerHTML = '<span class="muted">点画面上的实体查看</span>'
  else {
    const e = state.ents.get(sel)
    if (!e) $("selected").innerHTML = `<span class="muted">#${sel} 已经不在了</span>`
    else {
      const info = r.types[e.type]
      const owner = e.owner < 0 ? "中立" : `P${e.owner} ${esc(r.players[e.owner].name)}`
      const hp = info.kind === "resource" ? `储量 ${e.hp}` : `${e.hp} / ${info.maxHp}`
      $("selected").innerHTML = `<div class="kv"><span class="muted">id</span><span>#${e.id} ${esc(e.type)}</span>
        <span class="muted">归属</span><span>${owner}</span><span class="muted">位置</span><span>(${e.x}, ${e.y})</span>
        <span class="muted">生命</span><span>${hp}</span><span class="muted">命令</span><span>${esc(e.ord)}</span></div>`
    }
  }

  const banner = $("result-banner")
  if (state.tick >= model.lastTick) {
    const res = r.result
    banner.textContent = res.winner === null ? `平局——${res.reason}` : `P${res.winner} ${r.players[res.winner].name} 获胜——${res.reason}`
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
  const btns = [`<button data-p="" class="${logFilter === null ? "on" : ""}">全部</button>`]
  model.replay.players.forEach((_, i) => btns.push(`<button data-p="${i}" class="${logFilter === i ? "on" : ""}">P${i}</button>`))
  $("log-filter").innerHTML = btns.join("")
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
  const lines: string[] = []
  const from = Math.max(1, state.tick - 200)
  for (let t = from; t <= state.tick; t++) {
    const f = model.frame(t)
    if (!f) continue
    const cls = t === state.tick ? " now" : ""
    for (const l of f.logs ?? []) {
      if (logFilter !== null && l.p !== logFilter) continue
      for (const text of l.text) lines.push(`<div class="line${cls}"><span class="t">${t} P${l.p}</span> ${esc(text)}</div>`)
    }
    for (const e of f.errs ?? []) {
      if (logFilter !== null && e.p !== logFilter) continue
      const kind = e.msg.startsWith("命令被拒") ? "rej" : "err"
      lines.push(`<div class="line ${kind}${cls}"><span class="t">${t} P${e.p}</span> ${esc(e.msg)}</div>`)
    }
  }
  const box = $("logs")
  box.innerHTML = lines.length ? lines.slice(-400).join("") : '<span class="muted">最近 200 tick 没有日志</span>'
  box.scrollTop = box.scrollHeight
}

function drawBotStats(): void {
  if (!model) return
  const r = model.replay
  $("bot-stats").innerHTML =
    r.bots
      .map((b) => {
        const avg = b.calls ? (b.fuelTotal / b.calls).toFixed(1) : "0"
        const dead = b.status === "dead" ? `<div class="err">已停止：${esc(b.deadReason ?? "")}</div>` : ""
        return `<div><b>P${b.player}</b> ${esc(b.bot)}<br>调用 ${b.calls}，燃料均值 ${avg} / 最高 ${b.fuelMax}，报错 ${b.errors}，燃料耗尽 ${b.fuelOuts}，被拒 ${b.rejected}，耗时 ${b.ms.toFixed(0)} ms${dead}</div>`
      })
      .join("") + `<div class="muted">实体峰值 ${r.perf.peakEntities}，内核耗时 ${r.perf.simMs} ms，bot 耗时 ${r.perf.botMs} ms</div>`
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
