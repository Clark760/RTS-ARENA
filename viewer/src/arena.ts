// "对战"页：选规则包和每个座位的 bot，在后台跑 N 局（服务端调用命令行 run --json），看进度、汇总和历史
import { playerColor } from "./render.ts"

interface RulesetInfo {
  id: string
  name: string
  players: { min: number; max: number }
  teams: boolean
  bots: string[]
  /** 现成 bot 的打法（文件第一行注释） */
  botAbout?: Record<string, string>
  /** 不是平台自带的、自己写的规则包；id 是 arena.json 里写的路径 */
  external?: boolean
}

/** 服务端找到的 bot 文件 */
interface BotFile {
  path: string
  group: string
  /** 所在 bot 目录用的规则包 id；null 表示哪个规则包都列出 */
  ruleset: string | null
  /** 下拉框里显示的名字（上传的副本是它的名字） */
  label?: string
  /** 页面上传的副本（可以改名） */
  uploaded?: boolean
}

const UPLOAD_GROUP = "从电脑选的（副本）"

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
  league?: boolean
  standings?: Standing[]
  matrix?: Standings["matrix"]
  partnersMatrix?: Standings["partners"]
  stats?: LeagueStatsInfo
  participants: { name: string; wins: number; avgPlace: number }[]
  teams: { members: string[]; wins: number; avgPlace: number }[] | null
}

interface Standing {
  index: number
  name: string
  rank: number
  games: number
  wins: number
  draws: number
  losses: number
  avgPlace: number
  points: number
  rate: number
  elo: number
}

/** 联赛排名：table 按名次排，matrix[i][j] 是参赛者 i 对 j 的胜平负 */
interface Standings {
  table: Standing[]
  matrix: { w: number; d: number; l: number }[][]
  /** 分队联赛：partners[i][j] 是 i、j 同队的局数、队伍独得第一的局数 */
  partners?: { games: number; wins: number; points: number }[][] | null
  confidence?: { upper: string; lower: string; w: number; d: number; l: number; los: number | null }[]
}

/** 联赛统计（服务端 league-stats.ts 的 LeagueStatsJson） */
interface LeagueStatsInfo {
  bots: {
    name: string
    games: number
    wins: number
    ticks: number
    winGames: number
    winTicks: number
    income: number
    produced: number
    lostUnits: number
    lostWorkers?: number
    killedUnits: number
    killedBuildings: number
    lostBuildings: number
    errors: number
    fuelOuts: number
    rejected: number
    dead: number
    calls: number
    fuel: number
  }[]
  seats: { games: number; points: number; wins: number; ci?: number }[]
  reasons: { reason: string; n: number; example?: string }[]
}

