// 内核的数据结构：规则包接口、实体状态、回放格式、bot 运行器接口
import type { GameEvent, Order, TypeDef } from "../api/bot-api.ts"

// ---------- 规则包 ----------

export type Shape = "circle" | "square" | "triangle" | "diamond" | "hex"

/** 回放里怎么画这类实体 */
export interface Look {
  shape: Shape
  /** 图形上写的一个字（可选） */
  label?: string
  /** 中文名（可选，最多 6 个字）：联赛视频的单位图例、战况里用它；不写时常见类型（工人、兵营……）用平台的中文名，其余显示类型名 */
  name?: string
  /** 固定颜色；不填按所属玩家上色（中立为灰色） */
  color?: string
}

/**
 * 局中能改的数值（setTypeStats / setStats，D-153）：都是"改成多少"（不是加减），只写要改的项。
 * 原来不能攻击、不能采集、不能移动、没有生命（无敌）的类型不能改出这些能力
 */
export interface StatPatch {
  /** 生命上限（变大时当前生命跟着加上差值，变小时超出的去掉） */
  maxHp?: number
  /** 走一格几 tick（≥ 1） */
  moveTicks?: number
  /** 视野半径 */
  sight?: number
  attack?: { damage?: number; range?: number; cooldown?: number }
  gather?: { amount?: number; ticks?: number; capacity?: number }
}

/** 规则包里定义实体类型：除 kind 和 look 外都有默认值 */
export interface TypeSpec {
  kind: TypeDef["kind"]
  /** 默认 1 */
  w?: number
  /** 默认 1 */
  h?: number
  /** 默认 0（不能被攻击） */
  maxHp?: number
  cost?: Record<string, number>
  buildTicks?: number
  moveTicks?: number
  sight?: number
  attack?: TypeDef["attack"]
  gather?: TypeDef["gather"]
  dropOff?: boolean
  produces?: string[]
  /** 能建造的建筑类型（只对单位有意义）；建筑的 buildTicks 就是建造工作量 */
  builds?: string[]
  resource?: string | null
  /** 资源点默认储量（spawn 时可以另给） */
  amount?: number
  look: Look
}

export interface TerrainSpec {
  walkable: boolean
  /** 回放里的颜色，如 "#3a5a40" */
  color: string
}

/** winner 为 null 表示平局 */
export interface MatchResult {
  winner: number | null
  /** 获胜的所有玩家（队伍模式下是整个获胜队伍，含已出局的队友）；不填就是 [winner] */
  winners?: number[]
  reason: string
  /**
   * 名次（多人局用）：ranking[i] 是第 i+1 名的玩家编号们，同一名次可以有多人。
   * 不填时按 winner 推：赢家第 1，其余并列第 2；平局全部并列第 1。
   */
  ranking?: number[][]
  /**
   * 可选：规则包自己的统计，每项是按玩家编号排的数组，比如 { 劫到商队: [3, 5], 被抢走: [1, 0] }。
   * 联赛按 bot 累计、显示每局平均，战报也会列出来；用来检查自己设计的机制到底有没有发生。最多 12 项，名字最长 20 字
   */
  stats?: Record<string, number[]>
}

/** 回放里的叠加层（区域、文字），由规则包每 tick 设置 */
export type Marker =
  /** color 不写就按 owner 上色（null 为灰色） */
  | { kind: "zone"; x: number; y: number; w: number; h: number; owner: number | null; label?: string; color?: string }
  | { kind: "label"; x: number; y: number; text: string; owner?: number | null }

/** ctx.orderNeutral 能下的命令 */
export type NeutralOrder =
  | { kind: "move"; x: number; y: number }
  | { kind: "attack"; target: number }
  | { kind: "attackMove"; x: number; y: number }
  | { kind: "stop" }

/** ctx.entities 的筛选条件，不写的项不限 */
export interface EntityFilter {
  owner?: number
  type?: string
  kind?: TypeDef["kind"]
}

