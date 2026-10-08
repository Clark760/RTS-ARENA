# 写 bot 指南

这份指南讲清楚 bot 是怎么运作的、怎么写、怎么调。完整的接口和每个规则包的玩法在 bot 目录的 `PROMPT.md` 里（`rts-arena init` 生成），写的时候对照着看。还没跑过第一局的话，先看 [入门教程](入门教程.md)。

## 1. bot 长什么样

一个 TypeScript 文件，导出 `onTick`，可选导出 `onStart`：

```ts
export function onStart(game: Game): void {
  // 可选：开局调用一次
}

export function onTick(view: View, cmd: Commands): void {
  // 每隔 game.decisionInterval 个 tick 调用一次：看 view，用 cmd 下命令
}
```

- **只能是一个文件**，不能 `import`。`View`、`Entity`、`Commands` 这些类型和 `dist`、`console.log` 这些全局函数直接用。
- **顶层变量整局都在**，用来记状态：看到过的敌人、每个单位的分工、进攻还是防守。
- **只用"擦掉类型就是 JavaScript"的写法**：不能用 `enum`、`namespace`、构造函数参数属性。
- **没有异步**：没有 `setTimeout`，`onTick` 里排的 `Promise` 回调不会执行。

## 2. 每次调用你能看到什么

### game：整局不变的信息

| 字段 | 内容 |
|---|---|
| `game.me` | 你的玩家编号 |
| `game.width`、`game.height`、`game.terrain`、`game.walkable` | 地图：`terrain[y][x]` 是一个字符，`walkable[字符]` 说明能不能走 |
| `game.types` | 每种实体的数值：占地、生命、造价、生产用时、走一格几 tick、视野、攻击、采集、能生产什么、能建什么 |
| `game.decisionInterval` | 每隔几个 tick 调用一次 `onTick` |
| `game.fuel`、`game.unitCap`、`game.fog`、`game.maxTicks` | 每次调用的燃料上限、单位上限、有没有战争迷雾、一局最多多少 tick |

### view：这一刻的局面

| 字段 | 内容 |
|---|---|
| `view.tick` | 现在是第几 tick |
| `view.resources` | 你有多少资源，比如 `view.resources.gold` |
| `view.players` | 每个玩家：名字、队伍、还在不在、分数 |
| `view.entities` | 你看得见的全部实体：自己的、看得见的敌人和中立实体、所有资源点 |
| `view.objectives` | 规则包给的目标信息，比如对手主基地在哪、比分（看 PROMPT.md） |
| `view.events` | 上次调用以来发生的事 |

实体（`Entity`）的常用字段：`id`、`type`、`owner`（-1 是中立）、`x`、`y`、`w`、`h`、`hp`、`maxHp`。自己的实体还有：

- `order`：现在在执行的命令；
- `carrying`：身上带的资源；
- `queue`：建筑的生产队列；
- `cooldown`：还要几 tick 才能再攻击。

资源点有 `amount`（剩余量）；没建好的建筑有 `construction`。有的规则包会在局中改单位数值（比如科技），改过的项在 `stats` 里。

事件（`view.events`）有这几种：

| 事件 | 什么时候 |
|---|---|
| `rejected` | 你的命令没被执行，`reason` 写着原因。**一定要看** |
| `created` | 你的新单位造出来了，或者地基放下了 |
| `built` | 你的建筑建好了 |
| `died` | 你的、或你看得见的实体死了（资源点采完也算） |
| `damaged` | 你的实体挨打了，`by` 是谁打的 |
| `botError` | 你上次的 `onTick` 抛错或燃料耗尽，那次的命令全部作废 |

## 3. 下命令

| 命令 | 效果 |
|---|---|
| `cmd.move(u, x, y)` | 走过去，路上不还手 |
| `cmd.attack(u, target)` | 追着打一个目标，直到它死或看不见 |
| `cmd.attackMove(u, x, y)` | 边走边打：射程内有敌人就打，视野里有敌人就追 |
| `cmd.gather(u, resource)` | 循环采集：采满自动回最近的交货点，交完再回来 |
| `cmd.stop(u)` | 停下 |
| `cmd.produce(b, type)` | 建筑排队生产，立即扣钱 |
| `cmd.cancel(b)` | 取消队列里最后一个（全额退款），或拆掉没建好的地基（退 75%） |
| `cmd.build(u, type, x, y)` | 在左上角 (x, y) 放地基、立即扣钱，单位走过去建（有建造的规则包才有用） |

几条最重要的规则：

