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

/** 曼哈顿距离 |dx|+|dy|。传实体时按占地最近的格子算（贴着 = 1）；也可以传 { x, y, w, h }（比如还没放下的地基的占地） */
declare function dist(a: Pos | Entity | { x: number; y: number; w: number; h: number }, b: Pos | Entity | { x: number; y: number; w: number; h: number }): number

/**
 * build 命令能不能把 type 的地基放在左上角 (x, y)：在地图内、地形可走、没有任何实体（按 view 里看得到的），
 * 有战争迷雾时每一格还要在你方或盟友某个实体的视野里。和引擎的检查一致，返回 true 的位置不会因为占地被拒
 */
declare function canBuild(view: View, type: TypeName, x: number, y: number): boolean

/**
 * 和 canBuild 一样的检查，但返回放不下的原因（放得下返回 null）：超出地图、哪一格不在视野里、哪一格地形不行、被哪个实体挡着。
 * 原因的文字和 build 被拒时的一样。派工人去远处建造时，可以每次决策都看一眼，知道还差什么
 */
declare function buildProblem(view: View, type: TypeName, x: number, y: number): string | null

/**
 * 在 near 附近找能放 type 的位置（返回左上角）：按离 near 的距离从近到远找到 maxRange 格（默认 8）；
 * 占地四周 margin 格（默认 1）以内不能有建筑和资源点，留出走路的空，免得堵住采矿的路。
 * 找到的位置 buildProblem 一定是 null；找不到返回 null（可能是附近不在视野里，或者都被占了）
 */
declare function findBuildSpot(view: View, type: TypeName, near: Pos, maxRange?: number, margin?: number): Pos | null

/**
 * 按地形走路的距离（隔着墙时比 dist 准）：从 from（一个点、一个实体，或者它们的数组）出发，上下左右走，
 * 绕开不可走的地形和看得见的建筑、资源点（单位不算挡路）。返回数组，下标是 y * game.width + x，值是走到这一格要几步，走不到是 -1。
 * 起点是建筑这类多格实体时，它占的格子是 0、贴着它的格子是 1（和 dist 一样）。
 * 整张图算一遍，燃料不多但也不是白给：存起来反复用（建筑变了再算），别每个单位每次都算。
 * view 写 null 就只看地形（onStart 里还没有 view 时可以先算一遍）
 */
declare function pathDistances(view: View | null, from: Pos | Entity | (Pos | Entity)[]): number[]
