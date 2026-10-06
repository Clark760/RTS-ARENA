// 给 bot 的目标信息（这个文件也会原样进 bot 作者的 arena.d.ts）

/** 一面旗现在的状态 */
export interface FlagInfo {
  /** 旗是谁的（玩家编号）。敌人把它扛走、送到自己队的旗台才得分 */
  owner: number
  /**
   * home：插在主人的旗台上；carried：被敌方单位扛着走；dropped：旗手死了，掉在地上；
   * gone：主人出局了，这面旗没了
   */
  state: "home" | "carried" | "dropped" | "gone"
  /** 旗现在的位置（carried 时是旗手的位置；gone 时是主人的旗台） */
  x: number
  y: number
  /** 扛着它的单位 id（只有 carried 有，否则 null） */
  carrier: number | null
  /** 扛着它的单位属于哪个玩家（只有 carried 有，否则 null） */
  carrierOwner: number | null
  /** dropped 的旗在这个 tick 自动回到旗台（否则 null） */
  returnAt: number | null
}

export interface Objectives {
  /** 本队累计送回这么多面敌旗就赢（3 + 本队人数 - 1：一人一队 3 面，两人一队 4 面） */
  target: number
  /** 每个队伍要送回几面，下标是队伍编号 */
  teamTargets: number[]
  /** 我的队伍编号 */
  myTeam: number
  /** 每个队伍累计送回了几面旗，下标是队伍编号 */
  teamScores: number[]
  /** 每个玩家的旗，下标是玩家编号（不受迷雾影响） */
  flags: FlagInfo[]
  /** 每个玩家的旗台（旗在家时插在这一格）。扛着敌旗走到自己队任何一个旗台 2 格以内（曼哈顿距离）就算送回 */
  stands: { owner: number; x: number; y: number }[]
  /** 每个玩家的旗台广场（+ 地形，5×5，不能建任何建筑） */
  plazas: { owner: number; x: number; y: number; w: number; h: number }[]
  /** 我能建哨塔（tower，2×2）的左上角：只能建在高地（^ 地形）上，这里列出地形合适的位置（还要没被占、在视野里） */
  towerSpots: { x: number; y: number }[]
  /** 场上的巨魔（中立，不受迷雾影响）：在地图中央巡逻，优先追杀附近的旗手 */
  trolls: { id: number; x: number; y: number; hp: number }[]
  /** 每个玩家主基地的左上角（3×3，不会移动）；alive 为 false 表示已出局 */
  bases: { owner: number; x: number; y: number; alive: boolean }[]
}
