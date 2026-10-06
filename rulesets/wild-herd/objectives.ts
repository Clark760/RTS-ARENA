// 给 bot 的目标信息（这个文件也会原样进 bot 作者的 arena.d.ts）

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Objectives {
  /** 每 scoreEvery 个 tick 结算一次牧栏得分 */
  scoreEvery: number
  /** 牛离自己的（建好的）牧栏多近才记分：曼哈顿距离，贴着 = 1 */
  penRadius: number
  /** 一个牧栏每次结算最多给几头牛记分 */
  penCapacity: number
  /** 每 tameEvery 个 tick 判一次驯服 / 偷牛 */
  tameEvery: number
  /** 各队：队伍编号、成员（玩家编号）、队伍总分（成员分数之和）、要攒够的分数 */
  teams: { team: number; members: number[]; score: number; target: number }[]
  /** 草场（牧栏只能整块建在草场里）；holder 是在这块草场上有牧栏（含没建好的）的队伍编号，没有为 null */
  pastures: (Rect & { holder: number | null })[]
  /** 荒原：野牛在这里游荡、补充 */
  wild: Rect
  /** 狼穴：狼从这里出来 */
  den: Rect
  /** 全图所有的牛（不受迷雾影响）；owner 为 -1 是野牛，否则是驯服它的玩家 */
  bison: { id: number; x: number; y: number; owner: number; hp: number }[]
  /** 全图所有的狼（不受迷雾影响） */
  wolves: { id: number; x: number; y: number }[]
  /** 下一波狼出现的 tick */
  nextWolves: number
  /** 狼群现在冲着哪个队伍去（领先的队伍）；没有领先的队伍时为 null（这时狼找离狼穴最近的牧栏） */
  wolfTarget: number | null
  /** 打死一只狼给最后一击的玩家多少金 */
  wolfBounty: number
}
