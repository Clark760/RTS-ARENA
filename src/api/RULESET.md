# 写规则包

规则包决定一种玩法：地图、单位数值、开局、怎么计分、怎么判胜负。平台负责其余的一切（移动、战斗、采集、建造、视野、bot 沙箱、回放）。自己写的规则包放在任意目录，用路径引用。所有规则包（包括平台自带的）都在沙箱里运行。

**最重要：写完必须自己跑。** 每改一版都在终端里执行命令、看结果再改：`rts-arena check ./my-rules`（类型、格式、各种人数试打、打一整局看结束判定），`rts-arena league ./my-rules`（参考 bot 循环对打，看各种打法是不是都有胜有负），再用 `rts-arena report` 看战报、`rts-arena view` 看回放。能执行命令就一定要用，不要只读代码就说"能用"；交付时写清楚跑了哪些命令、联赛结果怎样。实在没法执行命令时，请用户代跑、把输出贴回来再改。

## 目录

```
my-rules/
  index.ts        默认导出规则包对象（必需）
  objectives.ts   导出 Objectives 类型：view.objectives 的结构，会原样进 bot 作者拿到的 arena.d.ts（必需）
  RULES.md        给 bot 作者看的玩法说明，会进 PROMPT.md（必需）
  bots/           参考 bot（陪练对手），和规则包一起发布：baseline.ts 是基准 bot，再写几个不同打法的（见「写好之后」）；arena.d.ts 是 bot 用的接口（new-rules 生成）
  api/            平台接口的只读副本（new-rules 生成）：ruleset.ts、standard.ts、bot-api.ts，查字段和函数签名看这里；globals.d.ts 是沙箱里的全局（console）
  tsconfig.json   给编辑器用（new-rules 生成）
```

平台升级、或者改了 objectives.ts 之后，对这个目录再运行一次 `rts-arena new-rules ./my-rules`：只刷新上面标了"new-rules 生成"的文件，不动你写的。

## 命令

动手之前先运行 `rts-arena list` 看看平台自带的规则包和一句话简介，别和它们撞题。

```bash
rts-arena new-rules my-rules          # 建一个能直接跑的示例规则包，从它改起
rts-arena check ./my-rules            # 检查规则包：类型、格式、各种人数试打、打一整局看结束判定
rts-arena docs ./my-rules             # 生成给 bot 作者的 PROMPT.md 和 arena.d.ts
rts-arena run ./my-rules baseline idle --games 4
rts-arena init ./my-rules my-bot      # 给这个规则包建一个 bot 目录（arena.json 里记的是相对路径）
```

路径要写成带 `./` 或斜杠的形式（`./my-rules`），不带的会被当成平台自带规则包的名字。

## 规则包对象

类型从 `"rts-arena/ruleset"` 导入（`import type`），完整定义和注释在目录里的 `api/ruleset.ts`（new-rules 生成的副本）。

```ts
import type { Ruleset } from "rts-arena/ruleset"
import { standardTypes, STANDARD_TERRAIN } from "rts-arena/standard"

const ruleset: Ruleset = {
  id: "my-rules",          // 小写字母开头，只含小写字母、数字、_、-；不能和平台自带的重名
  name: "我的玩法",
  summary: "一句话说清楚玩什么（最多 60 字），rts-arena list 里显示",
  players: { min: 2, max: 2 },
  teams: false,            // 支持 --teams 分队时写 true，并且自己按队伍摆位置、判胜负
  maxTicks: 4000,
  tickRate: 10,            // 回放每秒播多少 tick
  decisionInterval: 5,     // 每几个 tick 调一次 bot
  fuel: 100,               // bot 每次调用的燃料
  unitCap: 30,             // 每人单位上限，0 是不限
  fog: true,               // 战争迷雾
  resources: ["gold"],
  terrain: STANDARD_TERRAIN,
  types: standardTypes(),
  setup(ctx) { ... },      // 开局：地形、实体、初始资源
  onTick(ctx) { ... },     // 可选：每 tick 内核结算完后调用（计分、刷怪、改状态文字）
  objectives(ctx, player) { return { ... } },  // 给 bot 的目标信息，要和 objectives.ts 的类型一致
  result(ctx) { return null },                 // 每 tick 判一次，分出胜负返回 { winner, reason }
  timeUp(ctx) { return { winner: null, reason: "时间到" } },  // 到 maxTicks 还没分出胜负时
}

export default ruleset
```

