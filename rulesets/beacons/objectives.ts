// 给 bot 的目标信息（这个文件也会原样进 bot 作者的 arena.d.ts）

/** 一块台址（计分区域）。坐标是格子，(x, y) 是左上角 */
export interface Site {
  /** 台址编号，整局不变 */
  id: number
  /** "home0" / "home1"：两家门口；"flank0" / "flank1"：两侧野怪窝（数字是离谁家近）；"center"：中央 */
  name: string
  x: number
  y: number
  w: number
  h: number
  /** 独占这块台址时，每个计分周期得几分 */
  value: number
  /**
   * 当前谁独占这块台址：玩家编号；-1 表示没人有建好的烽火台；-2 表示双方都有（争夺中，谁都不得分）。
   * 这个信息不受战争迷雾影响
   */
  holder: number
  /** 台址里还活着的中立野怪（beast、guardian）数量，不受战争迷雾影响 */
  monsters: number
}

export interface Objectives {
  /** 先累计到这么多分的赢 */
  target: number
  /** 每个玩家当前分数，下标是玩家编号 */
  scores: number[]
  /** 每隔几个 tick 结算一次台址得分 */
  scoreInterval: number
  /** 离下一次结算还有几个 tick（1 表示下一个 tick 就结算） */
  nextScoreIn: number
  /** 全部台址 */
  sites: Site[]
  /** 对手主基地的左上角（3×3，不会移动） */
  enemyBase: { x: number; y: number }
}
