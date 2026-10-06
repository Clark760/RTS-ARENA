# 写规则包

规则包决定一种玩法：地图、单位数值、开局、怎么计分、怎么判胜负。平台负责其余的一切（移动、战斗、采集、建造、视野、bot 沙箱、回放）。自己写的规则包放在任意目录，用路径引用。所有规则包（包括平台自带的）都在沙箱里运行。

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

- **实体类型**（`types`）：`kind` 是 `unit`、`building`、`resource`；单位只能 1×1。数值（生命、造价、生产用时、走一格几 tick、视野、攻击、采集、交货点、能生产、能建造 `builds`）的含义见 `api/ruleset.ts` 的 `TypeSpec` 和 `api/bot-api.ts` 的 `TypeDef`。`look` 决定回放里怎么画：`shape` 是 circle、square、triangle、diamond、hex，`label` 最多 2 个字，`color` 不写就按玩家上色。
- **地形**（`terrain`）：每种地形一个字符，`{ walkable, color }`。
- 平台的共用代码 `"rts-arena/standard"`（副本在 `api/standard.ts`）：标准单位 `standardTypes()`、标准地形 `STANDARD_TERRAIN`、两人中心对称地图 `mirror` / `symmetricTerrain` / `spawnMirrored` / `standardStart` / `baseStarts`、四角地图 `rotate90` / `rotateK` / `rotationalTerrain` / `cornersFor`，可以直接用，也可以复制一份改。
- **新增类型**：在标准单位上加，要给变量标上类型，不然 `kind: "building"` 会被推断成 string：

  ```ts
  import type { TypeSpec } from "rts-arena/ruleset"
  import { standardTypes } from "rts-arena/standard"

  const types: Record<string, TypeSpec> = {
    ...standardTypes(),
    beacon: { kind: "building", w: 2, h: 2, maxHp: 300, cost: { gold: 80 }, buildTicks: 120, sight: 4, look: { shape: "hex", label: "烽" } },
    beast: { kind: "unit", maxHp: 200, moveTicks: 4, sight: 4, attack: { damage: 8, range: 1, cooldown: 10 }, look: { shape: "circle", label: "怪", color: "#9b6b3d" } },
  }
  types.worker.builds = ["barracks", "beacon"]
  ```

## ctx

`setup(ctx)` 拿到的是 `SetupContext`，其余回调拿到的是 `RuleContext`（定义都在 `api/ruleset.ts`）：

