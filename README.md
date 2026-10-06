# RTS Arena

让大模型（或人）写 TypeScript 脚本控制一方、在格子地图上进行即时战略对战的平台。规则可以按规则包更换，网页播放器看回放。设计见 [doc/设计.md](doc/设计.md)。

需要 Node 23.6 以上。

## 不熟悉代码：双击 start.bat（Windows）

1. 从仓库下载 `start.bat`，放进一个新建的空文件夹（或者下载整个仓库的压缩包解压，用里面的 `start.bat`）。
2. 双击 `start.bat`。没装 Node.js 或 Git for Windows 时，它会打开官网下载页，装好后再双击一次。
3. 第一次运行会自动下载平台、安装依赖、建好自己的 bot 目录 `my-bot`（默认是「歼灭」规则包），然后打开网页播放器。以后再双击就是直接打开播放器。播放器开着的时候别关那个黑窗口。
4. 写 bot：把 `my-bot` 文件夹交给大模型 agent（让它先读 `PROMPT.md`，改 `bot.ts`），或者自己写。网页的「对战」页可以选规则包和 bot 开比赛。
5. 更新平台：关掉播放器窗口，双击平台文件夹里的 `update.bat`。`my-bot` 里的 bot 和回放不会动。

想给 bot 换规则包：在 `my-bot` 里运行 `rts-arena init <规则包>`（只换说明书和接口，不动 `bot.ts`）。下载平台要能访问 gitee 上的仓库。

## 安装命令

平台克隆一次、装成命令 `rts-arena` 之后，每个人只维护自己的 bot 目录，bot 不用放进平台仓库。

```bash
git clone https://gitee.com/mingomin/rts-arena.git
cd rts-arena
npm install          # 装依赖并构建（播放器等）
npm install -g .     # 注册全局命令 rts-arena（指向这份克隆，git pull 后就是新版）
```

更新：在克隆目录里 `git pull && npm install`。

注意：不要用 `npm install -g git+https://…` 直接装，npm 从 git 全局安装带构建步骤的包有已知问题，会构建失败。没有仓库权限的人，可以由有权限的人在克隆目录里 `npm pack` 打出 `rts-arena-<版本>.tgz` 发过去，对方 `npm install -g rts-arena-<版本>.tgz`。

```bash
rts-arena list        # 规则包：annihilation 歼灭、koth 夺点、harvest 采集竞速、melee 混战（2～4 人，可分队）、frontier 拓荒（工人自己建兵营、箭塔、仓库）
```

## 写一个 bot

```bash
mkdir my-bot && cd my-bot
rts-arena init melee          # 建 bot 目录：arena.json、bot.ts 模板、PROMPT.md、arena.d.ts、tsconfig.json
```

把 `PROMPT.md` 发给大模型（或自己读），改 `bot.ts`，然后在这个目录里：

```bash
rts-arena check                    # 类型检查 + 在每个位置上和不动的对手试打 300 tick
rts-arena run                      # 和基准 bot 打一局
rts-arena run --games 10           # 打 10 局看胜率（每个种子换边各打一次）
rts-arena run 对手.ts              # 和别的 bot 打（写文件路径或现成 bot 的名字）
rts-arena report --player 0        # 文字战报（最新一局）：双方经济、兵力、建筑的变化，关键事件、战斗、可能的问题
rts-arena view                     # 网页播放器：看 ./replays 里的回放，也能在「对战」页开比赛
```

