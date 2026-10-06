// 采集竞速玩法给 bot 的目标信息（这个文件也会原样进 arena.d.ts）

export interface Objectives {
  /** 先累计交货到这个数的赢 */
  target: number
  /** 每个玩家累计交货的金（花掉的也算），下标是玩家编号 */
  gathered: number[]
}
