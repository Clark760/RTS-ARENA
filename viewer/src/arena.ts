// "对战"页：选规则包和每个座位的 bot，在后台跑 N 局（服务端调用命令行 run --json），看进度、汇总和历史
import { playerColor } from "./render.ts"

interface RulesetInfo {
  id: string
  name: string
  players: { min: number; max: number }
  teams: boolean
  bots: string[]
  /** 不是平台自带的、自己写的规则包；id 是 arena.json 里写的路径 */
  external?: boolean
}

/** 服务端找到的 bot 文件 */
interface BotFile {
  path: string
  group: string
  /** 所在 bot 目录用的规则包 id；null 表示哪个规则包都列出 */
  ruleset: string | null
}

interface ArenaInfo {
  rulesets: RulesetInfo[]
  botFiles?: BotFile[]
  /** 这个 bot 目录用的规则包的 id */
  here?: string | null
  /** 加载失败的规则包和原因 */
  broken?: string[]
  workspace: { ruleset: string; bot: string } | null
  localBots: string[]
  running: boolean
}

interface GameEvent {
  type: "game"
  index: number
  seed: number
  seats: number[]
  names: string[]
  teams: number[]
  winners: number[]
  ranking: number[][]
  reason: string
  tick: number
  replay: string
  logs: { seat: number; name: string; file: string }[]
  bots: { seat: number; errors: number; fuelOuts: number; rejected: number; status: string; deadReason?: string }[]
}

interface Summary {
  games: number
  draws: number
  participants: { name: string; wins: number; avgPlace: number }[]
  teams: { members: string[]; wins: number; avgPlace: number }[] | null
}

interface StartEvent {
  type: "start"
  name: string
  games: number
  seed: number
  teams: string | null
  participants: { name: string; file: string }[]
}

interface RunState {
  running: boolean
  exitCode?: number | null
  cancelled?: boolean
  events?: { type: string; message?: string }[]
  stderr?: string
}

interface Series {
  name?: string
  ruleset: { id: string; name: string }
  startedAt: string
  seed: number
  games: number
  teams: string | null
  participants: { name: string; file: string }[]
  results: GameEvent[]
  summary: Summary | null
}

const PATH = "__path__"
const UPLOAD = "__upload__"

/** 每个规则包上次选的阵容记在浏览器里（存不了就算了） */
function savedSeats(ruleset: string): string[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(`rts-arena:seats:${ruleset}`) ?? "null")
    return Array.isArray(v) && v.every((x) => typeof x === "string" && x !== "") ? v : null
  } catch {
    return null
  }
}

