# 用量（Kiki 插件宝）

看你电脑上各个编程 agent（Claude Code、Codex、OpenCode、Gemini CLI、Hermes、Grok、pi 等二十多个）用了多少 token、大约花了多少钱，显示在 [Kiki](https://github.com/lkyxuan/kiki) 总览上的一张卡片里。

背后是开源的 [ccusage](https://github.com/ryoppippi/ccusage)（锁定 20.0.48，从 npm 下载时校验 sha512），读各工具自己存在本机的会话记录，只在本机读，不上传。钱数按公开价格估算，订阅制不是真实账单。

顺带把各工具每段会话最后什么时候动过报给 Kiki（`POST /api/coders/touch`），没装 hook 的工具也能在外部 Agent 面板里看出在不在干活。

## 装
在 Kiki 里贴这个仓库的链接导入，或者在宝库里搜「用量」。装好后跟它说“打开用量”。

## 里面有什么
- `plugin.json`：后台程序 `usage`、总览卡片
- `AGENTS.md`：这个宝负责什么
- `skills/usage/`：脚本 `usage.mjs`（install / loop / once / report / hide / show / off / on）

数据都在 `data/`，导出宝不带。