- 只能在 setup 里用：`setTerrain(rows)`（每行一个字符串，只能调一次）、`spawn(type, owner, x, y, { amount })`（owner 写 -1 是中立；位置被占会抛错）、`setResources(player, { gold: 200 })`（一次设好几种资源）。
- setup 里也能读局面（`entities()`、`get(id)`、`entitiesIn`、`dist`、`isAlly`，看到的是到目前为止放下的）和用 `spawnNear` 找空位放实体，比自己记哪些格子被占了省事。
- `teams[p]` 是座位 p 的队伍编号，从 0 开始：命令行、战报、对战页里的「队1」就是队伍 0。不分队时 `teams[p] === p`。
- 读：`seed`（对局种子）、`tick`、`maxTicks`、`playerCount`、`teams`、`isAlly(a, b)`、`width`、`height`、`entities()`（按创建顺序；可以筛选：`entities({ owner: 0, type: "base", kind: "building" })`，不写的项不限）、`get(id)`、`entitiesIn(x, y, w, h)`、`players`（分数、资源、是否在场）、`events`（本 tick 的 died、created、deposit、built）、`dist(a, b)`。
- 写：`addScore(player, n)`、`setScore(player, n)`、`addResource(player, "gold", n)`（一次加一种，和 setResources 不一样）、`spawnNear(type, owner, x, y, { amount })`（找空位刷实体，找不到返回 null）、`remove(id)`、`eliminate(player)`（出局：不再调用他的 bot，实体留着，要清掉自己 remove）、`setStatus(text)`（回放顶部的一行字，最多 200 字）。
- 叠加层 `setMarkers([...])`（回放里画，bot 看不到）：区域 `{ kind: "zone", x, y, w, h, owner, label?, color? }`（owner 是玩家编号或 null，按它上色；写了 `color: "#rrggbb"` 就用这个颜色），文字 `{ kind: "label", x, y, text, owner? }`；文字最多 40 字，最多 500 个。每次调用整个替换，不变就不用每 tick 都设。
- 改实体：`setHp(id, hp)`（改到 0 或以下就死，击杀者算 -1）、`setOwner(id, player)`（占领、招降、变成中立 -1；命令变成 idle，生产队列清空不退钱；换主人的那一刻不检查单位上限，之后照常算进新主人的单位数，满了新主人就造不了兵）。回放会记下换主人：播放器按新主人上色，战报的关键事件里有"换主人"。
- **中立实体**（owner -1，比如野怪）：能攻击的闲着时会自动打射程内的玩家实体；玩家的单位不会自动打它们（bot 要用 attack 命令）。中立实体之间不会互相打。平时不动，用 `orderNeutral(id, order)` 指挥（只能指挥中立实体，对玩家的实体用会抛错）：`{ kind: "move", x, y }`、`{ kind: "attack", target }`、`{ kind: "attackMove", x, y }`、`{ kind: "stop" }`，命令会一直执行到完成或失效（和 bot 的同名命令一样）。被打死时 `died` 事件的 `killer` 是最后一击的玩家，可以据此给赏金。在 RULES.md 里把中立实体会做什么写清楚。
- **放置限制**：规则包可以导出 `buildCheck(ctx, player, type, x, y)`，玩家放地基时（平台检查完位置之后、扣钱之前；钱够不够在它之后才查）调用：返回 null 允许，返回字符串就拒绝、原样告诉 bot（比如 "烽火台只能建在台址里"）。bot 的 canBuild 不知道这条规则，要在 RULES.md 里写清楚。
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
- `entities()`、`get()`、`players` 拿到的是快照：改字段没用，存起来下一 tick 也不会更新，每 tick 重新取。同一个回调里先改了局面（`spawn`、`spawnNear`、`remove`、`setOwner`、`setHp`、`orderNeutral`）再调 `entities()` / `get()`，拿到的是改过之后的。
- 速度：取全部实体要把它们都传进沙箱（几百个实体约 0.3 毫秒），同一 tick 里的几次回调共用这一份。只关心某些实体时用筛选（`entities({ owner, type, kind })`）或 `entitiesIn`：没取过全部实体时，筛选在沙箱外面做，只传筛出来的，快得多。每 tick 找主基地这种事一定要用筛选。
- `objectives` 的返回值要能转成 JSON，最多 6.4 万字；`result` / `timeUp` 返回 `{ winner, reason }`（可选 `winners`、`ranking`），格式不对会报错。

## 写好之后

- 在 `bots/` 里写参考 bot（陪练对手），和规则包一起发布：
  - `baseline.ts` 是基准 bot：均衡的标准对手（`rts-arena run` 不写对手就打它）。
  - **再写几个不同打法的**，至少凑够 3 个：比如速攻、先发展后进攻、守家、骚扰工人，或者专打你玩法里某个机制的。只有一个基准 bot 时，写 bot 的人（尤其是大模型）只会对着它反复调，调出来的 bot 换个对手就不行；有几种打法当陪练，联赛的排名才说明问题。new-rules 的模板带了 baseline、rush（速攻）、greedy（只采不打）三个，改了玩法后照着改。
  - 每个 bot 文件的**第一行**写一句打法说明（`// 速攻：……`）。PROMPT.md 会列出所有参考 bot 的名字和这句话，所有写 bot 的人拿到的信息一样，不会有人自己翻目录找到了陪练、别人却不知道。`rts-arena list ./my-rules` 也会列出来。
  - 参考 bot 也是检验玩法的工具：`rts-arena league ./my-rules` 让它们循环对打，某种打法全胜或全败，往往说明玩法本身有问题（比如模板里 greedy 全胜，说明"采金赛"纯拼经济、出兵不划算）。
  - `rts-arena check` 在参考 bot 少于 3 个、或者有 bot 第一行没写打法时会提醒。
- `rts-arena check ./my-rules` 全部通过（它会让 baseline 在第一个、最后一个座位各打一整局不动的对手，再自己打自己一局），`rts-arena run ./my-rules baseline baseline --games 4` 看看胜负是否两边都有、能不能在时间内分出结果，再用 `rts-arena view` 看回放。
- 把整个目录发给别人；对方用 `rts-arena init <目录> <bot 目录>` 就能开始写 bot。别人用你的规则包 run、league 时也会做一次规则包的类型检查，没通过只提醒、不拦比赛。