- **命令会一直执行**，直到完成、失效或被新命令替换。只在需要改变时下命令，不用每次给每个单位重下。给单位下和它现在完全一样的命令没有任何影响。
- **`view` 是调用开始时的快照**。同一次调用里 `produce` 之后，`view.resources` 不会变少，要自己记账。
- **所有人同时下命令、同时结算**，没有先手后手。你在第 t tick 下的命令，推进到第 t+1 tick 时最先执行。
- **自动攻击**：`idle` 和 `attackMove` 状态、能攻击的单位会打射程内最近的敌人；`move`、`gather`、`build` 状态的不还手。中立实体（野怪之类）不会被自动攻击，要 `cmd.attack` 点名打。
- **不合法的命令不会让 bot 崩溃**，只会被拒，下次在 `view.events` 里看到 `rejected` 和原因。

每条命令什么时候被拒，PROMPT.md 的「命令」一节有完整的表。

## 4. 一个能用的例子

下面是「歼灭」里一个完整的 bot。它在每个出生位置都试打通过，被拒命令 0；和参考 bot 每对打 6 局：能赢 `rush`（4 胜 2 负）和 `boom`（6 胜 0 负），打不过 `baseline`（0 胜 6 负）。可以从这里改起。

```ts
// 示例 bot（歼灭）：采矿、补工人、兵营一直出兵；凑够 8 个兵去拆对方主基地，家里来敌人就回防
const ATTACK_AT = 8
let attacking = false

export function onTick(view: View, cmd: Commands): void {
  const mine = view.entities.filter((e) => e.owner === view.me)
  const enemies = view.entities.filter((e) => e.owner >= 0 && e.owner !== view.me)
  const base = mine.find((e) => e.type === "base")
  const barracks = mine.find((e) => e.type === "barracks")
  if (!base) return
  const workers = mine.filter((e) => e.type === "worker")
  const army = mine.filter((e) => e.type === "soldier" || e.type === "archer")
  // produce 之后 view.resources 不会变少，花钱要自己记账
  let gold = view.resources.gold

  // 1. 闲着的工人去采最近的金矿
  const mines = view.entities.filter((e) => game.types[e.type].kind === "resource")
  for (const w of workers) {
    if (w.order?.kind !== "idle" || mines.length === 0) continue
    const m = mines.reduce((a, b) => (dist(w, a) <= dist(w, b) ? a : b))
    cmd.gather(w, m)
  }

  // 2. 生产：工人补到 8 个；兵营轮流出战士和弓手
  const workerCost = game.types.worker.cost.gold ?? 0
  if (workers.length < 8 && (base.queue?.length ?? 0) === 0 && gold >= workerCost) {
    cmd.produce(base, "worker")
    gold -= workerCost
  }
  if (barracks && (barracks.queue?.length ?? 0) === 0) {
    const type = army.length % 2 === 0 ? "soldier" : "archer"
    const cost = game.types[type].cost.gold ?? 0
    if (gold >= cost) {
      cmd.produce(barracks, type)
      gold -= cost
    }
  }

  // 3. 军队：家附近 10 格有敌人就回防；凑够 8 个兵就去拆对方主基地，打剩不到 3 个就收手
  const threats = enemies.filter((e) => game.types[e.type].kind === "unit" && dist(e, base) <= 10)
  if (army.length >= ATTACK_AT) attacking = true
  if (army.length < 3) attacking = false
  const eb = view.objectives.enemyBases[0]
  for (const u of army) {
    if (threats.length > 0) {
      if (u.order?.kind !== "attack") cmd.attack(u, threats[0])
    } else if (attacking) {
      if (u.order?.kind !== "attackMove") cmd.attackMove(u, eb.x + 1, eb.y + 1)
    }
  }
}
```

接下来能改的方向：

- **集火**：射程内挑血最少的打，别各打各的；
- **站位**：战士在前、弓手在后；
- **看敌情出击**：数一数看到过的敌兵，比对方多才进攻，打不过就撤；
- **经济**：每个矿别挤太多人，家门口的矿快采完时去中间的矿。

## 5. 地图、距离和视野

- 格子坐标，左上角是 (0, 0)，x 向右、y 向下。单位只能上下左右走。
- 距离一律是曼哈顿距离 |dx| + |dy|，射程、视野、"贴着"都按它算。近战射程 1 就是上下左右贴着，斜对角打不到。全局函数 `dist(a, b)` 就是这个距离。
- 一格只能站一个单位；建筑、资源点和不能走的地形挡路。
- **地图每局随机**：开局从 `game.terrain` 和 `view.entities` 读当局的地图，别把坐标写死。PROMPT.md 的「开局地图」一节写了哪些固定、哪些会变。
- **隔着墙时 `dist` 不准**：要按地形算走路的远近，用 `pathDistances(view, from)`。
- **战争迷雾**：有迷雾时只看得见自己单位视野里的东西（资源点除外，一直看得见）。要在远处建造，得先派人过去开视野。
- **分队时**判断敌人要看队伍：`e.owner >= 0 && view.players[e.owner].team !== view.players[view.me].team`。

## 6. 常用全局函数

