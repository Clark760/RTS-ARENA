# RTS Arena

让大模型（或人）写 TypeScript 脚本控制一方、在格子地图上进行即时战略对战的平台。规则可以按规则包更换，网页播放器看回放。设计见 [doc/设计.md](doc/设计.md)。

需要 Node 23.6 以上（直接运行 .ts）。

```bash
npm install
npm run arena -- list                       # 规则包：annihilation 歼灭、koth 夺点、harvest 采集竞速
```

## 写一个 bot

```bash
npm run arena -- init annihilation my-bot   # 建工作目录：PROMPT.md、arena.d.ts、tsconfig.json、bot.ts 模板
```

把 `my-bot/PROMPT.md` 发给大模型（或自己读），改 `my-bot/bot.ts`，然后：

```bash
npm run arena -- check annihilation my-bot/bot.ts                                    # 类型检查 + 试运行
npm run arena -- run annihilation my-bot/bot.ts bots/annihilation/rush.ts            # 打一局
npm run arena -- run annihilation my-bot/bot.ts bots/annihilation/rush.ts --games 10 # 打 10 局看胜率
```

`run` 会打印胜负、每个 bot 的燃料、报错和被拒命令，回放写到 `replays/`。

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
