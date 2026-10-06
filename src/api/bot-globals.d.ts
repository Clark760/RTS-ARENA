// 沙箱里可以直接用的全局变量和函数（只用于生成 arena.d.ts，引擎不引用）

/** 游戏静态信息，和 onStart 收到的参数相同；顶层代码执行时就已可用 */
declare const game: Game

/** 打印日志，写进回放，在网页播放器里对着画面看。每次调用 onTick 最多记 20 行，每行最多 300 字 */
declare const console: {
  log(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  info(...args: unknown[]): void
  debug(...args: unknown[]): void
}

/** 曼哈顿距离 |dx|+|dy|。传实体时按占地最近的格子算（贴着 = 1） */
declare function dist(a: Pos | Entity, b: Pos | Entity): number

/**
 * build 命令能不能把 type 的地基放在左上角 (x, y)：在地图内、地形可走、没有任何实体（按 view 里看得到的），
 * 有战争迷雾时每一格还要在你方或盟友某个实体的视野里。和引擎的检查一致，返回 true 的位置不会因为占地被拒
 */
declare function canBuild(view: View, type: TypeName, x: number, y: number): boolean
