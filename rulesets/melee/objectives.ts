// 混战玩法给 bot 的目标信息（这个文件也会原样进 arena.d.ts）。
// enemyBases、killValue 和「歼灭」同名同义，歼灭的 bot 拿来也能跑。

export interface Objectives {
  /** 还没出局的对手主基地开局时的左上角位置（主基地 3×3，不会移动） */
  enemyBases: { owner: number; x: number; y: number }[]
  /** 每个玩家的击杀价值，下标是玩家编号 */
  killValue: number[]
  /** 已经出局的玩家编号，按出局先后排 */
  eliminated: number[]
}