/** 规则包发给自己的事件（本 tick 内发生的） */
export type RuleEvent =
  /** killer 是最后一击的玩家，-1 表示没有（如资源采完、规则移除、拆掉自己的地基）；unfinished 表示死的是没建好的建筑 */
  /**
   * removed 为 true 表示是规则包用 remove 移除的（不是打死的），killer 是 -1；
   * byNeutral 为 true 表示最后一击是中立实体（killer 也是 -1，用它和"没有凶手"区分）
   */
  | { kind: "died"; id: number; type: string; owner: number; x: number; y: number; killer: number; unfinished?: true; removed?: true; byNeutral?: true }
  | { kind: "created"; id: number; type: string; owner: number }
  | { kind: "deposit"; player: number; resource: string; amount: number; by: number }
  /** 工人建造的建筑建好了（放下地基时是 created） */
  | { kind: "built"; id: number; type: string; owner: number }

/** setup 阶段能用的接口 */
export interface SetupContext {
  readonly seed: number
  readonly playerCount: number
  /** 每个玩家的队伍编号；不分队时每人一队（编号就是玩家编号） */
  readonly teams: readonly number[]
  readonly rng: Rng
  /** 设置地形，每行一个字符串，字符必须在规则包的 terrain 里 */
  setTerrain(rows: string[]): void
  /** 放一个实体；位置被占或越界会抛错。amount 是资源点储量 */
  spawn(type: string, owner: number, x: number, y: number, opts?: { amount?: number }): number
  setResources(player: number, resources: Record<string, number>): void
  /** 开局的叠加层和状态文字 */
  setMarkers(markers: Marker[]): void
  setStatus(text: string): void
  /** 读局面（setup 里也能用，看到的是到目前为止放下的实体）：按创建顺序，可以按 owner、type、kind 筛选 */
  entities(filter?: EntityFilter): readonly RuleEntity[]
  get(id: number): RuleEntity | undefined
  /** 和矩形区域重叠的实体 */
  entitiesIn(x: number, y: number, w: number, h: number): RuleEntity[]
  /** 两个占地矩形之间的曼哈顿距离（贴着 = 1） */
  dist(a: Rect, b: Rect): number
  /** 两个玩家是否同队 */
  isAlly(a: number, b: number): boolean
  /**
   * 在 (x, y) 附近找空位放实体（setup 里也能用，比自己记占用的格子省事）。(x, y) 放得下就放在那里，否则往外找：(x, y) 落在建筑或资源点里时从它的外圈开始找；单位按走路的步数往外找（不穿墙，最多 8 步），
   * 建筑按距离一圈一圈找（最多 8 圈）。找不到返回 null；
   * setup 里返回 null 时 rts-arena check 会提醒
   */
  spawnNear(type: string, owner: number, x: number, y: number, opts?: { amount?: number }): number | null
  /** 移除实体（setup 里也能用，比如摆好之后又不要了） */
  remove(id: number): void
  /** 地形，每行一个字符串（setTerrain 之后才有）；每格是什么看 Ruleset.terrain */
  readonly terrain: readonly string[]
}