- **实体类型**（`types`）：`kind` 是 `unit`、`building`、`resource`；单位只能 1×1。数值（生命、造价、生产用时、走一格几 tick、视野、攻击、采集、交货点、能生产、能建造 `builds`）的含义见 `api/ruleset.ts` 的 `TypeSpec` 和 `api/bot-api.ts` 的 `TypeDef`。`look` 决定回放里怎么画：`shape` 是 circle、square、triangle、diamond、hex，`label` 最多 2 个字，`color` 不写就按玩家上色；`name` 是中文名（最多 6 个字，联赛视频的单位图例和战况里用，自己加的类型都写上，不写就显示类型名）。
- **地形**（`terrain`）：每种地形一个字符，`{ walkable, color }`。
- 平台的共用代码 `"rts-arena/standard"`（副本在 `api/standard.ts`）：标准单位 `standardTypes()`、标准地形 `STANDARD_TERRAIN`、两人中心对称地图 `mirror` / `symmetricTerrain` / `spawnMirrored` / `standardStart` / `baseStarts`、四角地图 `rotate90` / `rotateK` / `rotationalTerrain` / `cornersFor`、按种子生成对称随机地图 `randomSymmetricMap`（配套的 `STANDARD_HOME`、`STANDARD_SHAPES`、`STANDARD_OBSTACLE_CHARS`），可以直接用，也可以复制一份改。
- **地图最好每局随机**（平台自带的规则包都是这样）：地图固定的话，bot 会对着这一张图调参数、写死路线，换张图就不行，联赛里同一组对手每局的结果也差不多。在 `setup` 里用 `randomSymmetricMap(ctx.rng, {...})`：给出底图（固定的特殊地形先画好）、要留空的区域（家、目标点……）、随机障碍的块数和形状、随机矿群的范围和阵型、必须走得通的点；它按种子在空地上成套地放障碍和矿（两人图中心对称、四人图四重旋转对称，每家看到的完全一样），再检查关键点和每个矿都走得到、不会绕太远，不合格就换一组重来；实在生成不出来返回 null，这时用你自己的固定布局。只用 `ctx.rng`，同一个种子永远是同一张图。用法照抄平台自带的规则包（比如 `rulesets/annihilation/index.ts`），生成出来的样子用 `rts-arena map <规则包目录> --seed N` 看。
- **新增类型**：在标准单位上加，要给变量标上类型，不然 `kind: "building"` 会被推断成 string：

  ```ts
  import type { TypeSpec } from "rts-arena/ruleset"
  import { standardTypes } from "rts-arena/standard"

  const types: Record<string, TypeSpec> = {
    ...standardTypes(),
    beacon: { kind: "building", w: 2, h: 2, maxHp: 300, cost: { gold: 80 }, buildTicks: 120, sight: 4, look: { shape: "hex", label: "烽", name: "烽火台" } },
    beast: { kind: "unit", maxHp: 200, moveTicks: 4, sight: 4, attack: { damage: 8, range: 1, cooldown: 10 }, look: { shape: "circle", label: "怪", color: "#9b6b3d", name: "野怪" } },
  }
  types.worker.builds = ["barracks", "beacon"]
  ```

## ctx

`setup(ctx)` 拿到的是 `SetupContext`，其余回调拿到的是 `RuleContext`（定义都在 `api/ruleset.ts`）：

