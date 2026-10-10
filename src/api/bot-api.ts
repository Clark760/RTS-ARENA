// bot 接口：引擎直接引用这里的类型；`arena docs` 去掉 export、换上规则包的具体类型后，
// 生成发给 bot 作者（大模型或人）的 arena.d.ts。改这里就是改对外接口。

// #region 规则包类型（生成 arena.d.ts 时换成具体规则包的字面量类型）
/** 实体类型名（单位、建筑、资源点），见规则说明里的单位表 */
export type TypeName = string
/** 资源名 */
export type ResourceName = string
/** 规则包给 bot 的目标信息，每个规则包不同，见规则说明 */
export type Objectives = unknown
// #endregion

/** 格子坐标。左上角是 (0,0)，x 向右，y 向下。 */
export interface Pos {
  x: number
  y: number
}

/** 实体类型的固定属性（规则包定义，整局不变） */
export interface TypeDef {
  name: TypeName
  /** unit 能移动；building 不能移动，可以生产、当交货点；resource 是中立资源点，不能被攻击 */
  kind: "unit" | "building" | "resource"
  /** 占地宽（格）。单位都是 1×1，建筑可以更大 */
  w: number
  /** 占地高（格） */
  h: number
  /** 最大生命；0 表示不能被攻击 */
  maxHp: number
  /** 造价 */
  cost: Partial<Record<ResourceName, number>>
  /** 生产用时（tick）。工人建造的建筑是建造工作量：一个工人贴着地基每 tick 干 1，几个工人一起建就快几倍 */
  buildTicks: number
  /** 走一格要几个 tick；0 表示不能移动 */
  moveTicks: number
  /** 视野半径（曼哈顿距离，从占地最近的格子算） */
  sight: number
  /**
   * 攻击能力；null 表示不能攻击。打中目标后要等 cooldown 个 tick 才能再打。
   * vs 是克制倍数（没有就是不克制谁）：打 vs 里列出的类型时，伤害 = damage × 倍数，四舍五入。比如 { cavalry: 3 } 是打骑兵伤害乘 3。
   * 局中改过数值的实体，damage 看它的 stats.attack，倍数仍看这里
   */
  attack: { damage: number; range: number; cooldown: number; vs?: Partial<Record<TypeName, number>> } | null
  /** 采集能力；null 表示不能采集。贴着资源点每 ticks 个 tick 采 amount，身上最多带 capacity */
  gather: { amount: number; ticks: number; capacity: number } | null
  /** 采集者能否在这里交货 */
  dropOff: boolean
  /** 能生产的类型 */
  produces: TypeName[]
  /** 能建造的建筑类型（用 build 命令）；空数组表示不能建造 */
  builds: TypeName[]
  /** 资源点产出的资源；不是资源点为 null */
  resource: ResourceName | null
  /** 技能（用 cmd.cast 释放，D-186）；没有就是空数组 */
  skills: SkillDef[]
  /** 光环：给周围的实体加成（D-186）；没有就是空数组 */
  auras: AuraDef[]
  /** 被动：一直生效、不用下命令（D-186）；没有就是空数组 */
  passives: PassiveDef[]
}

/** 技能：用 cmd.cast 释放，放完要等 cooldown 个 tick 才能再放（D-186）。效果由规则包定，看 desc 和规则说明 */
export interface SkillDef {
  /** 技能名，cmd.cast 用它，比如 "goldmine" */
  id: string
  /** 中文名 */
  name: string
  /** 放完以后要等多少 tick 才能再放 */
  cooldown: number
  /** 开局（或实体刚出现时）要等多少 tick 才能第一次放；0 是马上就能放 */
  initialCooldown: number
  /**
   * 要不要指定目标：none 是不用（cmd.cast(unit, skill)）；point 是指定一格（cmd.cast(unit, skill, { x, y })）；
   * unit 是指定一个看得见的实体（cmd.cast(unit, skill, target)）
   */
  target: "none" | "point" | "unit"
  /** 目标离释放者最远几格（曼哈顿距离，从占地最近的格子算）；target 是 none 时没有意义 */
  range: number
  /** 效果说明 */
  desc: string
}