/** 每 tick 规则包能用的接口（规则包是可信代码，拿到的是内部状态，别直接改字段，用下面的方法） */
export interface RuleContext {
  readonly tick: number
  readonly maxTicks: number
  readonly playerCount: number
  /** 每个玩家的队伍编号；不分队时每人一队 */
  readonly teams: readonly number[]
  /** 两个玩家是否同队（自己和自己也算）；中立 -1 不和任何人同队 */
  isAlly(a: number, b: number): boolean
  readonly width: number
  readonly height: number
  /** 地形，每行一个字符串，terrain[y][x] 是 (x, y) 的地形字符；能不能走看 Ruleset.terrain */
  readonly terrain: readonly string[]
  readonly rng: Rng
  /**
   * 实体，按创建顺序。可以按 owner、type、kind 筛选：规则包在沙箱里跑，筛选在沙箱外面做，
   * 只把筛出来的传进去，比取全部实体再自己筛快得多（比如每 tick 找主基地写 entities({ owner: p, type: "base" })）
   */
  entities(filter?: EntityFilter): readonly RuleEntity[]
  get(id: number): RuleEntity | undefined
  readonly players: readonly RulePlayer[]
  /** 本 tick 发生的事 */
  readonly events: readonly RuleEvent[]
  /** 两个占地矩形之间的曼哈顿距离（贴着 = 1） */
  dist(a: Rect, b: Rect): number
  /** 和矩形区域重叠的实体 */
  entitiesIn(x: number, y: number, w: number, h: number): RuleEntity[]
  addScore(player: number, n: number): void
  setScore(player: number, n: number): void
  addResource(player: number, resource: string, n: number): void
  /** 在 (x, y) 附近找空位放实体，找法和 SetupContext.spawnNear 一样，找不到返回 null */
  spawnNear(type: string, owner: number, x: number, y: number, opts?: { amount?: number }): number | null
  remove(id: number): void
  /** 让玩家出局：不再调用他的 bot，实体留着（要清掉自己 remove） */
  eliminate(player: number): void
  /**
   * 指挥中立实体（owner 为 -1，比如野怪）：和 bot 的同名命令一样执行，命令会一直执行到完成或失效。
   * 中立实体闲着时会自动打射程内的玩家实体；玩家不会自动打中立实体（要用 attack 命令）
   */
  orderNeutral(id: number, order: NeutralOrder): void
  /** 改生命（不超过最大生命）；改到 0 或以下就死掉（击杀者算 -1）。资源点不能用（储量用不了这个改） */
  setHp(id: number, hp: number): void
  /** 改归属（占领、招降、变成中立）。实体的命令变成 idle，生产队列清空（不退钱）。换主人的那一刻不检查单位上限，
   * 之后照常算进新主人的单位数（满了的话新主人就造不了兵）。没建好的建筑换了主人，原来去建它的工人会停下
   */
  setOwner(id: number, owner: number): void
  /**
   * 局中改数值（科技、增益、光环、地形效果……，D-153）：改某个玩家（-1 是中立）的某类实体，他已有的和以后造出来的都按新数值，
   * 换了主人的实体按新主人的算。和这个玩家这类实体之前改过的合并；值是改成多少，写原值就是改回去，patch 写 null 全部改回原值。
   * 能改生命上限、走一格几 tick、视野、攻击（伤害、射程、冷却）、采集（每次采多少、几 tick、最多带多少），见 StatPatch。
   * bot 从实体的 stats 字段看到改过的数值；回放、播放器、视频按改过的画（视野、血条）
   */
  setTypeStats(player: number, type: string, patch: StatPatch | null): void
  /** 改单个实体（在 setTypeStats 的结果上再改，比如光环、站在某种地形上）；同样合并，null 是去掉这个实体单独的改动 */
  setStats(id: number, patch: StatPatch | null): void
  setMarkers(markers: Marker[]): void
  /** 回放顶部显示的一行状态文字 */
  setStatus(text: string): void
  /**
   * (x, y) 这一格现在在不在 player 那一队的视野里（没开迷雾时总是 true）。玩家放地基时平台先要求占地每格都看得见，
   * 然后才问 buildCheck，所以列给 bot 的建造位置要保证玩家看得见；用它在 objectives 里标出现在能不能建
   */
  isVisible(player: number, x: number, y: number): boolean
  /**
   * 往回放和战报的关键事件里写一条规则包自己的事（比如"P0 扛起了 P1 的旗"）。player 是这条主要关于谁（不写或 -1 是所有人），
   * 按某个玩家写战报时只列和他、盟友、对手有关的。每 tick 最多 20 条、每条最多 100 字，整局 2000 条，多了的丢掉
   */
  note(text: string, player?: number): void
}

