---
name: usage
description: 装 ccusage、看各个编程 agent 的 token 和花费、隐藏某个工具、开关后台读用量。用户问“AI 花了多少”“某某用了多少”时用。
---

# 看外部 Agent 用量

脚本：`node skills/usage/usage.mjs <命令>`，在宝目录里跑。

## 装
用量宝是 Kiki 自带的，后台程序第一次跑会自己下载 ccusage，一般不用管。用户问起读了什么：ccusage 读这台电脑上各工具自己存的会话记录，只在本机读、不上传。

`install`（下载不下来时手动跑看报错）：下载锁定版本的 ccusage（20.0.48，从 npm 下这个平台的可执行文件包，校验 sha512，对不上就不装）到 `bin/ccusage`，马上读一次 30 天，再让 Kiki 开后台程序（每分钟读今天，每 30 分钟读 30 天）。升级版本要改脚本里的 `CCUSAGE_VERSION` 和 `CCUSAGE_SHA512`（npm 上每个平台包的 `dist.integrity`）。

## 看用量
`report [天数]`：过去几天按工具合计，默认 7 天，最多 30。读的是后台存下的，想要最新的先跑 `once`。
告诉用户时说清楚：钱数按公开价格估算，订阅制不是真实账单。

## 隐藏 / 重新算
`hide <工具>` / `show <工具>`，工具写 ccusage 的名字（claude、codex、hermes……）或显示名（Claude Code、Codex……）都行。隐藏的工具也不再报最后活动时间。

## 开关
`off`：停掉后台程序，不再读（重启 Kiki 也不会自己开）。`on`：重新打开。用户也可以在设置「用量」页里点开关。

## 出问题
- 卡片写“读不出来”：跑 `once` 看报错。
- 看 `data/logs/usage.log`。
- `bin/ccusage` 没有：再跑 `install`。