| 函数 | 用途 |
|---|---|
| `dist(a, b)` | 曼哈顿距离，多格建筑按占地最近的格子算 |
| `pathDistances(view, from)` | 从一个点或实体出发，按地形走到每一格要几步（下标 `y * game.width + x`，走不到是 -1）。整张图算一次，存起来反复用 |
| `canBuild(view, type, x, y)` | 地基能不能放在这里，和引擎的判断一致 |
| `buildProblem(view, type, x, y)` | 同样的检查，返回放不下的原因（放得下是 null） |
| `findBuildSpot(view, type, near, maxRange?, margin?)` | 在某个点附近找能放地基的位置，四周留出走路的空 |
| `console.log(...)` | 写进回放和日志，播放器里能对着画面看 |

## 7. 限制

- **燃料**：每次 `onTick` 最多用 `game.fuel` 燃料（1 燃料大约 5000 次简单循环）。用完这次的命令全部作废。整张图的搜索别每次都做，算一次存起来。
- **出错**：抛错时这次的命令作废，下次照常调用，`view.events` 里有 `botError` 和行号。
- **内存** 128 MB、**单次调用** 2 秒、**整局** 累计 120 秒，超了 bot 停止运行（单位只继续执行已有的命令）。正常代码碰不到。
- **日志**：每次调用最多 20 行、每行 300 字。别打印整个 `view`，又慢又不计燃料。
- **递归**深度大约 1000 层，地图搜索用队列，别用递归。
- 没有 `Date`、网络、文件；时间用 `view.tick`。

## 8. 调试和迭代

在 bot 目录里，每改一版都跑一遍：

```bash
rts-arena check                    # 1. 类型检查 + 每个出生位置试打；报错、被拒命令先修
rts-arena run --games 10 --quiet   # 2. 和 baseline 打 10 局，看胜率和 95% 区间
rts-arena league                   # 3. 和所有参考 bot 循环对打，看输给了谁
rts-arena report                   # 4. 最新一局的战报，重点看「可能的问题」
```

- **看日志**：用 `console.log` 打关键决策（"第 800 tick 进攻，兵力 10"），在播放器里对着画面看，或者看 `replays/` 里你那份 `.log`。
- **看回放**：`rts-arena view --open`，点单位看它在执行什么命令，用「视角」看你的 bot 当时看得见什么。
- **只看开局**：`rts-arena run --ticks 1500` 打到第 1500 tick 就结束，比较不同开局的经济。
- **确认真的变强了**：局数少时误差很大，同一份代码两次联赛能差十几个百分点。用 `rts-arena league --focus --per-pair 10` 只打你的 bot 对每个参考 bot。
- **比较两个版本**：各跑一次，写同一个 `--seed`，对同一个对手用的地图和种子就一样：

```bash
rts-arena league annihilation v1.ts baseline rush boom --focus --per-pair 10 --seed 5
```

```bash
rts-arena league annihilation v2.ts baseline rush boom --focus --per-pair 10 --seed 5
```

- **别只对着 baseline 调**：参考 bot 各有各的打法，有的专门克制某一类。看联赛里输给了谁。

## 9. 常见的坑

| 现象 | 原因和办法 |
|---|---|
| 命令没反应 | 被拒了。看 `view.events` 里的 `rejected`，或者 `run` 输出里的「被拒命令」和日志 |
| 钱不够还在下 `produce` | `view.resources` 是快照，同一次调用里要自己扣钱 |
| 工人突然不干活了 | 矿采完了，`gather` 会变成 `idle`。每次把闲着的工人重新派出去 |
| 一群工人挤在一个矿 | 1×1 的矿上下左右最多站 4 个人，多的在旁边干等。按人数分配到几个矿 |
| 换了张地图就不会打了 | 坐标写死了。路线、集结点、建筑位置都按当局地形算 |
| 远处的地基怎么都放不下 | 那里不在视野里。先派工人走过去，每次用 `buildProblem` 看还差什么 |
| 兵追着一个打不到的目标跑 | 目标隔着墙或水。用 `attackMove`，或者先用 `pathDistances` 判断走不走得到 |
| 射程算错 | 有的规则包会改数值：先看实体的 `stats`，没有再看 `game.types` |
| 燃料耗尽 | 每次都在全图搜索或反复调 `canBuild`。把结果存起来，先用便宜的条件筛掉明显不行的 |

## 10. 让大模型写

把 bot 目录交给编程 agent，提示词可以这样写：

```
请读 PROMPT.md，在 bot.ts 里写一个尽量强的 bot。
每改一版都在这个目录里运行 rts-arena check、rts-arena run --games 10 --quiet、rts-arena league、rts-arena report，看结果再改，至少迭代 5 版。
最后告诉我：跑了哪些命令、最后一版的联赛得分率、对每个参考 bot 的胜负。
```

验收时检查：

- 它报的成绩是不是真的跑出来的：自己在目录里跑一次 `rts-arena league` 对一下；
- `check` 有没有报错、被拒命令是不是 0；
- 代码里有没有写死坐标（换几个种子打，看成绩稳不稳）。