export interface Ruleset {
  id: string
  name: string
  /** 可选：一句话玩法简介（最多 60 字），rts-arena list 里显示，免得别人写了撞题的规则包 */
  summary?: string
  players: { min: number; max: number }
  /** 是否支持分队（规则包要自己按队伍摆位置、判胜负）；不支持时命令行拒绝 --teams */
  teams?: boolean
  /** 一局最多多少 tick */
  maxTicks: number
  /** 回放每秒播放多少 tick（只影响观看） */
  tickRate: number
  /** 每隔几个 tick 调用一次 bot */
  decisionInterval: number
  /** 每次调用 bot 的燃料上限 */
  fuel: number
  /** 每个玩家最多同时拥有多少个单位（含生产队列）；0 = 不限 */
  unitCap: number
  /** 是否有战争迷雾 */
  fog: boolean
  resources: string[]
  terrain: Record<string, TerrainSpec>
  types: Record<string, TypeSpec>
  setup(ctx: SetupContext): void
  /** 每 tick 内核结算完之后调用 */
  onTick?(ctx: RuleContext): void
  /** 给某个玩家的 bot 看的目标信息（必须能 JSON 序列化） */
  objectives(ctx: RuleContext, player: number): unknown
  /** 每 tick 判一次，返回 null 表示继续 */
  result(ctx: RuleContext): MatchResult | null
  /** 到 maxTicks 还没分出胜负时调用 */
  timeUp(ctx: RuleContext): MatchResult
  /**
   * 可选：玩家用 build 放地基时，平台检查完位置之后、扣钱之前（钱够不够在它之后检查）再问规则包一次。返回 null 是允许，返回字符串是拒绝原因
   * （会原样告诉 bot）。比如"烽火台只能建在台址里"。bot 的 canBuild 不知道这条规则，要在 RULES.md 里写清楚
   */
  buildCheck?(ctx: RuleContext, player: number, type: string, x: number, y: number): string | null
  /** 平台内部用：一局结束后调用（沙箱里的规则包在这里释放这一局的沙箱），规则包作者不用写 */
  release?(): void
}

// ---------- 内部状态 ----------

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Rng {
  /** 32 位无符号整数 */
  next(): number
  /** [0, n) 的整数 */
  int(n: number): number
  shuffle<T>(arr: T[]): void
}

/** 规则包看到的实体。沙箱里的规则包拿到的是调用时的快照：改字段没有用，存起来下次再看也不会更新 */
export interface RuleEntity extends Rect {
  id: number
  type: string
  def: TypeDef
  owner: number
  hp: number
  /** 资源点储量 */
  amount: number
  order: Order
  carrying: { resource: string; amount: number } | null
  queue: { type: string; ticksLeft: number }[]
  /** 没建好的建筑：已完成和总工作量；建好的、规则包直接放的都是 null */
  construction: { done: number; total: number } | null
  alive: boolean
}

/** 规则包看到的玩家 */
export interface RulePlayer {
  id: number
  name: string
  alive: boolean
  score: number
  resources: Record<string, number>
}

export interface EntityState extends RuleEntity {
  attackCd: number
  moveCd: number
  gatherCd: number
  /** 最后一击的玩家，-1 表示没有 */
  lastHitBy: number
  /** 最后一击是中立实体 */
  lastHitNeutral: boolean
  /** 追会动的目标时的 A* 路径：倒序存格子下标，末尾是下一步 */
  path: number[]
  pathKey: string
  /** 规划路径时目标所在的位置（目标走远了就重新规划） */
  planX: number
  planY: number
  /** 被单位挡住的连续 tick 数 */
  stuck: number
  /** 上次被挡住时想走进的格子（-1 表示没有）；两个自己人互相想进对方的格就交换位置 */
  want: number
}

export interface PlayerState extends RulePlayer {
  /** 等着交给 bot 的事件 */
  pending: GameEvent[]
}

// ---------- bot 运行器 ----------

export interface BotCall {
  /** bot 发出的命令，未校验 */
  commands: unknown[]
  logs: string[]
  /** onTick 抛错或燃料耗尽（本次命令作废，bot 继续） */
  error?: string
  fuelOut?: boolean
  /** 致命错误（内存超限、墙钟超时、加载失败），bot 之后不再被调用 */
  fatal?: string
  /** 本次用掉的燃料 */
  fuel: number
  /** 本次墙钟耗时（毫秒，只做统计） */
  ms: number
}

