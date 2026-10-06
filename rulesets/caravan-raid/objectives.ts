// 给 bot 的目标信息（这个文件也会原样进 bot 作者的 arena.d.ts）

/** 一条商路：2 格宽的道路（地形字符 '='），商队从 from 走到 to */
export interface RouteInfo {
  /** 商路编号 0～3 */
  id: number
  /** 道路占的矩形（2 格宽、贯穿全图） */
  lane: { x: number; y: number; w: number; h: number }
  /** 商队出发的格子（地图边上） */
  from: { x: number; y: number }
  /** 商队要去的格子（对面的地图边上），走到就算平安过境、消失 */
  to: { x: number; y: number }
}

/** 一支商队（不受战争迷雾影响，所有人都看得到） */
export interface CaravanInfo {
  /** 商队的实体 id（类型 caravan） */
  id: number
  x: number
  y: number
  /** 现在归谁：-1 是还没被劫的中立商队 */
  owner: number
  /** 走的是哪条商路 */
  route: number
  /** 离它 guardRange 格以内还活着的镖师数；大于 0 时中立商队劫不走 */
  guards: number
  hp: number
}

export interface Objectives {
  /** 队伍分数（队员分数之和）先达到这个数的队伍赢；2 队 1000、3 队 800、4 队 700 */
  target: number
  /** 你所在的队伍编号 */
  myTeam: number
  /** 每个队伍的分数，下标是队伍编号 */
  teamScores: number[]
  /** 下一批商队出发的 tick */
  nextWave: number
  /** 4 条商路 */
  routes: RouteInfo[]
  /** 场上所有商队（中立的和已经被劫走的） */
  caravans: CaravanInfo[]
  /** 非盟友玩家主基地的左上角（主基地 3×3，不会移动；已经被摧毁的也在） */
  enemyBases: { owner: number; x: number; y: number }[]
  /** 你和盟友主基地的左上角 */
  allyBases: { owner: number; x: number; y: number }[]
  /** 几个距离常数（都是曼哈顿距离，贴着 = 1） */
  rules: {
    /** 单位离商队这么近才算"在旁边"，劫商队、守商队都按这个算 */
    captureRange: number
    /** 镖师离中立商队这么近时，商队劫不走 */
    guardRange: number
    /** 自己的商队离自己或盟友的主基地 / 货栈这么近就算交货 */
    deliverRange: number
    /** 交一支商队得几分 */
    caravanScore: number
    /** 交一支商队另外给多少金 */
    caravanGold: number
    /** 货栈离非盟友主基地至少几格 */
    postMinEnemyBaseDist: number
  }
}
