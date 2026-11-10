#!/bin/sh
# 后台程序入口（plugin.json 的 services）：install 之后才有执行权限，Kiki 才会开它
cd "$(dirname "$0")/../.." && exec "${KIKI_NODE:-node}" skills/usage/usage.mjs loop