- 只能在 setup 里用：`setTerrain(rows)`（每行一个字符串，只能调一次）、`spawn(type, owner, x, y, { amount })`（owner 写 -1 是中立；位置被占会抛错）、`setResources(player, { gold: 200 })`（一次设好几种资源）。
- setup 里也能读局面（`entities()`、`get(id)`、`entitiesIn`、`dist`、`isAlly`、`terrain`，看到的是到目前为止放下的）、用 `spawnNear` 找空位放实体（比自己记哪些格子被占了省事）、用 `remove` 删掉摆好又不要的。
- `spawnNear(type, owner, x, y)` 的找法：(x, y) 放得下就放在那里；否则往外找，(x, y) 落在建筑或资源点里时从它的外圈开始找（所以"主基地旁边放个工人"直接写主基地的坐标就行）；单位的起点落在不能走的地形（水、墙）里时，按距离找最近能站的格子。单位和 1×1 的实体（1×1 的建筑、资源点也是）按走路的步数往外找（不穿墙，最多 8 步；四周都被挡住就找不到），多格的建筑按距离一圈一圈找（最多 8 圈）；同样近的选离地图中心近的，再一样随机挑。要精确控制落点（比如不能把路堵死），自己算好一格空地再传给 spawnNear（放得下就放在那里）。找不到返回 null、什么都不放；setup 里出现这种情况 `rts-arena check` 会提醒。
- `terrain` 是地形，每行一个字符串，`terrain[y][x]` 是 (x, y) 的地形字符，能不能走看你自己定义的 `terrain` 表。buildCheck 里判断"贴着路""在草地上"这类规则时用。
- 编号：玩家编号从 0 开始，命令行、战报、对战页都写成 P0、P1……（和 `view.me`、`ctx.players[i].id` 一样）；队伍编号也从 0 开始，但显示成「队1」「队2」……（「队1」就是队伍 0）。状态文字、叠加层里写玩家时也用 P0 起，免得和平台的输出对不上。
- `teams[p]` 是座位 p 的队伍编号，从 0 开始：命令行、战报、对战页里的「队1」就是队伍 0。不分队时 `teams[p] === p`。命令行和对战页给的分队，同一队的座位总是连在一起、队伍编号按座位从小到大（2v2 是 [0, 0, 1, 1]，3v1 是 [0, 0, 0, 1]）；哪个 bot 坐哪个座位会轮换。
- 读：`seed`（对局种子）、`tick`、`maxTicks`、`playerCount`、`teams`、`isAlly(a, b)`、`width`、`height`、`entities()`（按创建顺序；可以筛选：`entities({ owner: 0, type: "base", kind: "building" })`，不写的项不限）、`get(id)`、`entitiesIn(x, y, w, h)`、`players`（分数、资源、是否在场）、`events`（本 tick 的 died、created、deposit、built）、`dist(a, b)`。
- 写：`addScore(player, n)`、`setScore(player, n)`、`addResource(player, "gold", n)`（一次加一种，和 setResources 不一样）、`spawnNear(type, owner, x, y, { amount })`（找空位刷实体，找不到返回 null）、`remove(id)`（移除：回放和战报里记成"规则包移除"，不算死亡和损失；规则包和 bot 收到的 `died` 事件带 `removed: true`）、`eliminate(player)`（出局：不再调用他的 bot，实体留着，要清掉自己 remove）、`setStatus(text)`（回放顶部的一行字，最多 200 字）。
- 叠加层 `setMarkers([...])`（回放里画，bot 看不到）：区域 `{ kind: "zone", x, y, w, h, owner, label?, color? }`（owner 是玩家编号或 null，按它上色；写了 `color: "#rrggbb"` 就用这个颜色），文字 `{ kind: "label", x, y, text, owner? }`；文字最多 40 字，最多 500 个。每次调用整个替换，不变就不用每 tick 都设。
- 改实体：`setHp(id, hp)`（改到 0 或以下就死，击杀者算 -1）、`setOwner(id, player)`（占领、招降、变成中立 -1；命令变成 idle，生产队列清空不退钱；换主人的那一刻不检查单位上限，之后照常算进新主人的单位数，满了新主人就造不了兵）。回放会记下换主人：播放器按新主人上色，战报的关键事件里有"换主人"。
- **兵种克制**（D-166）：`attack: { damage: 9, range: 1, cooldown: 8, vs: { cavalry: 3 } }` 是打 `cavalry` 时伤害乘 3（四舍五入；倍数 0～10，可以是小数，小于 1 就是打这类吃亏）。bot 从 `game.types` 看到倍数，说明书的单位表和视频的单位图例会自动标出来。倍数不能局中改（`setTypeStats` 改的 damage 照样乘倍数）。例子：自带的「克制歼灭」「克制拓荒」规则包，枪兵克骑兵、骑兵克弓兵、弓兵克枪兵。
- **局中改数值**（科技、增益、光环、地形效果……）：`setTypeStats(player, type, patch)` 改某个玩家（-1 是中立）的某类实体，他已有的和以后造出来的都按新数值，换了主人的实体按新主人的算；`setStats(id, patch)` 在这之上再改单个实体。patch 只写要改的项，值是**改成多少**（不是加减），和之前改过的合并，写原值就是改回去，写 `null` 全部改回原值。能改：`maxHp`（变大时当前生命跟着加上差值，变小时去掉超出的）、`moveTicks`、`sight`、`attack: { damage, range, cooldown }`、`gather: { amount, ticks, capacity }`；原来不能攻击、采集、移动、没有生命的类型不能改出这些能力，取值超范围会抛错。改完 `ctx.entities()` 里实体的 `def` 就是新数值。bot 从实体的 `stats` 字段看到改过的项（`game.types` 还是原值），回放、播放器、视频按新数值画视野和血条。数值什么时候变、变成多少要在 RULES.md 里写清楚（例子：自带的「科技」规则包，建好铁匠铺后战士、弓手伤害 10 → 13，被拆了改回去）。
- **技能、光环、被动**（D-186）：在类型里声明，平台实现冷却、目标检查、光环计算、回血，bot 从 `game.types` 看到、说明书的单位表下面自动列出来、回放和视频会画：
  - `skills: [{ id: "goldmine", name: "点金", cooldown: 600, desc: "在身边造一座 300 金的金矿" }]`（可选 `initialCooldown` 开局冷却、`target: "none" | "point" | "unit"`、`range` 目标最远几格、`cost: { gold: 500 }` 每放一次的造价）。bot 用 `cmd.cast(实体, id, 目标)` 释放；平台检查完（是他的、有这个技能、冷却好了、目标符合 target 和 range、看得见、资源够 cost）调你导出的 `onCast(ctx, { player, unit, skill, x?, y?, target? })`，在里面实现效果（`spawnNear` 刷东西、`addBuff`、`setHp`……）：返回 null 是放成功（开始冷却，平台扣掉 cost），返回字符串是拒绝原因（不扣钱、不进冷却，原样告诉 bot）。onCast 是在执行玩家命令时调的，和 buildCheck 一样每次燃料 400；放成功的技能在这一 tick 的 `events` 里有 `{ kind: "cast", player, unit, skill, ... }`。写了技能却没导出 onCast，所有技能都会被拒。
  - `auras: [{ name: "领主光环", damagePct: 25, defensePct: 25, types: ["soldier", "archer"] }]`：周围 `radius` 格（默认 -1，等于视野）内、`affects`（默认 own，可以是 allies、enemies）、`types`（默认所有单位和建筑）的实体，打出的伤害 +damagePct%、受到的伤害 −defensePct%（负数是减益；`self: true` 自己也吃）。平台每 tick 算，同名的不叠加。
  - `passives: [{ kind: "regen", name: "休养生息", delay: 100, every: 10, amount: 10 }]`：脱战回血，delay 个 tick 没出手、没挨打以后每 every 个 tick 回 amount。
  - `ctx.addBuff(id, { name, damagePct?, defensePct?, ticks? })` 给实体加增益或减益（不写 ticks 是一直有效，同名替换），`removeBuff(id, name)` 去掉，`setSkillCooldown(id, skill, ticks)` 改冷却。实体的 `buffs`、`skillCooldowns` 能读到现在的状态。
  - 播放器和联赛视频会自动画出来：光环范围和扩散的波纹、吃到增益的金环、技能冷却环、放技能（冲击波、射向目标或者同一 tick 刷出来的资源点的光束）和被动回血（绿圈、+N）的特效，不用规则包操心。
  - 打出的伤害 = 原伤害（含克制倍数）×（1 + 攻击方伤害加成合计）×（1 − 挨打方减伤合计），四舍五入，原伤害大于 0 时至少 1；减伤合计最多 90%。例子：自带的「弑君歼灭」「弑君拓荒」规则包的领主（rulesets/common/regicide.ts）。
