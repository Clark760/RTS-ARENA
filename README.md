# RTS Arena

让大模型（或人）写 TypeScript 脚本控制一方、在格子地图上进行即时战略对战的平台。规则可以按规则包更换，网页播放器看回放。设计见 [doc/设计.md](doc/设计.md)。

需要 Node 23.6 以上（直接运行 .ts）。

```bash
npm install
npm run arena -- list                       # 规则包：annihilation 歼灭、koth 夺点、harvest 采集竞速、melee 混战（2～4 人）
```

## 写一个 bot

```bash
npm run arena -- init annihilation my-bot   # 建工作目录：PROMPT.md、arena.d.ts、tsconfig.json、bot.ts 模板
```

把 `my-bot/PROMPT.md` 发给大模型（或自己读），改 `my-bot/bot.ts`，然后：

```bash
npm run arena -- check annihilation my-bot/bot.ts                                    # 类型检查 + 每个位置试打 300 tick
npm run arena -- run annihilation my-bot/bot.ts baseline              # 和基准 bot 打一局
npm run arena -- run annihilation my-bot/bot.ts baseline --games 10    # 打 10 局看胜率
```

`run` 会打印胜负、每个 bot 的燃料、报错和被拒命令，回放写到 `replays/`；每个 bot 还有一份只含它自己信息的日志（`<回放>.P<座位>-<bot 名>.log`），几个 agent 同时跑也分得清。

多方混战：`npm run arena -- run melee a.ts b.ts c.ts d.ts --games 8`，同一个种子会把座位轮换一遍，最后报胜场和平均名次。分队加 `--teams 2v2`（按给出的顺序前两个一队、后两个一队），盟友共享视野、按队伍判胜负。

对手可以写文件路径，也可以写现成 bot 的名字：`baseline` 是每个规则包的基准 bot（多数对局能打赢该规则包的其他示例 bot，是衡量新 bot 的标准对手），`idle` 什么都不做。`npm run arena -- list` 列出每个规则包有哪些现成 bot。

## 看回放

```bash
npm run viewer        # http://127.0.0.1:5180，自动列出 replays/ 里的回放
```

空格播放/暂停，←/→ 单步（Shift 一次 50），拖动平移、滚轮缩放，点实体看它的命令，右侧看 bot 日志和报错。

## 写一个规则包

在 `rulesets/<id>/` 下放 `index.ts`（默认导出 `Ruleset`）、`objectives.ts`（导出 `Objectives` 类型）、`RULES.md`（玩法说明）。可以照着 `rulesets/koth/` 改。`npm run arena -- docs <id>` 生成给 bot 作者的文档。建议上限见 [doc/设计.md](doc/设计.md#7-建议上限)。

## 开发

```bash
npm test              # 测试
npm run typecheck     # 类型检查
npm run bench         # 压测
```
