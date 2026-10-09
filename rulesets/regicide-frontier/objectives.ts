// 弑君拓荒玩法给 bot 的目标信息（这个文件也会原样进 arena.d.ts）

export interface Objectives {
  /** 对手主基地（base）开局时的左上角位置；基地不会移动，被摧毁后仍然列在这里 */
  enemyBases: { owner: number; x: number; y: number }[]
  /** 每个玩家的击杀价值，下标是玩家编号；到时间上限时比这个。和 view.players[i].score 是同一个数 */
  killValue: number[]
}