function saveSeats(ruleset: string, seats: string[]): void {
  try {
    localStorage.setItem(`rts-arena:seats:${ruleset}`, JSON.stringify(seats))
  } catch {
    // 隐私模式等存不了
  }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

function esc(v: unknown): string {
  return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

function hex(c: number): string {
  return "#" + c.toString(16).padStart(6, "0")
}

/** 把 n 拆成至少两组、每组至少 1 人的有序分法（全是 1 的就是各自为战，不列） */
function compositions(n: number): string[] {
  const out: string[] = []
  const walk = (left: number, parts: number[]) => {
    if (left === 0) {
      if (parts.length >= 2 && parts.some((p) => p > 1)) out.push(parts.join("v"))
      return
    }
    for (let k = 1; k <= left; k++) walk(left - k, [...parts, k])
  }
  walk(n, [])
  // 组数少的在前（2v2、3v1 比 2v1v1 常用），同组数里大队在前
  return out.sort((a, b) => a.split("v").length - b.split("v").length || (a < b ? 1 : -1))
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", "X-Arena": "1", ...(init?.headers ?? {}) } })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `请求失败：${res.status}`)
  return body as T
}

export function initArena(opts: { openReplay: (name: string) => Promise<void> }): void {
  let info: ArenaInfo | null = null
  let seats: string[] = []
  let timer: number | null = null

  const rulesetSel = $<HTMLSelectElement>("ar-ruleset")
  const seatsBox = $("ar-seats")
  const teamsSel = $<HTMLSelectElement>("ar-teams")
  const msg = $("ar-msg")

  const current = () => info?.rulesets.find((r) => r.id === rulesetSel.value)
  /** 这个 bot 目录用的规则包 */
  const here = () => info?.here ?? info?.workspace?.ruleset ?? null

  /** 当前规则包能用的、服务端找到的 bot 文件 */
  const files = (r: RulesetInfo) => (info?.botFiles ?? []).filter((b) => b.ruleset === null || b.ruleset === r.id)

  const defaultBot = (i: number) => {
    const r = current()!
    if (i === 0 && info?.workspace && here() === r.id) return info.workspace.bot
    return r.bots.includes("baseline") ? "baseline" : r.bots[0]
  }

  /** 一个座位的下拉框：找到的 bot 文件（按所在目录分组）、现成 bot、从电脑选文件、手填路径 */
  const seatRow = (i: number, value: string) => {
    const r = current()!
    const found = files(r)
    const isKnown = found.some((b) => b.path === value) || r.bots.includes(value)
    const opt = (v: string, label = v) => `<option value="${esc(v)}"${v === value ? " selected" : ""}>${esc(label)}</option>`
    const groups = [...new Set(found.map((b) => b.group))]
      .map((g) => `<optgroup label="${esc(g)}">${found.filter((b) => b.group === g).map((b) => opt(b.path)).join("")}</optgroup>`)
      .join("")
    return `<div class="seat" data-i="${i}">
      <span class="swatch" style="background:${hex(playerColor(i))}"></span><span class="seat-no">${i + 1}</span>
      <select class="ar-bot">
        ${groups}
        <optgroup label="现成">${r.bots.map((b) => opt(b)).join("")}</optgroup>
        <optgroup label="别的位置">
          <option value="${UPLOAD}">从电脑选文件…</option>
          <option value="${PATH}"${isKnown ? "" : " selected"}>填路径…</option>
        </optgroup>
      </select>
      <input class="ar-path" placeholder="bot 文件路径（相对 bot 目录）" value="${isKnown ? "" : esc(value)}" ${isKnown ? "hidden" : ""} />
    </div>`
  }

  const renderSetup = () => {
    const r = current()
    if (!r) return
    const { min, max } = r.players
    // 上次的阵容里找不到了的 bot（文件删了、换了位置）换回默认的
    if (seats.length === 0)
      seats = (savedSeats(r.id) ?? []).slice(0, max).map((v, i) => (files(r).some((f) => f.path === v) || r.bots.includes(v) ? v : defaultBot(i)))
    while (seats.length < min) seats.push(defaultBot(seats.length))
    if (seats.length > max) seats = seats.slice(0, max)
    seatsBox.innerHTML = seats.map((v, i) => seatRow(i, v)).join("")
    $("ar-players-hint").textContent = min === max ? `${min} 人` : `${min}～${max} 人，现在 ${seats.length} 人`
    $<HTMLButtonElement>("ar-add").disabled = seats.length >= max
    $<HTMLButtonElement>("ar-remove").disabled = seats.length <= min
    $("ar-add").parentElement!.hidden = min === max
    const specs = r.teams ? compositions(seats.length) : []
    const keep = teamsSel.value
    teamsSel.innerHTML = `<option value="">各自为战</option>` + specs.map((s) => `<option value="${s}">${s}（按座位顺序分组）</option>`).join("")
    teamsSel.value = specs.includes(keep) ? keep : ""
    $("ar-teams-row").hidden = specs.length === 0
  }

  // 读回当前下拉框里的选择（选"填路径…"时显示路径输入框，选"从电脑选文件…"时打开选文件窗口）
  const fileInput = $<HTMLInputElement>("ar-file")
  let uploadSeat = -1
  seatsBox.addEventListener("change", (ev) => {
    const row = (ev.target as HTMLElement).closest(".seat") as HTMLElement | null
    if (!row || (ev.target as HTMLElement).tagName !== "SELECT") return
    const i = Number(row.dataset.i)
    const sel = row.querySelector("select")!
    const input = row.querySelector("input")!
    if (sel.value === UPLOAD) {
      uploadSeat = i
      fileInput.value = ""
      fileInput.click()
      renderSetup() // 先把下拉框恢复成原来的选择，选好文件再换
      return
    }
    input.hidden = sel.value !== PATH
    seats[i] = sel.value === PATH ? input.value.trim() : sel.value
  })
  // 浏览器不告诉网页文件在哪，所以把内容传给服务端存一份副本（在回放目录的 uploaded-bots/ 里）
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0]
    if (!file || uploadSeat < 0) return
    msg.textContent = ""
    try {
      const { path } = await api<{ path: string }>("/api/arena/upload", { method: "POST", body: JSON.stringify({ name: file.name, content: await file.text() }) })
      const list = (info!.botFiles ??= [])
      if (!list.some((b) => b.path === path)) list.push({ path, group: "从电脑选的（副本）", ruleset: null })
      seats[uploadSeat] = path
      renderSetup()
      msg.textContent = `已选 ${file.name}（存了一份副本 ${path}；改了原文件要重新选）`
    } catch (e) {
      msg.textContent = (e as Error).message
    }
  })
  seatsBox.addEventListener("input", (ev) => {
    const input = ev.target as HTMLInputElement
    if (!input.classList.contains("ar-path")) return
    seats[Number((input.closest(".seat") as HTMLElement).dataset.i)] = input.value.trim()
  })
  rulesetSel.addEventListener("change", () => {
    seats = []
    renderSetup()
  })
  $("ar-add").addEventListener("click", () => {
    seats.push(defaultBot(seats.length))
    renderSetup()
  })
  $("ar-remove").addEventListener("click", () => {
    seats.pop()
    renderSetup()
  })

  // ---------- 比赛结果 ----------

  const gameRow = (g: GameEvent, teamed: boolean) => {
    const seat = (p: number) =>
      `<span class="who"><span class="swatch" style="background:${hex(playerColor(p))}"></span>P${p} ${esc(g.names[p])}</span>`
    const lineup = teamed
      ? [...new Set(g.teams)].map((t) => `队${t + 1}[${g.seats.map((_, p) => p).filter((p) => g.teams[p] === t).map(seat).join(" ")}]`).join(" 对 ")
      : g.seats.map((_, p) => seat(p)).join(" ")
    const won = g.winners.length ? g.winners.map((p) => esc(g.names[p])).join("、") + " 赢" : "平局"
    const trouble = g.bots
      .filter((b) => b.errors || b.fuelOuts || b.status === "dead")
      .map((b) => `<span class="err">P${b.seat} ${b.status === "dead" ? `停止：${esc(b.deadReason ?? "")}` : `报错 ${b.errors}、燃料耗尽 ${b.fuelOuts}`}</span>`)
      .join(" ")
    const logs = g.logs.map((l) => `<a href="/logs/${encodeURIComponent(l.file)}" target="_blank">P${l.seat}</a>`).join(" ")
    return `<div class="game">
      <div><b>第 ${g.index} 局</b> <span class="muted">种子 ${g.seed}</span> ${lineup}</div>
      <div>→ ${won}（第 ${g.tick} tick，${esc(g.reason)}） ${trouble}
        <button class="link" data-replay="${esc(g.replay)}">看回放</button> <span class="muted">日志</span> ${logs}</div>
    </div>`
  }

  const summaryTable = (s: Summary) => {
    const rows = s.teams
      ? s.teams.map((t, i) => `<tr><td>队${i + 1}（${t.members.map(esc).join("、")}）</td><td>${t.wins}</td><td>${t.avgPlace}</td></tr>`)
      : s.participants.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.wins}</td><td>${p.avgPlace}</td></tr>`)
    return `<table class="summary"><tr><th></th><th>胜</th><th>平均名次</th></tr>${rows.join("")}</table><div class="muted">共 ${s.games} 局，平 ${s.draws}</div>`
  }

  const seriesBody = (s: Series) => {
    const teamed = s.teams !== null
    return s.results.map((g) => gameRow(g, teamed)).join("") + (s.summary ? summaryTable(s.summary) : "")
  }

  const seriesHead = (s: Series) => {
    const when = new Date(s.startedAt).toLocaleString()
    const who = s.participants.map((p) => esc(p.name)).join(s.teams ? "、" : " 对 ")
    const done = s.summary ? "" : `（${s.results.length}/${s.games}）`
    const sum = s.summary
    const brief = !sum
      ? "未完成"
      : sum.teams
        ? sum.teams.map((t) => `队(${t.members.map(esc).join("、")}) 赢 ${t.wins}`).join("，")
        : sum.participants.map((x) => `${esc(x.name)} 赢 ${x.wins}`).join("，")
    return `${esc(when)} · ${esc(s.ruleset.name)}${s.teams ? ` · ${esc(s.teams)}` : ""} · ${who} · ${s.games} 局${done} · ${brief}`
  }

  const loadHistory = async () => {
    try {
      const list = await api<Series[]>("/api/arena/series")
      $("ar-history").innerHTML = list.length
        ? list.map((s) => `<details><summary>${seriesHead(s)}</summary>${seriesBody(s)}</details>`).join("")
        : '<span class="muted">还没有比赛记录</span>'
    } catch (e) {
      $("ar-history").textContent = (e as Error).message
    }
  }

  const renderRun = (r: RunState) => {
    const events = r.events ?? []
    const start = events.find((e) => e.type === "start") as StartEvent | undefined
    const games = events.filter((e) => e.type === "game") as GameEvent[]
    const summary = events.find((e) => e.type === "summary") as Summary | undefined
    const errors = events.filter((e) => e.type === "error").map((e) => String(e.message))
    const warnings = events.filter((e) => e.type === "warning").map((e) => String(e.message))
    $("ar-progress").textContent = r.running ? `进行中 ${games.length}/${start?.games ?? "?"}` : r.cancelled ? "已停止" : summary ? "已完成" : errors.length ? "出错" : ""
    const head = start ? `<div class="muted">${esc(start.name)} · ${start.games} 局 · 种子从 ${start.seed} 起 · ${start.participants.map((p) => esc(p.name)).join("、")}</div>` : ""
    const teamed = start ? start.teams !== null : false
    if (events.length === 0 && !r.running) {
      $("ar-current").innerHTML = '<span class="muted">还没开始</span>'
      return
    }
    $("ar-current").innerHTML =
      head +
      errors.map((m) => `<div class="err">${esc(m)}</div>`).join("") +
      warnings.map((m) => `<div class="warn">提醒：${esc(m)}</div>`).join("") +
      games.map((g) => gameRow(g, teamed)).join("") +
      (summary ? summaryTable(summary) : "") +
      (!r.running && r.exitCode && !errors.length && r.stderr ? `<pre class="err">${esc(r.stderr)}</pre>` : "")
    $<HTMLButtonElement>("ar-start").disabled = r.running
    $<HTMLButtonElement>("ar-stop").disabled = !r.running
  }

  const poll = async () => {
    try {
      const r = await api<RunState>("/api/arena/run")
      renderRun(r)
      if (!r.running && timer !== null) {
        clearInterval(timer)
        timer = null
        loadHistory()
      }
    } catch (e) {
      msg.textContent = (e as Error).message
    }
  }

  $("ar-start").addEventListener("click", async () => {
    msg.textContent = ""
    if (seats.some((s) => !s)) return void (msg.textContent = "有座位还没选 bot（选了“填路径…”就要填上路径）")
    const games = Number($<HTMLInputElement>("ar-games").value)
    const seedText = $<HTMLInputElement>("ar-seed").value.trim()
    saveSeats(rulesetSel.value, seats)
    try {
      await api("/api/arena/run", {
        method: "POST",
        body: JSON.stringify({ ruleset: rulesetSel.value, bots: seats, games, seed: seedText === "" ? null : Number(seedText), teams: teamsSel.value || null }),
      })
      timer ??= window.setInterval(poll, 600)
      poll()
    } catch (e) {
      msg.textContent = (e as Error).message
    }
  })
  $("ar-stop").addEventListener("click", () => api("/api/arena/cancel", { method: "POST" }).catch((e) => (msg.textContent = (e as Error).message)))
  $("ar-history-refresh").addEventListener("click", loadHistory)
  // 看回放：切到回放页并打开
  $("arena-page").addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest("[data-replay]") as HTMLElement | null
    if (b) opts.openReplay(b.dataset.replay!)
  })

  // ---------- 启动 ----------
  ;(async () => {
    try {
      info = await api<ArenaInfo>("/api/arena")
    } catch {
      $("arena-page").innerHTML = '<div class="panel muted">对战页需要用 <code>rts-arena view</code>（或开发时的 <code>npm run viewer</code>）打开</div>'
      return
    }
    rulesetSel.innerHTML = info.rulesets
      .map((r) => `<option value="${esc(r.id)}">${esc(r.name)}（${esc(r.id)}${r.external ? "，自己写的" : ""}）</option>`)
      .join("")
    if (info.broken?.length) $("ar-msg").textContent = `有规则包加载失败：${info.broken.join("；")}`
    const mine = here()
    if (mine && info.rulesets.some((r) => r.id === mine)) rulesetSel.value = mine
    renderSetup()
    loadHistory()
    if (info.running) timer ??= window.setInterval(poll, 600)
    poll()
  })()
}
