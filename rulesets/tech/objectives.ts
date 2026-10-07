// 科技玩法给 bot 的目标信息（这个文件也会原样进 arena.d.ts）

/** 科技建筑的类型名：铁匠铺、护甲坊、箭术场、矿业所 */
export type TechId = "forge" | "armory" | "archery" | "mining"

export interface Objectives {
  /** 对手主基地（base）开局时的左上角位置；基地不会移动，被摧毁后仍然列在这里 */
  enemyBases: { owner: number; x: number; y: number }[]
  /** 每个玩家的击杀价值，下标是玩家编号；到时间上限时比这个。和 view.players[i].score 是同一个数 */
  killValue: number[]
  /** 每个玩家现在生效的科技（有建好、还在的这种科技建筑），下标是玩家编号；整局公开，不受迷雾影响 */
  techs: TechId[][]
}