/**
 * 光环（D-186）：带光环的实体周围 radius 格内、符合条件的实体得到加成，每 tick 重新算，出了范围就没有了。
 * 同名的光环不叠加（几个领主的同一种光环只算一次），不同名的加成相加
 */
export interface AuraDef {
  /** 中文名 */
  name: string
  /** 半径（曼哈顿距离，从占地最近的格子算）；-1 表示等于带光环的实体现在的视野 */
  radius: number
  /** 给谁：own 自己的、allies 自己和盟友的、enemies 敌人的 */
  affects: "own" | "allies" | "enemies"
  /** 只给这些类型；空数组是所有单位和建筑 */
  types: TypeName[]
  /** 带光环的实体自己有没有这份加成 */
  self: boolean
  /** 伤害加成（百分比）：25 是打出的伤害 ×1.25，-20 是 ×0.8 */
  damagePct: number
  /** 减伤（百分比）：25 是受到的伤害 ×0.75，负数是受到的伤害变多 */
  defensePct: number
}

/** 被动（D-186）：一直生效、不用下命令 */
export type PassiveDef =
  /** 脱战回血：delay 个 tick 没挨打、也没出手以后，每 every 个 tick 回 amount 生命（不超过上限）；一挨打或出手就重新计时 */
  { kind: "regen"; name: string; delay: number; every: number; amount: number }

/** 实体身上的一个增益或减益（光环、技能给的，D-186） */
export interface Buff {
  name: string
  /** 伤害加成（百分比） */
  damagePct: number
  /** 减伤（百分比） */
  defensePct: number
  /** 还剩几 tick；光环给的、一直有效的没有这个字段 */
  ticksLeft?: number
}

/** 单位当前在执行的命令。命令会一直执行，直到完成、失效或被新命令替换 */
export type Order =
  | { kind: "idle" }
  | { kind: "move"; x: number; y: number }
  | { kind: "attack"; target: number }
  /** neutral 为 true：也打中立实体（野怪这类），对手的单位和建筑优先 */
  | { kind: "attackMove"; x: number; y: number; neutral?: boolean }
  /** returning 为 true 表示正带着资源回交货点 */
  | { kind: "gather"; target: number; returning: boolean }
  /** 去建 target 这个没建好的建筑（走到贴着它，然后每 tick 干 1 份活） */
  | { kind: "build"; target: number }

/** 看得到的实体。建筑的 x、y 是占地左上角 */
export interface Entity {
  /** 随机分配的正整数，不重复使用，大小不代表先后 */
  id: number
  type: TypeName
  /** 所属玩家编号；-1 表示中立 */
  owner: number
  x: number
  y: number
  w: number
  h: number
  /** 资源点的 hp、maxHp 都是 0，剩余量看 amount */
  hp: number
  maxHp: number
  /** 资源点剩余量（只有资源点有） */
  amount?: number
  /**
   * 被规则包局中改过的数值（科技、增益之类，看规则说明），只列和 game.types 里不一样的项；没改过就没有这个字段。
   * 算射程、视野、走多快、伤害时先看这里，没有再看 game.types[类型]。生命上限直接看 maxHp
   */
  stats?: {
    moveTicks?: number
    sight?: number
    attack?: { damage: number; range: number; cooldown: number }
    gather?: { amount: number; ticks: number; capacity: number }
  }
  /** 当前命令（只有自己的实体有） */
  order?: Order
  /** 身上带的资源（只有自己的单位、且带着资源时才有） */
  carrying?: { resource: ResourceName; amount: number }
  /** 生产队列，第一个正在生产（只有自己的、能生产的实体有） */
  queue?: { type: TypeName; ticksLeft: number }[]
  /** 还要几个 tick 才能再攻击，0 表示现在就能打（只有自己的、能攻击的实体有） */
  cooldown?: number
  /** 每个技能还要几个 tick 才能再放，0 表示现在就能放（只有自己的、有技能的实体有，D-186） */
  skillCooldowns?: Record<string, number>
  /**
   * 身上的增益、减益（光环、技能给的，D-186），看得到这个实体就看得到；没有就没有这个字段。
   * 打出的伤害 = 原伤害 ×（1 + 攻击方各项 damagePct 之和 / 100）×（1 − 挨打方各项 defensePct 之和 / 100），四舍五入，原伤害大于 0 时至少 1
   */
  buffs?: Buff[]
  /**
   * 没建好的建筑才有（谁都看得到）：done 是已完成的工作量，total 是总工作量（就是 buildTicks）。
   * 没建好的建筑不能生产、不能当交货点、不能攻击，但会挡路、能被打。建好后没有这个字段
   */
  construction?: { done: number; total: number }
}

