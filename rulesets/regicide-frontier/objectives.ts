// 弑君拓荒玩法给 bot 的目标信息（这个文件也会原样进 arena.d.ts）

export interface Objectives {
  /** 对手主基地（base）开局时的左上角位置；基地不会移动，被摧毁后仍然列在这里 */
  enemyBases: { owner: number; x: number; y: number }[]
  /** 每个玩家的击杀价值，下标是玩家编号；到时间上限时比这个。和 view.players[i].score 是同一个数 */
  killValue: number[]
  /**
   * 地图上的野怪营地（位置公开，和金矿一样；看不见的营地里活着几只也告诉你）。打死一只野怪，最后一击的玩家得 150 金赏金；
   * 营地清空后过 900 tick 原地刷新。野怪挨了打、或者你的东西走进营地 2 格内就会出手，追打营地 8 格内的玩家实体
   */
  creepCamps: {
    /** 营地第一只野怪的位置（营地是这一格和它右边、下边的格子） */
    x: number
    y: number
    /** 满员几只 */
    size: number
    /** 现在活着几只 */
    alive: number
    /** 清空以后在第几 tick 刷新；没清空是 null */
    respawnAt: number | null
  }[]
}