- **中立实体**（owner -1，比如野怪）：能攻击的闲着时会自动打射程内的玩家实体。玩家的单位不会自动打它们：不管是 idle、普通的 attackMove，还是正挨着中立实体的打，都不会还手，只有 bot 下 `attack` 命令、或者 `attackMove` 写了 `{ neutral: true }`（对手的东西优先）才打（RULES.md 里要提醒 bot 作者）。中立实体之间不会互相打。平时不动，用 `orderNeutral(id, order)` 指挥（只能指挥中立实体，对玩家的实体用会抛错）：`{ kind: "move", x, y }`、`{ kind: "attack", target }`、`{ kind: "attackMove", x, y }`、`{ kind: "stop" }`，命令会一直执行到完成或失效（和 bot 的同名命令一样）。被打死时 `died` 事件的 `killer` 是最后一击的玩家，可以据此给赏金。在 RULES.md 里把中立实体会做什么写清楚。
- **视野**：`isVisible(player, x, y)` 查某一格现在在不在 player 那一队的视野里（没开迷雾时总是 true）。
- **自己的事件**：`note(text, player?)` 往回放和战报的关键事件里写一条（比如 "P0 扛起了 P1 的旗"），player 是这条主要关于谁（不写是所有人）；每 tick 最多 20 条、每条 100 字，整局 2000 条。关键事件里会标"（规则包）"。
- **死亡事件**：`died` 的 `killer` 是最后一击的玩家，-1 表示没有；最后一击是中立实体时 killer 也是 -1，但多一个 `byNeutral: true`。
- **放置限制**：规则包可以导出 `buildCheck(ctx, player, type, x, y)`，玩家放地基时（平台检查完位置之后、扣钱之前；钱够不够在它之后才查）调用：返回 null 允许，返回字符串就拒绝、原样告诉 bot（比如 "烽火台只能建在台址里"）。bot 的 canBuild 不知道这条规则，要在 RULES.md 里写清楚；最好把能放的地方也放进 objectives（比如列出允许的格子或区域），bot 才能自己判断，不然每个 bot 都得把你的规则抄一遍。开了迷雾时注意：平台先要求占地每格都在玩家视野里，不在就直接拒绝（"不在你方视野里"），根本不会问 buildCheck；所以列给 bot 的位置要在玩家一定看得见的地方，或者说明要先派人过去（可以用 `isVisible` 在 objectives 里标出现在能不能建）。
- 随机数用 `ctx.rng`（`next()`、`int(n)`、`shuffle(arr)`），同一个种子结果完全一样。`Math.random` 也按种子确定，但在 setup 之前（规则包的顶层代码里）每局都一样，推荐只用 `ctx.rng`。
- 分数 `players[i].score` 的含义由你定，在 RULES.md 里写清楚；bot 能在 `view.players` 里看到每个人的分数。
- `died` 事件里 `killer` 是最后一击的玩家（-1 表示没有），`unfinished` 表示死的是没建好的建筑。