export interface BotRunner {
  start(gameJson: string): BotCall
  tick(viewJson: string): BotCall
  dispose(): void
}

// ---------- 回放 ----------

export interface EntSnap {
  id: number
  type: string
  owner: number
  x: number
  y: number
  /** 资源点为储量 */
  hp: number
  ord: string
  /** 没建好的建筑：建造进度百分比（0～99） */
  bp?: number
  /** 被规则包改过的数值（和回放 types 里不一样的项，D-153）；没改过就没有 */
  st?: StatDiff
}

/** 实体和它类型原值不一样的数值（bot 视图的 stats、回放的 st） */
export interface StatDiff {
  maxHp?: number
  moveTicks?: number
  sight?: number
  attack?: { damage: number; range: number; cooldown: number }
  gather?: { amount: number; ticks: number; capacity: number }
}

export interface PlayerSnap {
  resources: Record<string, number>
  score: number
  alive: boolean
}

export interface Snapshot {
  entities: EntSnap[]
  players: PlayerSnap[]
  markers: Marker[]
  status: string
}

/** 一个 tick 的变化，字段都可省略 */
export interface Frame {
  t: number
  spawn?: EntSnap[]
  /** [id, x, y, id, x, y, ...] */
  move?: number[]
  /** [id, hp, ...]，资源点为储量 */
  hp?: number[]
  die?: number[]
  /** [攻击者, 目标, ...] */
  shots?: number[]
  ord?: [number, string][]
  /** die 里由规则包 remove 掉的（不是被打死的） */
  removed?: number[]
  /** 规则包用 ctx.note 写的事件（p 是主要关于谁，-1 是所有人） */
  notes?: { p: number; text: string }[]
  /** [id, 新主人, ...]：规则包改了归属（setOwner）的实体，-1 是中立 */
  owner?: number[]
  /** [id, 改过的数值, ...]：数值有变化的实体（null 是改回了原值），D-153 */
  st?: [number, StatDiff | null][]
  /** [id, 建造进度百分比, ...]；100 表示建好了 */
  bp?: number[]
  players?: PlayerSnap[]
  markers?: Marker[]
  status?: string
  /** bot 打印的日志（属于上一次决策） */
  logs?: { p: number; text: string[] }[]
  /** bot 报错、燃料耗尽、命令被拒 */
  errs?: { p: number; msg: string }[]
}

export interface BotStats {
  player: number
  bot: string
  status: "ok" | "dead"
  deadReason?: string
  calls: number
  fuelTotal: number
  fuelMax: number
  errors: number
  fuelOuts: number
  rejected: number
  ms: number
}

export interface Replay {
  format: "rts-arena-replay"
  version: 1
  ruleset: { id: string; name: string }
  seed: number
  tickRate: number
  maxTicks: number
  players: { name: string; bot: string; team: number }[]
  map: { width: number; height: number; terrain: string[]; colors: Record<string, string> }
  /** sight 是视野半径、cost 是造价、worker 表示能采集或建造（老回放没有）；按视野看回放、战报用 */
  types: Record<string, { kind: TypeDef["kind"]; w: number; h: number; maxHp: number; moveTicks: number; sight?: number; cost?: TypeDef["cost"]; worker?: boolean; /** D-145 起记下（vs 是克制倍数，D-166） */ attack?: { damage: number; range: number; cooldown: number; vs?: Partial<Record<string, number>> }; /** D-148 起记下：能不能采集、能建什么 */ gather?: boolean; builds?: string[]; look: Look }>
  /** 有没有战争迷雾（老回放没有） */
  fog?: boolean
  initial: Snapshot
  frames: Frame[]
  result: MatchResult & { tick: number }
  bots: BotStats[]
  /** 性能统计：同时存在的实体数峰值、内核结算耗时、bot 耗时（毫秒，只做参考，不影响结果） */
  perf: { peakEntities: number; simMs: number; botMs: number }
}
