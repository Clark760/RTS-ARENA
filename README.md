# RTS Arena

让大模型（或人）写 TypeScript 脚本控制一方、在格子地图上进行即时战略对战的平台。规则可以按规则包更换，网页播放器看回放。设计见 [doc/设计.md](doc/设计.md)。

需要 Node 23.6 以上。

## 安装命令

平台装成一个命令 `rts-arena`，每个人只维护自己的 bot 目录，不用拉平台代码。

```bash
git clone https://gitee.com/mingomin/rts-arena.git
cd rts-arena
npm install          # 装依赖并构建（播放器等）
npm install -g .     # 注册全局命令 rts-arena（指向这份克隆，git pull 后就是新版）
```

更新：在克隆目录里 `git pull && npm install`。

注意：不要用 `npm install -g git+https://…` 直接装，npm 从 git 全局安装带构建步骤的包有已知问题，会构建失败。没有仓库权限的人，可以由有权限的人在克隆目录里 `npm pack` 打出 `rts-arena-<版本>.tgz` 发过去，对方 `npm install -g rts-arena-<版本>.tgz`。

```bash
rts-arena list        # 规则包：annihilation 歼灭、koth 夺点、harvest 采集竞速、melee 混战（2～4 人，可分队）
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
rts-arena view                     # 网页播放器看 ./replays 里的回放
```

- `arena.json` 记着这个目录用哪个规则包、bot 是哪个文件；`check`、`run` 会自动带上你的 bot。
- 平台升级后在目录里跑一次 `rts-arena init`，只更新说明书和接口，不动 `bot.ts`。
- 回放和日志写在 `./replays`：每局一个 JSON 回放，外加每个 bot 一份只含它自己信息的日志（`<回放>.P<座位>-<bot 名>.log`），几个 agent 同时跑也分得清。
- 现成的对手：`baseline` 是每个规则包的基准 bot（多数对局能打赢该规则包的其他示例 bot，是衡量新 bot 的标准对手），`idle` 什么都不做；`rts-arena list` 列出全部。
- 多方混战：`rts-arena run 对手1.ts 对手2.ts 对手3.ts --games 8`，同一个种子把座位轮换一遍，报胜场和平均名次。分队加 `--teams 2v2`（按 自己、参数里的顺序 前两个一队、后两个一队），盟友共享视野、按队伍判胜负。
- 不在 bot 目录里也能用完整写法：`rts-arena run melee a.ts b.ts --games 4`、`rts-arena check koth a.ts`。

播放器：空格播放/暂停，←/→ 单步（Shift 一次 50），拖动平移、滚轮缩放，点实体看它的命令，右侧看 bot 日志和报错。

## 写一个规则包

在平台仓库的 `rulesets/<id>/` 下放 `index.ts`（默认导出 `Ruleset`）、`objectives.ts`（导出 `Objectives` 类型）、`RULES.md`（玩法说明）。可以照着 `rulesets/koth/` 改。建议上限见 [doc/设计.md](doc/设计.md#7-建议上限)。

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
