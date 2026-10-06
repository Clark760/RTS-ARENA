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
rts-arena list        # 规则包：annihilation 歼灭、koth 夺点、harvest 采集竞速、melee 混战（2～4 人，可分队）、frontier 拓荒（工人自己建兵营、箭塔、仓库）、
                      # beacons 烽火台（清野怪、抢台址建烽火台计分）、wild-herd 牧野争牛（驯服游荡的野牛赶回牧栏，2～4 人可分队）、
                      # caravan-raid 劫镖（劫过境的商队押回家交货，2～4 人可分队）、flag-run 夺旗（扛敌旗送回自家旗台，2～4 人可分队）
rts-arena list koth   # 某个规则包的参考 bot 和打法、源码在哪
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
rts-arena run --games 10           # 打 10 局看胜率（每个种子换边各打一次；--quiet 每局只打一行）
rts-arena run 对手.ts              # 和别的 bot 打（写文件路径或现成 bot 的名字）
rts-arena league                   # 联赛：和这个规则包所有现成的 bot 循环对打，出排行榜和对阵表（--size 3 每局 3 人）
rts-arena report                   # 文字战报（最新一局）：双方经济、兵力、建筑的变化，关键事件、战斗、可能的问题（--full 不省略）
rts-arena help run                 # 只看某个命令的用法
rts-arena view                     # 网页播放器：看 ./replays 里的回放，也能在「对战」页开比赛
```

- `arena.json` 记着这个目录用哪个规则包、bot 是哪个文件；`check`、`run` 会自动带上你的 bot。
- 平台升级后在目录里跑一次 `rts-arena init`，只更新说明书和接口，不动 `bot.ts`。
- 回放和日志写在 `./replays`：每局一个 JSON 回放，外加每个 bot 一份只含它自己信息的日志（`<回放>.P<座位>-<bot 名>.log`），几个 agent 同时跑也分得清。
- 现成的对手（参考 bot）：每个规则包带几个不同打法的，放在规则包目录的 `bots/` 里、和规则包一起发布，PROMPT.md 列出了名字和打法（`rts-arena list <规则包>` 也能看）。`baseline` 是均衡的基准 bot，但不一定最强，别只对着它调；`idle` 什么都不做。
- 联赛：`rts-arena league 对手1.ts 对手2.ts --per-pair 4`（不写对手就和所有现成的 bot 打，不含 idle），任意目录里写成 `rts-arena league koth a.ts b.ts c.ts`。默认两两对打、同一对用同一个种子换边。多人局用 `--size K`（比如混战 `rts-arena league melee a.ts b.ts c.ts d.ts e.ts --size 4`）：按 K 人组合分桌（组合超过 20 桌就抽桌，每个 bot 大约上场 6 桌，`--tables M` 可以改），每桌用同一个种子轮换座位打 `--per-table` 局（默认 K 局，正好轮一圈）。名次分：第一名 1 分、最后一名 0 分、中间平分（两人局就是胜 1、平 0.5）；等级分（1500 起）把每局的名次拆成两两比较、按全部对局一起算，和打的先后顺序无关。最后打印排行榜和对阵表，记在回放目录的 `*.series.json` 里。同一个 bot 可以写好几次（名字带 #编号）：同一个 bot 的两份副本之间差多少，就能看出排行榜的误差有多大。最后还会挑出几局「精彩对局」（逆转、优势换手、大战、险胜、爆冷），附上看点和回放文件名，对战页里点「看回放」直接打开。
- 分队联赛（规则包要支持分队，比如混战）：`rts-arena league melee a.ts b.ts c.ts d.ts --teams 2v2`。默认轮换搭档：每桌挑够人数的 bot，所有分组方式都打、两队换位置，每个 bot 拿所在队的名次分，额外出一张搭档表（两个 bot 同队时打了几局、赢了几局），看谁最会配合；`--partners same` 是每队都由同一个 bot 组成（bot 不够一局的人数时自动用这种）。
- 联赛最后还有统计：相邻名次之间的把握度（直接对阵的结果推出"上面的确实更强"有多大把握）、得分率的 95% 区间、每个 bot 每局平均的时长（含胜局时长）、采集、造单位、损失、击杀、拆建筑、燃料，以及报错 / 燃料耗尽 / 被拒 / 停止的总数，各座位的得分率（看地图偏不偏），结束原因的分布。
- 多方混战：`rts-arena run 对手1.ts 对手2.ts 对手3.ts --games 8`，同一个种子把座位轮换一遍，报胜场和平均名次。分队加 `--teams 2v2`（按 自己、参数里的顺序 前两个一队、后两个一队），盟友共享视野、按队伍判胜负。
- `rts-arena run ... --json` 每行输出一个 JSON 事件（start / game / summary / warning / error），方便程序或 agent 读结果；每次 run 还会在回放目录写一份 `*.series.json` 汇总。
- 不在 bot 目录里也能用完整写法：`rts-arena run melee a.ts b.ts --games 4`、`rts-arena check koth a.ts`。

播放器有两个页签：

- **回放**：空格播放/暂停，←/→ 单步（Shift 一次 50），拖动平移、滚轮缩放，点实体看它的命令，右侧看 bot 日志和报错。底栏的「视角」可以按某个玩家（分队时是一队）的视野看：迷雾外的敌人和攻击线不显示，对手的资源也看不到，看到的就是那个 bot 当时知道的东西。
- **对战**：选「比赛」或「联赛」。比赛：选规则包、每个座位的 bot、分队、局数和种子，点开始就在后台跑（就是 `rts-arena run`）。联赛：选每局人数（支持分队的规则包还能选分队和搭档方式）、2～16 个 bot 和每对 / 每桌局数，循环对打（就是 `rts-arena league`），实时显示排行榜（胜平负、平均名次、得分率、等级分）、对阵表、搭档表和统计。bot 直接从下拉框选：这个 bot 目录（含子文件夹）和旁边其他 bot 目录里的 bot 自动列出来（按当前规则包筛），还有现成 bot；别的地方的文件点座位旁边的「选文件…」按钮（下拉框里也有「从电脑选文件…」），选好后要给它起个名字（比如作者的名字），比赛结果和排行榜里就显示这个名字；副本存成回放目录里的 `uploaded-bots/<名字>.ts`，同名但内容不一样时会问你替换还是换个名字，之后也能点「改名」「删除」（只删这份副本，以前的回放不受影响；正在跑的比赛用着的不能删）。也可以「填路径…」。每个规则包上次选的阵容会记住。每局显示赢家，带回放和每个 bot 日志的链接，最后出汇总；历史比赛也能翻看。同一时间只跑一场，可以中途停止。

## 联赛视频

一场联赛打完，可以做成一段视频：片头片尾是平台署名（RTS Arena），中间是标题和用户的一句话、每个选手的介绍（结合文件名和代码风格）、联赛排名、几局精彩对局的回放。介绍和解说由大模型来写，平台负责素材和渲染，用本机的 Chrome 或 Edge 渲染成 MP4（不用装 ffmpeg）。

```bash
rts-arena league annihilation 选手A.ts 选手B.ts 选手C.ts --per-pair 6 --out league
rts-arena video-brief league --out brief.json        # 素材包：选手的文件名、代码风格指标、成绩、精彩对局、脚本模板
# 让大模型照 brief.json 写 script.json（选手介绍、对用户原话的解读、精彩对局的解说）
rts-arena video league --script script.json --out 联赛.mp4 --preview 2,10,40   # 先出几张预览图检查
rts-arena video league --script script.json --out 联赛.mp4 --check 5,60        # 出视频，并从成品里截图检查
```

给大模型（Claude Code 等）用的技能在 [skills/league-video/SKILL.md](skills/league-video/SKILL.md)：复制到 `~/.claude/skills/` 或项目的 `.claude/skills/` 下，跟它说"给这场联赛出个视频"就会按步骤做：拿素材包、读每个选手的代码、分析用户的话和文件名、写脚本、出预览检查、渲染。脚本里的每段文字都有字数上限，格式不对时命令会列出所有问题。

## 写一个规则包

规则包可以放在任意目录，用路径引用（`./my-rules`）。所有规则包（包括平台自带的）都在沙箱里跑，所以大模型写的、别人发来的规则包也可以放心跑。写法见 [src/api/RULESET.md](src/api/RULESET.md)（`new-rules` 会复制一份到目录里）。

```bash
rts-arena new-rules my-rules                       # 建一个能直接跑的示例规则包（采金赛），从它改起
rts-arena check ./my-rules                         # 检查：类型、格式、各种人数试打、打一整局看结束判定
rts-arena run ./my-rules baseline baseline --games 4
rts-arena init ./my-rules my-bot                   # 给它建 bot 目录，之后在 my-bot 里照常 check / run / view
```

- 目录里要有 `index.ts`（默认导出规则包对象）、`objectives.ts`（导出 `Objectives` 类型）、`RULES.md`（玩法说明），参考 bot 放 `bots/`：`baseline.ts` 是基准 bot，再写几个不同打法的陪练（至少 3 个），每个文件第一行写一句打法说明，会列进 PROMPT.md。
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