## 沙箱限制

规则包和 bot 一样跑在沙箱里：

- 只能 import 自己目录里的文件（`./`、`../` 开头）和 `"rts-arena/standard"`；`import type` 随便写（运行时会被擦掉）。只能用"擦掉类型就是 JavaScript"的写法（不能用 enum、namespace）。
- 没有 Date、网络、文件、定时器。`console.log` 打到命令行的标准错误（每次回调最多 20 行、每行 300 字，整局 2000 行），调试用；类型声明在 `api/globals.d.ts`。
- 每一局开始时规则包会重新加载（顶层代码重新执行），顶层变量里的状态不会带到下一局，不用自己在 setup 里清。
- 燃料（1 燃料约 5000 次简单循环）：加载 2000，setup 4000，onTick 和 result 每次各 400，objectives 每次 100，timeUp 1000。每次回调墙钟 2 秒（加载、setup 10 秒），整局累计 120 秒；内存 256 MB。超了就算规则包出错，这一局作废，命令行会说是哪个回调、第几 tick。
- 上限：地图边长 256，玩家 8 人，实体 5000 个，类型 64 种，bot 燃料每次最多 2000；建议上限（地图 128、4 人、600 个实体……）超了只提醒，见 `rts-arena check` 的输出。
- `entities()`、`get()`、`players` 拿到的是快照：改字段没用，存起来下一 tick 也不会更新，每 tick 重新取。同一个回调里先改了局面（`spawn`、`spawnNear`、`remove`、`setOwner`、`setHp`、`setTypeStats`、`setStats`、`addBuff`、`removeBuff`、`setSkillCooldown`、`orderNeutral`）再调 `entities()` / `get()`，拿到的是改过之后的。
- 速度：取全部实体要把它们都传进沙箱（几百个实体约 0.3 毫秒），同一 tick 里的几次回调共用这一份。只关心某些实体时用筛选（`entities({ owner, type, kind })`）或 `entitiesIn`：没取过全部实体时，筛选在沙箱外面做，只传筛出来的，快得多。每 tick 找主基地这种事一定要用筛选。
- `objectives` 的返回值要能转成 JSON，最多 6.4 万字；`result` / `timeUp` 返回 `{ winner, reason }`（可选 `winners`、`ranking`、`stats`），格式不对会报错。
- **自己的统计** `stats`：结果里可以带上规则包自己的指标，每项是按玩家编号排的数组，比如 `{ winner, reason, stats: { 劫到商队: [3, 5], 被抢走: [1, 0] } }`（最多 12 项，名字最长 20 字）。联赛按 bot 累计、显示每局平均，战报也会列出来，用来检查你设计的机制到底有没有发生、谁用得多。在顶层变量里一边打一边记，结束时放进结果就行（每局都会重新加载，不用自己清零）。规则包改归属（setOwner）的次数联赛会自动统计（"换主人"），不用自己记。
- `reason` 里的数字联赛会归一成 N 再归类（"时间到，3105 : 3840" 和 "时间到，2000 : 900" 算一类），但 P1、队2、#3 这样的编号会留着。