/** 公开的玩家信息 */
export interface PlayerInfo {
  id: number
  name: string
  /** 队伍编号。同队的是盟友：共享视野、不能互相攻击，资源和交货点各管各的。不分队时每人一队 */
  team: number
  /** false 表示已出局 */
  alive: boolean
  /** 当前分数，含义由规则包定（见规则说明里的「分数」） */
  score: number
}

/** bot 发出的命令（被拒绝时会原样出现在 rejected 事件里） */
export type Command =
  | { kind: "move"; unit: number; x: number; y: number }
  | { kind: "attack"; unit: number; target: number }
  | { kind: "attackMove"; unit: number; x: number; y: number; neutral?: boolean }
  | { kind: "gather"; unit: number; target: number }
  | { kind: "stop"; unit: number }
  | { kind: "produce"; building: number; type: TypeName }
  | { kind: "cancel"; building: number }
  | { kind: "build"; unit: number; type: TypeName; x: number; y: number }
  | { kind: "cast"; unit: number; skill: string; x?: number; y?: number; target?: number }

/** 上次调用 onTick 之后发生的、和你有关的事 */
export type GameEvent =
  /** 命令没被执行，reason 说明原因 */
  | { kind: "rejected"; tick: number; command: Command; reason: string }
  /** 你的新实体出现了：单位生产出来，或者 build 放下了地基（这时它还没建好） */
  | { kind: "created"; tick: number; id: number; type: TypeName }
  /** 你的建筑建好了 */
  | { kind: "built"; tick: number; id: number; type: TypeName }
  /** 你的实体、或你看得到的实体死了（资源点采完也算） */
  /** unfinished 为 true 表示死的是没建好的建筑（地基）；removed 为 true 表示是规则包移除的（不是被打死的，玩法说明里会写什么时候移除） */
  | { kind: "died"; tick: number; id: number; type: TypeName; owner: number; x: number; y: number; unfinished?: true; removed?: true }
  /** 你的实体挨打了；by 是攻击者 id，攻击者不一定在你视野里 */
  | { kind: "damaged"; tick: number; id: number; by: number; damage: number }
  /** 你上次的 onTick 抛错或燃料耗尽，那一次的命令全部作废 */
  | { kind: "botError"; tick: number; message: string }

/** 每次调用 onTick 时你看到的局面 */
export interface View {
  tick: number
  /** 你的玩家编号 */
  me: number
  /** 你拥有的资源 */
  resources: Record<ResourceName, number>
  players: PlayerInfo[]
  /** 你看得到的全部实体（含自己的；资源点不受迷雾影响，一直都在），按 id 升序 */
  entities: Entity[]
  /** 规则包给的目标信息 */
  objectives: Objectives
  events: GameEvent[]
}