interface StartEvent {
  type: "start"
  /** 联赛 */
  league?: boolean
  /** 联赛每局几个人、每桌几局、几桌 */
  size?: number
  perTable?: number
  tables?: number
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
  /** "league" 是联赛 */
  kind?: string
  size?: number
  perTable?: number
  partners?: string | null
  stats?: LeagueStatsInfo | null
  /** 联赛打到现在的排名 */
  standings?: Standings | null
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
  const modeSel = $<HTMLSelectElement>("ar-mode")
  const sizeSel = $<HTMLSelectElement>("ar-size")
  const lteamsSel = $<HTMLSelectElement>("ar-lteams")
  const partnersSel = $<HTMLSelectElement>("ar-partners")
  /** 联赛的分队写法（"2v2"），空是各自为战 */
  const leagueTeams = () => (league() && !$("ar-lteams-row").hidden ? lteamsSel.value : "")
  /** 联赛每局几个人 */
  const leagueSize = () => Number(sizeSel.value) || 2
  /** 和服务端一样的分桌：两人局全部两两组合，多人局组合不超过 20 就全打，否则抽桌（每人大约 6 桌） */
  const tableCount = (n: number, k: number): { count: number; sampled: boolean } => {
    let c = 1
    for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1)
    c = Math.round(c)
    return k === 2 || c <= 20 ? { count: c, sampled: false } : { count: Math.ceil((n * 6) / k), sampled: true }
  }
  const league = () => modeSel.value === "league"
  /** 联赛最多几个 bot */
  const LEAGUE_MAX = 16
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
    const opt = (v: string, label = v, title?: string) => `<option value="${esc(v)}"${v === value ? " selected" : ""}${title ? ` title="${esc(title)}"` : ""}>${esc(label)}</option>`
    const groups = [...new Set(found.map((b) => b.group))]
      .map((g) => `<optgroup label="${esc(g)}">${found.filter((b) => b.group === g).map((b) => opt(b.path, b.label ?? b.path)).join("")}</optgroup>`)
      .join("")
    const uploaded = found.some((b) => b.path === value && b.uploaded)
    return `<div class="seat" data-i="${i}">
      <span class="swatch" style="background:${hex(playerColor(i))}"></span><span class="seat-no">${i + 1}</span>
      <select class="ar-bot">
        ${groups}
        <optgroup label="现成">${r.bots.map((b) => opt(b, b, r.botAbout?.[b])).join("")}</optgroup>
        <optgroup label="别的位置">
          <option value="${UPLOAD}">从电脑选文件…</option>
          <option value="${PATH}"${isKnown ? "" : " selected"}>填路径…</option>
        </optgroup>
      </select>
      <button class="ar-pick" title="从电脑上选一个 bot 文件（.ts）">选文件…</button>
      ${uploaded ? '<button class="ar-rename" title="改这个上传的 bot 的名字（比赛结果里显示这个名字）">改名</button><button class="ar-delete" title="删除这个上传的副本（以前的回放不受影响）">删除</button>' : ""}
      <input class="ar-path" placeholder="bot 文件路径（相对 bot 目录）" value="${isKnown ? "" : esc(value)}" ${isKnown ? "hidden" : ""} />
    </div>`
  }

  /** 联赛新加一个 bot：挑一个还没选的 */
  const nextLeagueBot = () => {
    const r = current()!
    const all = [...(info?.workspace && here() === r.id ? [info.workspace.bot] : []), ...files(r).map((f) => f.path), ...r.bots]
    return all.find((b) => !seats.includes(b)) ?? defaultBot(seats.length)
  }

  const renderSetup = () => {
    const r = current()
    if (!r) return
    const lg = league()
    // 联赛：每局人数在规则包允许的范围里选，参赛的 bot 可以比每局人数多（最多 16 个）
    if (lg) {
      const lo = Math.max(2, r.players.min)
      const keep = Number(sizeSel.value)
      const opts = []
      for (let k = lo; k <= r.players.max; k++) opts.push(k)
      sizeSel.innerHTML = opts.map((k) => `<option value="${k}">${k} 人${k === 2 ? "（两两对打）" : ""}</option>`).join("")
      sizeSel.value = String(opts.includes(keep) ? keep : opts[0] ?? 2)
    }
    $("ar-size-row").hidden = !lg
    const k = leagueSize()
    // 分队：这个人数能怎么分队（规则包要支持分队）
    // 联赛里 3v1 和 1v3 是一回事（所有分法都会打），只留从大到小写的
    const teamSpecs = lg && r.teams ? compositions(k).filter((x) => x.split("v").every((n, i, xs) => i === 0 || Number(xs[i - 1]) >= Number(n))) : []
    const keepTeams = lteamsSel.value
    lteamsSel.innerHTML = `<option value="">各自为战</option>` + teamSpecs.map((s) => `<option value="${s}">${s}</option>`).join("")
    lteamsSel.value = teamSpecs.includes(keepTeams) ? keepTeams : ""
    $("ar-lteams-row").hidden = teamSpecs.length === 0
    const tspec = leagueTeams()
    $("ar-partners-row").hidden = !tspec
    const sides = tspec ? tspec.split("v").length : k
    const sameBot = tspec !== "" && partnersSel.value === "same"
    const min = lg ? (sameBot ? sides : k) : r.players.min
    const max = lg ? LEAGUE_MAX : r.players.max
    // 上次的阵容里找不到了的 bot（文件删了、换了位置）换回默认的
    if (seats.length === 0)
      seats = (savedSeats(`${modeSel.value}:${r.id}`) ?? savedSeats(r.id) ?? []).slice(0, max).map((v, i) => (files(r).some((f) => f.path === v) || r.bots.includes(v) ? v : defaultBot(i)))
    while (seats.length < min) seats.push(lg ? nextLeagueBot() : defaultBot(seats.length))
    if (seats.length > max) seats = seats.slice(0, max)
    seatsBox.innerHTML = seats.map((v, i) => seatRow(i, v)).join("")
    const leagueOk = r.players.max >= 2
    const { count: tables, sampled } = tableCount(seats.length, sameBot ? sides : k)
    $("ar-players-hint").textContent = lg
      ? leagueOk
        ? tspec
          ? `联赛：${seats.length} 个 bot，分队 ${tspec}，${sameBot ? "每队都是同一个 bot" : "轮换搭档"}，共 ${tables} 桌${sampled ? "（组合太多，抽了一部分）" : ""}（最多 ${LEAGUE_MAX} 个 bot）`
          : k === 2
          ? `联赛：${seats.length} 个 bot 两两对打，共 ${tables} 对（最多 ${LEAGUE_MAX} 个 bot）`
          : `联赛：${seats.length} 个 bot，每局 ${k} 人，共 ${tables} 桌${sampled ? "（组合太多，抽了一部分）" : ""}（最多 ${LEAGUE_MAX} 个 bot）`
        : `「${r.name}」没法开联赛`
      : min === max
        ? `${min} 人`
        : `${min}～${max} 人，现在 ${seats.length} 人`
    $<HTMLButtonElement>("ar-add").disabled = seats.length >= max
    $<HTMLButtonElement>("ar-remove").disabled = seats.length <= min
    $("ar-add").parentElement!.hidden = min === max
    $("ar-games-label").textContent = lg ? (k === 2 && !tspec ? "每对局数" : "每桌局数") : "局数"
    $<HTMLInputElement>("ar-games").placeholder = lg ? "留空 = 一轮" : ""
    $("ar-note").textContent = lg
      ? tspec
        ? sameBot
          ? "每队由同一个 bot 的几份副本组成，各队轮换位置；排名按队伍的名次算。每桌局数留空是一轮（每个位置各一次）。"
          : "每桌挑够人数的 bot，所有分组方式都打、各队轮换位置；每个 bot 拿所在队的名次分，等级分只和不同队的人比。每桌局数留空是一轮。另外出搭档表：两个 bot 同队时的战绩。"
        : k === 2
        ? "每一对用同一个种子换边打，每对局数最好是双数。排名：胜 1 分、平 0.5 分；等级分（1500 起）按全部对局一起算。"
        : `每一桌用同一个种子轮换座位，每桌局数最好是 ${k} 的倍数。名次分：第一名 1 分、最后一名 0 分、中间平分；等级分（1500 起）把名次拆成两两比较，按全部对局一起算。`
      : "同一个种子会把各方的位置轮换一遍（两人就是换边各打一次）。回放和每个 bot 的日志写在回放目录里。"
    $<HTMLButtonElement>("ar-start").disabled = lg && !leagueOk
    const specs = !lg && r.teams ? compositions(seats.length) : []
    const keep = teamsSel.value
    teamsSel.innerHTML = `<option value="">各自为战</option>` + specs.map((s) => `<option value="${s}">${s}（按座位顺序分组）</option>`).join("")
    teamsSel.value = specs.includes(keep) ? keep : ""
    $("ar-teams-row").hidden = specs.length === 0
  }

  // 读回当前下拉框里的选择（选"填路径…"时显示路径输入框，选"从电脑选文件…"时打开选文件窗口）
  const fileInput = $<HTMLInputElement>("ar-file")
  let uploadSeat = -1
  // 每个座位旁边的"选文件…"按钮
  seatsBox.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement
    const row = target.closest(".seat") as HTMLElement | null
    if (!row) return
    const i = Number(row.dataset.i)
    if (target.closest(".ar-pick")) {
      uploadSeat = i
      fileInput.value = ""
      fileInput.click()
    } else if (target.closest(".ar-rename")) {
      const b = info?.botFiles?.find((f) => f.path === seats[i])
      if (b) startNaming({ mode: "rename", seat: i, from: b.path }, b.label ?? "")
    } else if (target.closest(".ar-delete")) {
      const b = info?.botFiles?.find((f) => f.path === seats[i])
      if (b) startDelete(b)
    }
  })

  // ---------- 给上传的 bot 起名、改名 ----------
  // 名字就是比赛结果、排行榜里显示的名字，起个能认出是谁写的
  type Naming = { mode: "upload"; seat: number; fileName: string; content: string } | { mode: "rename"; seat: number; from: string }
  let naming: Naming | null = null
  const namingBox = $("ar-naming")
  const startNaming = (n: Naming, value: string) => {
    naming = n
    const title =
      n.mode === "upload"
        ? `给 ${n.fileName} 起个名字：比赛结果和排行榜里显示这个名字，方便认出是谁写的（比如作者的名字）`
        : "改名：比赛结果和排行榜里显示新名字（以前的回放里还是旧名字）"
    namingBox.innerHTML = `<div class="small">${esc(title)}</div>
      <div class="row"><input id="ar-name-input" maxlength="40" placeholder="字母、汉字、数字、_、-" value="${esc(value)}" />
      <button id="ar-name-ok" class="primary">保存</button><button id="ar-name-cancel">取消</button></div>
      <div id="ar-name-msg" class="err small"></div><div id="ar-name-choice" class="row" hidden></div>`
    namingBox.hidden = false
    const input = $<HTMLInputElement>("ar-name-input")
    input.focus()
    input.select()
  }
  /** 删除上传的副本：先在页面上确认 */
  const startDelete = (b: BotFile) => {
    naming = null
    const users = seats.filter((x) => x === b.path).length
    namingBox.innerHTML = `<div class="small">删除上传的 bot「${esc(b.label ?? b.path)}」？只删回放目录里的这份副本，以前的回放和日志不受影响${users > 1 ? `；现在有 ${users} 个座位用着它，会换回默认的 bot` : ""}。</div>
      <div class="row"><button id="ar-del-ok" class="primary" data-path="${esc(b.path)}">删除</button><button id="ar-name-cancel">取消</button></div>
      <div id="ar-name-msg" class="err small"></div>`
    namingBox.hidden = false
  }
  const doDelete = async (path: string) => {
    const r = await post("/api/arena/upload/delete", { path })
    if (!r.ok) return void ($("ar-name-msg").textContent = r.body.error ?? `删除失败：${r.status}`)
    const label = info?.botFiles?.find((b) => b.path === path)?.label ?? path
    if (info?.botFiles) info.botFiles = info.botFiles.filter((b) => b.path !== path)
    seats = seats.map((x, i) => (x === path ? defaultBot(i) : x))
    stopNaming()
    renderSetup()
    msg.textContent = `已删除 ${label}`
    msg.classList.add("ok")
  }

  const stopNaming = () => {
    naming = null
    namingBox.hidden = true
    namingBox.innerHTML = ""
  }
  /** 上传或改名成功：更新列表和用到它的座位 */
  const named = (oldPath: string | null, path: string, name: string, seat: number) => {
    const list = (info!.botFiles ??= [])
    const old = oldPath ? list.find((b) => b.path === oldPath) : undefined
    if (old) {
      old.path = path
      old.label = name
    } else if (!list.some((b) => b.path === path)) list.push({ path, group: UPLOAD_GROUP, ruleset: null, label: name, uploaded: true })
    else list.find((b) => b.path === path)!.label = name
    if (oldPath) seats = seats.map((x) => (x === oldPath ? path : x))
    seats[seat] = path
    stopNaming()
    renderSetup()
  }
  const post = (url: string, body: unknown) =>
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Arena": "1" }, body: JSON.stringify(body) }).then(async (res) => ({
      ok: res.ok,
      status: res.status,
      body: (await res.json().catch(() => ({}))) as { error?: string; path?: string; name?: string; exists?: boolean },
    }))
  const saveName = async (overwrite = false) => {
    const n = naming
    if (!n) return
    const name = $<HTMLInputElement>("ar-name-input").value.trim()
    const say = (t: string) => ($("ar-name-msg").textContent = t)
    say("")
    $("ar-name-choice").hidden = true
    if (n.mode === "upload") {
      const r = await post("/api/arena/upload", { name, content: n.content, overwrite })
      if (r.status === 409 && r.body.exists) {
        // 同名、内容不一样：替换（同一个作者更新了 bot），还是换个名字
        say(`${r.body.error}。`)
        const choice = $("ar-name-choice")
        choice.innerHTML = '<button id="ar-name-replace">替换成新上传的这个</button><button id="ar-name-other">换个名字</button>'
        choice.hidden = false
        return
      }
      if (!r.ok) return say(r.body.error ?? `上传失败：${r.status}`)
      named(null, r.body.path!, r.body.name!, n.seat)
      msg.textContent = `已选 ${name}（${n.fileName} 的副本存成 ${r.body.path}；改了原文件要重新选）`
      msg.classList.add("ok")
    } else {
      const r = await post("/api/arena/upload/rename", { from: n.from, name })
      if (!r.ok) return say(r.body.error ?? `改名失败：${r.status}`)
      named(n.from, r.body.path!, r.body.name!, n.seat)
      msg.textContent = `已改名为 ${r.body.name}`
      msg.classList.add("ok")
    }
  }
  namingBox.addEventListener("click", (ev) => {
    const id = (ev.target as HTMLElement).id
    if (id === "ar-name-ok") void saveName()
    else if (id === "ar-name-cancel") stopNaming()
    else if (id === "ar-del-ok") void doDelete((ev.target as HTMLElement).dataset.path!)
    else if (id === "ar-name-replace") void saveName(true)
    else if (id === "ar-name-other") {
      $("ar-name-choice").hidden = true
      $("ar-name-msg").textContent = ""
      $<HTMLInputElement>("ar-name-input").select()
    }
  })
  namingBox.addEventListener("keydown", (ev) => {
    if ((ev.target as HTMLElement).id !== "ar-name-input") return
    if (ev.key === "Enter") void saveName()
    else if (ev.key === "Escape") stopNaming()
  })
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
    msg.classList.remove("ok")
    if (!file.name.endsWith(".ts") || file.name.endsWith(".d.ts")) return void (msg.textContent = "要选 bot 的 .ts 文件")
    // 先起名再上传；默认用文件名（叫 bot.ts 的看不出是谁的，留空让人填）
    const stem = file.name.replace(/\.ts$/, "")
    startNaming({ mode: "upload", seat: uploadSeat, fileName: file.name, content: await file.text() }, stem === "bot" ? "" : stem)
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
  modeSel.addEventListener("change", () => {
    seats = []
    $<HTMLInputElement>("ar-games").value = league() ? "2" : "10"
    renderSetup()
    if (league()) $<HTMLInputElement>("ar-games").value = String(leagueSize())
  })
  lteamsSel.addEventListener("change", () => {
    $<HTMLInputElement>("ar-games").value = ""
    renderSetup()
  })
  partnersSel.addEventListener("change", () => renderSetup())
  sizeSel.addEventListener("change", () => {
    // 每桌局数默认等于每局人数：座位正好轮换一圈
    $<HTMLInputElement>("ar-games").value = String(leagueSize())
    renderSetup()
  })
  $("ar-add").addEventListener("click", () => {
    seats.push(league() ? nextLeagueBot() : defaultBot(seats.length))
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

  /** 联赛排行榜和对阵表；multi 是多人局（多一列平均名次，对阵表的说明不一样） */
  const standingsHtml = (st: Standings, multi = false) => {
    const rows = st.table.map(
      (s) =>
        `<tr><td>${s.rank}</td><td>${esc(s.name)}</td><td>${s.games}</td><td>${s.wins}</td><td>${s.draws}</td><td>${s.losses}</td>${multi ? `<td>${s.avgPlace}</td>` : ""}<td>${Math.round(s.rate * 100)}%</td><td>${s.elo}</td></tr>`,
    )
    const order = st.table.map((s) => s.index)
    const nameOf = (i: number) => st.table.find((s) => s.index === i)!.name
    const head = order.map((j) => `<th>${esc(nameOf(j))}</th>`).join("")
    const body = order
      .map((i) => {
        const cells = order.map((j) => {
          if (i === j) return "<td class=\"muted\">—</td>"
          const c = st.matrix[i][j]
          return c.w + c.d + c.l === 0 ? "<td></td>" : `<td class="${c.w > c.l ? "win" : c.w < c.l ? "lose" : ""}">${c.w}-${c.d}-${c.l}</td>`
        })
        return `<tr><th>${esc(nameOf(i))}</th>${cells.join("")}</tr>`
      })
      .join("")
    return `<div class="table-scroll"><table class="summary standings"><tr><th title="名次">#</th><th>bot</th><th title="局数">局</th><th>胜</th><th>平</th><th>负</th>${multi ? '<th title="平均名次">均名次</th>' : ""}<th title="得分率">得分</th><th title="等级分（1500 起）">等级</th></tr>${rows.join("")}</table>
      ${st.partners ? '<div class="muted small">分队：胜 = 所在的队独得第一；名次、得分率都按队伍的名次算，队里每个人拿队伍的分</div>' : multi ? '<div class="muted small">胜 = 独得第一，平 = 并列第一；得分率按名次分算：第一名 1 分、最后一名 0 分、中间平分</div>' : ""}
      <div class="muted small">对阵：${st.partners ? "不同队时，行所在的队排在列所在的队前面-并列-后面的次数" : multi ? "同一局里行排在列前面-并列-排在后面的次数" : "行对列的 胜-平-负"}</div><table class="summary matrix"><tr><th></th>${head}</tr>${body}</table></div>`
  }

  /** 分队联赛的搭档表：行和列同队时的局数 / 队伍独得第一的局数 */
  const partnersHtml = (st: Standings) => {
    const p = st.partners
    if (!p) return ""
    const order = st.table.map((s) => s.index)
    const nameOf = (i: number) => st.table.find((s) => s.index === i)!.name
    const body = order
      .map((i) => `<tr><th>${esc(nameOf(i))}</th>${order.map((j) => (i === j ? '<td class="muted">—</td>' : p[i][j].games === 0 ? "<td></td>" : `<td class="${p[i][j].wins * 2 > p[i][j].games ? "win" : p[i][j].wins * 2 < p[i][j].games ? "lose" : ""}">${p[i][j].games}/${p[i][j].wins}</td>`)).join("")}</tr>`)
      .join("")
    return `<div class="muted small">搭档：行和列同队时的 局数/队伍独得第一的局数</div><div class="table-scroll"><table class="summary matrix"><tr><th></th>${order.map((j) => `<th>${esc(nameOf(j))}</th>`).join("")}</tr>${body}</table></div>`
  }

  /** 联赛统计：把握度、每个 bot 每局平均、座位、结束原因 */
  const statsHtml = (stats: LeagueStatsInfo | null | undefined, st: Standings) => {
    if (!stats) return ""
    const avg = (x: number, n: number, d = 0) => (n ? (x / n).toFixed(d) : "—")
    const conf = (st.confidence ?? [])
      .map((c) => `<li>${esc(c.upper)} &gt; ${esc(c.lower)}：${c.w}-${c.d}-${c.l}，${c.los === null ? "没分出过先后" : `把握 ${(c.los * 100).toFixed(c.los > 0.99 ? 1 : 0)}%`}</li>`)
      .join("")
    const rows = st.table
      .map((s) => stats.bots[s.index])
      .map(
        (b) =>
          `<tr><td>${esc(b.name)}</td><td>${avg(b.ticks, b.games)}</td><td>${avg(b.winTicks, b.winGames)}</td><td>${avg(b.income, b.games)}</td><td>${avg(b.produced, b.games, 1)}</td><td>${avg(b.lostUnits, b.games, 1)}${b.lostWorkers !== undefined ? `（${avg(b.lostWorkers, b.games, 1)}）` : ""}</td><td>${avg(b.killedUnits, b.games, 1)}</td><td>${avg(b.killedBuildings, b.games, 1)}</td><td>${avg(b.fuel, b.calls, 1)}</td><td class="${b.errors + b.fuelOuts + b.dead ? "err" : ""}">${b.errors}/${b.fuelOuts}/${b.rejected}/${b.dead}</td></tr>`,
      )
      .join("")
    const seats = stats.seats.map((s, p) => `P${p} ${avg(s.points * 100, s.games)}%${s.ci !== undefined ? ` ±${Math.round(s.ci * 100)}%` : ""}`).join("，")
    const reasons = stats.reasons
      .slice(0, 6)
      .map((r) => `<li>×${r.n} ${esc(r.example ?? r.reason)}${r.n > 1 && r.example && r.example !== r.reason ? " 等" : ""}</li>`)
      .join("")
    return `<details open><summary>统计</summary>
      <div class="muted small">把握度：相邻名次直接对阵时，上面的比下面的强的把握（平局不算，局数少时不可靠）</div><ul class="stat-list">${conf}</ul>
      <div class="muted small">每个 bot 每局平均（时长是 tick，采集是估算，击杀是最后一击；最后一列是整个联赛的 报错/燃料耗尽/被拒/停止）</div>
      <div class="table-scroll"><table class="summary standings"><tr><th>bot</th><th>时长</th><th>胜局时长</th><th>采集</th><th>造单位</th><th title="损失的单位（括号里是其中的工人）">损失（工人）</th><th>击杀</th><th>拆建筑</th><th>燃料</th><th>出错</th></tr>${rows}</table></div>
      <div class="muted small">座位的得分率和 95% 区间（看地图偏不偏；区间都盖住 50% 就还看不出偏）：${seats}</div>
      <div class="muted small">结束原因（数字不一样的算一类，这里是其中一局的原话）</div><ul class="stat-list">${reasons}</ul>
    </details>`
  }

  /** 联赛的对局多：折叠起来 */
  const leagueGames = (games: GameEvent[], open = false, teamed = false) =>
    games.length ? `<details${open ? " open" : ""}><summary>每一局（${games.length}）</summary>${games.map((g) => gameRow(g, teamed)).join("")}</details>` : ""

  const seriesBody = (s: Series) => {
    if (s.kind === "league") {
      const st = s.summary?.standings && s.summary.matrix ? { table: s.summary.standings, matrix: s.summary.matrix } : s.standings
      const full = st && (s.summary?.partnersMatrix || s.standings?.partners) ? { ...st, partners: s.summary?.partnersMatrix ?? s.standings?.partners, confidence: s.standings?.confidence } : st && { ...st, confidence: s.standings?.confidence }
      const multi = (s.size ?? 2) > 2 || s.partners === "mixed"
      return (full ? standingsHtml(full, multi) + partnersHtml(full) + statsHtml(s.summary?.stats ?? s.stats, full) : "") + leagueGames(s.results, false, !!s.teams)
    }
    const teamed = s.teams !== null
    return s.results.map((g) => gameRow(g, teamed)).join("") + (s.summary ? summaryTable(s.summary) : "")
  }

  const seriesHead = (s: Series) => {
    const when = new Date(s.startedAt).toLocaleString()
    const who = s.participants.map((p) => esc(p.name)).join(s.teams ? "、" : " 对 ")
    const done = s.summary ? "" : `（${s.results.length}/${s.games}）`
    const sum = s.summary
    if (s.kind === "league") {
      const top = (sum?.standings ?? s.standings?.table)?.[0]
      return `${esc(when)} · 联赛 · ${esc(s.ruleset.name)} · ${s.participants.length} 个 bot${(s.size ?? 2) > 2 ? ` · 每局 ${s.size} 人` : ""}${s.teams ? ` · 分队 ${esc(s.teams)}（${s.partners === "same" ? "同一个 bot 组队" : "轮换搭档"}）` : ""} · ${s.games} 局${done}${top ? ` · 第一名 ${esc(top.name)}（${Math.round(top.rate * 100)}%，等级分 ${top.elo}）` : ""}`
    }
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
    const head = start
      ? start.league
        ? `<div class="muted">联赛 · ${esc(start.name)} · ${start.participants.length} 个 bot · ${(start.size ?? 2) > 2 ? `每局 ${start.size} 人 · ${start.tables} 桌 · 每桌 ${start.perTable} 局` : `每对 ${start.perTable} 局`} · 共 ${start.games} 局 · 种子从 ${start.seed} 起</div>`
        : `<div class="muted">${esc(start.name)} · ${start.games} 局 · 种子从 ${start.seed} 起 · ${start.participants.map((p) => esc(p.name)).join("、")}</div>`
      : ""
    // 联赛：最新的排名放最上面，每一局折叠
    const standings = [...events].reverse().find((e) => e.type === "standings") as (Standings & { type: string; stats?: LeagueStatsInfo }) | undefined
    const lmulti = start ? (start.size ?? 2) > 2 || (start as { partners?: string }).partners === "mixed" : false
    const teamed = start ? start.teams !== null : false
    if (events.length === 0 && !r.running) {
      $("ar-current").innerHTML = '<span class="muted">还没开始</span>'
      return
    }
    $("ar-current").innerHTML =
      head +
      errors.map((m) => `<div class="err">${esc(m)}</div>`).join("") +
      warnings.map((m) => `<div class="warn">提醒：${esc(m)}</div>`).join("") +
      (start?.league ? (standings ? standingsHtml(standings, lmulti) + partnersHtml(standings) + statsHtml(standings.stats, standings) : "") + leagueGames(games, r.running, teamed) : games.map((g) => gameRow(g, teamed)).join("") + (summary ? summaryTable(summary) : "")) +
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
    msg.classList.remove("ok")
    if (seats.some((s) => !s)) return void (msg.textContent = "有座位还没选 bot（选了“填路径…”就要填上路径）")
    const games = Number($<HTMLInputElement>("ar-games").value)
    const seedText = $<HTMLInputElement>("ar-seed").value.trim()
    saveSeats(`${modeSel.value}:${rulesetSel.value}`, seats)
    const seed = seedText === "" ? null : Number(seedText)
    try {
      await api("/api/arena/run", {
        method: "POST",
        body: JSON.stringify(
          league()
            ? {
                mode: "league",
                ruleset: rulesetSel.value,
                bots: seats,
                size: leagueSize(),
                teams: leagueTeams() || null,
                partners: leagueTeams() ? partnersSel.value : null,
                perTable: $<HTMLInputElement>("ar-games").value.trim() === "" ? null : games,
                seed,
              }
            : { ruleset: rulesetSel.value, bots: seats, games, seed, teams: teamsSel.value || null },
        ),
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