## 写好之后

- 在 `bots/` 里写参考 bot（陪练对手），和规则包一起发布：
  - `baseline.ts` 是基准 bot：均衡的标准对手（`rts-arena run` 不写对手就打它）。
  - **再写几个不同打法的**，至少凑够 3 个：比如速攻、先发展后进攻、守家、骚扰工人，或者专打你玩法里某个机制的。只有一个基准 bot 时，写 bot 的人（尤其是大模型）只会对着它反复调，调出来的 bot 换个对手就不行；有几种打法当陪练，联赛的排名才说明问题。new-rules 的模板带了 baseline、rush（速攻）、greedy（只采不打）三个，改了玩法后照着改。
  - 每个 bot 文件的**第一行**写一句打法说明（`// 速攻：……`）。PROMPT.md 会列出所有参考 bot 的名字和这句话，所有写 bot 的人拿到的信息一样，不会有人自己翻目录找到了陪练、别人却不知道。`rts-arena list ./my-rules` 也会列出来。
  - 参考 bot 也是检验玩法的工具：`rts-arena league ./my-rules` 让它们循环对打，某种打法全胜或全败，往往说明玩法本身有问题（比如模板里 greedy 全胜，说明"采金赛"纯拼经济、出兵不划算）。
  - `rts-arena check` 在参考 bot 少于 3 个、有 bot 第一行没写打法、或者 bots/ 里还是模板原样的 bot 时会提醒；改了 objectives.ts 之后它会顺手刷新 bots/arena.d.ts。
- `rts-arena check ./my-rules` 全部通过（它会让 baseline 在第一个、最后一个座位各打一整局不动的对手，再自己打自己一局），`rts-arena run ./my-rules baseline baseline --games 4` 看看胜负是否两边都有、能不能在时间内分出结果，再用 `rts-arena view` 看回放。
- 把整个目录发给别人；对方用 `rts-arena init <目录> <bot 目录>` 就能开始写 bot。别人用你的规则包 run、league 时也会做一次规则包的类型检查，没通过只提醒、不拦比赛。
