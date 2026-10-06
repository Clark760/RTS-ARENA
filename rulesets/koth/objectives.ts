// 夺点玩法给 bot 的目标信息（这个文件也会原样进 arena.d.ts）

export interface Objectives {
  /** 控制点区域（左上角 + 宽高） */
  zone: { x: number; y: number; w: number; h: number }
  /** 当前控制者；没人或多方同时在场为 null */
  controller: number | null
  /** 每个玩家的控制分，下标是玩家编号 */
  points: number[]
  /** 先到这个分数的赢 */
  target: number
  /** 对手主基地开局时的左上角位置 */
  enemyBases: { owner: number; x: number; y: number }[]
}