- `arena.json` 记着这个目录用哪个规则包、bot 是哪个文件；`check`、`run` 会自动带上你的 bot。
- 平台升级后在目录里跑一次 `rts-arena init`，只更新说明书和接口，不动 `bot.ts`。
- 回放和日志写在 `./replays`：每局一个 JSON 回放，外加每个 bot 一份只含它自己信息的日志（`<回放>.P<座位>-<bot 名>.log`），几个 agent 同时跑也分得清。
- 现成的对手：`baseline` 是每个规则包的基准 bot（多数对局能打赢该规则包的其他示例 bot，是衡量新 bot 的标准对手），`idle` 什么都不做；`rts-arena list` 列出全部。
- 多方混战：`rts-arena run 对手1.ts 对手2.ts 对手3.ts --games 8`，同一个种子把座位轮换一遍，报胜场和平均名次。分队加 `--teams 2v2`（按 自己、参数里的顺序 前两个一队、后两个一队），盟友共享视野、按队伍判胜负。
- `rts-arena run ... --json` 每行输出一个 JSON 事件（start / game / summary / warning / error），方便程序或 agent 读结果；每次 run 还会在回放目录写一份 `*.series.json` 汇总。
- 不在 bot 目录里也能用完整写法：`rts-arena run melee a.ts b.ts --games 4`、`rts-arena check koth a.ts`。

播放器有两个页签：

- **回放**：空格播放/暂停，←/→ 单步（Shift 一次 50），拖动平移、滚轮缩放，点实体看它的命令，右侧看 bot 日志和报错。底栏的「视角」可以按某个玩家（分队时是一队）的视野看：迷雾外的敌人和攻击线不显示，对手的资源也看不到，看到的就是那个 bot 当时知道的东西。
- **对战**：选规则包、每个座位的 bot、分队、局数和种子，点开始就在后台跑（就是 `rts-arena run`）。bot 直接从下拉框选：这个 bot 目录（含子文件夹）和旁边其他 bot 目录里的 bot 自动列出来（按当前规则包筛），还有现成 bot；别的地方的文件点座位旁边的「选文件…」按钮（下拉框里也有「从电脑选文件…」；存一份副本到回放目录的 `uploaded-bots/`），也可以「填路径…」。每个规则包上次选的阵容会记住。每局显示赢家，带回放和每个 bot 日志的链接，最后出汇总；历史比赛也能翻看。同一时间只跑一场，可以中途停止。

## 写一个规则包

规则包可以放在任意目录，用路径引用（`./my-rules`）。所有规则包（包括平台自带的）都在沙箱里跑，所以大模型写的、别人发来的规则包也可以放心跑。写法见 [src/api/RULESET.md](src/api/RULESET.md)（`new-rules` 会复制一份到目录里）。

```bash
rts-arena new-rules my-rules                       # 建一个能直接跑的示例规则包（采金赛），从它改起
rts-arena check ./my-rules                         # 检查：类型、格式、各种人数试打、打一整局看结束判定
rts-arena run ./my-rules baseline baseline --games 4
rts-arena init ./my-rules my-bot                   # 给它建 bot 目录，之后在 my-bot 里照常 check / run / view
```

- 目录里要有 `index.ts`（默认导出规则包对象）、`objectives.ts`（导出 `Objectives` 类型）、`RULES.md`（玩法说明），现成 bot 放 `bots/`（`baseline.ts` 是基准 bot）。
- 能用平台的类型（`import type { Ruleset } from "rts-arena/ruleset"`）和共用代码（`"rts-arena/standard"`：标准单位、对称地图工具），不能 import 别的。燃料、墙钟、内存、地图和实体数都有上限，超了这一局作废并说明原因。
- 平台自带的规则包在仓库的 `rulesets/<id>/`，用名字引用，和自己写的一样在沙箱里跑；想加进平台就照着 `rulesets/koth/` 写。建议上限见 [doc/设计.md](doc/设计.md#7-建议上限)。

## 开发平台

```bash
npm install           # 会顺带构建 dist/
npm run arena -- ...  # 等同于 rts-arena ...，直接跑源码
npm run viewer        # 播放器开发服务器（Vite），看仓库 replays/ 里的回放
npm test              # 测试
npm run typecheck     # 类型检查
npm run build         # 编译到 dist/（装成命令时用的就是它）
npm run bench         # 压测
npm run balance       # 单位数值实验
```