/** 游戏静态信息，整局不变 */
export interface Game {
  /** 你的玩家编号 */
  me: number
  /** 玩家名，下标就是玩家编号 */
  playerNames: string[]
  /** 每个玩家的队伍编号，下标是玩家编号；同队的是盟友 */
  teams: number[]
  width: number
  height: number
  /** 地形，terrain[y][x] 是一个字符 */
  terrain: string[]
  /** 地形字符能否通行（建筑和资源点所在的格子也不能通行） */
  walkable: Record<string, boolean>
  types: Record<TypeName, TypeDef>
  resources: ResourceName[]
  /** 一局最多多少 tick，到点按规则判胜负 */
  maxTicks: number
  /** 每隔几个 tick 调用一次 onTick */
  decisionInterval: number
  /** 每次调用的燃料上限（1 燃料约等于 5000 次简单循环） */
  fuel: number
  /** 每个玩家最多同时拥有多少个单位（建筑和资源点不算，生产队列里的算）；0 表示不限 */
  unitCap: number
  /** 是否有战争迷雾（有的话只看得到己方和盟友实体视野里的东西，建造也只能建在视野里） */
  fog: boolean
}

/** onTick 里用来下命令的对象。unit、building、target 可以传实体或 id */
export interface Commands {
  /** 走到 (x, y)，途中不还手。目标格在障碍里就走到最近的能站的格后停下；完全走不过去就直接停下 */
  move(unit: Entity | number, x: number, y: number): void
  /** 追着打 target，直到它死掉、你看不见它或走不到它（不能移动的实体：目标出了射程也结束） */
  attack(unit: Entity | number, target: Entity | number): void
  /**
   * 走向 (x, y)，路上射程内有敌人就打、视野内有敌人就追（走不过去的不追）。
   * 写 `{ neutral: true }` 时中立实体（野怪这类）也打：射程里有对手的东西先打对手的，没有才打射程里中立的；追视野里的也是先追对手的
   */
  attackMove(unit: Entity | number, x: number, y: number, options?: { neutral?: boolean }): void
  /** 循环采集：采满后自动回最近的交货点交货，再回来采；资源点采完后交完手上的就停下 */
  gather(unit: Entity | number, resource: Entity | number): void
  /** 停下。停着的单位会打射程内的敌人，但不追 */
  stop(unit: Entity | number): void
  /** 排进生产队列，立即扣钱（同一次调用里按顺序扣，钱不够的被拒）；队列最多 5 个 */
  produce(building: Entity | number, type: TypeName): void
  /** 取消队列里最后一个，全额退款。对没建好的建筑：拆掉它，退还造价的 75%（向下取整） */
  cancel(building: Entity | number): void
  /**
   * 让 unit（能建造的单位）在左上角 (x, y) 建一座 type：立即放下地基、扣钱（同一次调用里和 produce 一起按顺序扣），
   * 然后走过去建。地基占的格子要都在地图内、地形可走、没有任何实体，而且都在你方视野里（可以先用 canBuild 检查）。
   * 对自己没建好的同类地基（左上角正好是 (x, y)）下这个命令，就是去接着建或者帮忙，不扣钱。
   */
  build(unit: Entity | number, type: TypeName, x: number, y: number): void
  /**
   * 让 unit 释放技能 skill（game.types[类型].skills 里的 id，D-186）。技能的 target 是 none 时不写第三个参数；
   * point 时写一格 { x, y }；unit 时写一个看得见的实体（或它的 id）。冷却没好、目标不对、规则包不让放的都会被拒（rejected 事件说明原因）。
   * 放成功就开始冷却（entity.skillCooldowns），效果看规则说明
   */
  cast(unit: Entity | number, skill: string, target?: Entity | number | Pos): void
}

/** bot 文件导出的 onTick 的类型 */
export type OnTick = (view: View, cmd: Commands) => void
/** bot 文件导出的 onStart 的类型（可选） */
export type OnStart = (game: Game) => void
