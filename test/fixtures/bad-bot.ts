// 测试用：采集竞速的目标信息里没有 enemyBases，类型检查应该报错
export function onTick(view: View, cmd: Commands): void {
  const t = view.objectives.enemyBases[0]
  cmd.move(1, t.x, t.y)
}
