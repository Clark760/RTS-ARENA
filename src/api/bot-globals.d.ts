// 沙箱里可以直接用的全局变量和函数（只用于生成 arena.d.ts，引擎不引用）

/** 游戏静态信息，和 onStart 收到的参数相同；顶层代码执行时就已可用 */
declare const game: Game

/** 打印日志，写进回放，在网页播放器里对着画面看。每次调用 onTick 最多记 20 行，每行最多 300 字 */
declare const console: {
  log(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** 曼哈顿距离 |dx|+|dy|。传实体时按占地最近的格子算（贴着 = 1） */
declare function dist(a: Pos | Entity, b: Pos | Entity): number
