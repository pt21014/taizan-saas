#!/usr/bin/env bash
#
# pnpm acceptance —— 框架是否可交付的**唯一判据**（蓝图 §6 的 9 条）。
#
# 这个脚本本身不判断任何业务行为。它只做一件事：把「跑那 9 条」需要的前提
# 一条条摆好，然后把判据交给
# `tools/create-taizan-saas/e2e/acceptance.spec.ts`。
#
# 判据不写在 shell 里，是因为 shell 里的判据没法在 CI 与本地保持同一份：
# workflow 只负责提供环境（MySQL / Redis 容器），「什么算通过」必须是一份
# 能在本地原样跑的测试。
#
#   四步，任一步失败即停：
#     1. 依赖库在线（MySQL 3307 / Redis 6380）
#     2. 构建 packages/* 与生成器 —— dist 是 pnpm pack 的前提，否则打出来的 tarball
#                                 装上去是「能装、一 import 就找不到模块」
#     3. pnpm build:templates:check —— 模板与当前 apps/ 一致（sha256 对账）。
#                                 自然顺序排在 build 之后即可：apps/site 的构建
#                                 曾经会把「今天的日期」写进受版本管理的
#                                 public/sitemap.xml，导致隔天重新 build 就必红，
#                                 一度要把这一步硬塞到 build 之前绕开。现在
#                                 scripts/generate-seo.ts 只写 dist/（构建产物，
#                                 不受版本管理），lastmod 也改取 SITE_LASTMOD /
#                                 git 提交时间，构建不再触碰 apps/ 的任何源文件，
#                                 顺序不必再迁就它。
#     4. pnpm -F create-taizan-saas test:e2e —— 9 条断言
#
#   用法：
#     pnpm acceptance              # 全套，跑完清理临时库与临时目录
#     pnpm acceptance --keep       # 留现场（目录 + 库 + 还在监听的 api 进程地址）
#     pnpm acceptance --skip-build # 跳过第 2 步（上一次 build 还热着的时候）
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

KEEP=0
SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    -h | --help)
      sed -n '2,31p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数：$arg（可用：--keep / --skip-build）" >&2
      exit 2
      ;;
  esac
done

C_CYAN=$'\033[36m'
C_GREEN=$'\033[32m'
C_RED=$'\033[31m'
C_DIM=$'\033[2m'
C_BOLD=$'\033[1m'
C_OFF=$'\033[0m'

STEP=0
step() {
  STEP=$((STEP + 1))
  echo ""
  echo "${C_CYAN}━━ ${STEP}/4 $1 ━━${C_OFF}"
}

# 失败时把「哪一步、怎么单独重跑、怎么看更多」一次说清。中途 set -e 退出也会走到这里。
CURRENT="启动"
fail_hint() {
  local code=$?
  [ "$code" -eq 0 ] && return 0
  echo ""
  echo "${C_RED}${C_BOLD}✘ 验收未通过${C_OFF}  —— 卡在：${CURRENT}"
  echo "${C_DIM}  单独重跑这一步：${HINT:-（见上方输出）}${C_OFF}"
  echo "${C_DIM}  9 条断言的定义：tools/create-taizan-saas/e2e/acceptance.spec.ts${C_OFF}"
  echo "${C_DIM}  留现场排查：      pnpm acceptance --keep${C_OFF}"
  exit "$code"
}
trap fail_hint EXIT

START=$(date +%s)
echo "${C_BOLD}taizan-saas 端到端验收${C_OFF}  —— 蓝图 §6 的 9 条，任一条失败即视为框架未完成"
echo "${C_DIM}仓库 $REPO${C_OFF}"

# ── 1. 依赖库 ────────────────────────────────────────────────────────────────
CURRENT="第 1 步：依赖库在线"
HINT="pnpm dev:infra"
step "检查 MySQL 3307 / Redis 6380 是否在线"

DB_HOST="${ACC_DB_HOST:-127.0.0.1}"
DB_PORT="${ACC_DB_PORT:-3307}"
REDIS_HOST="${ACC_REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${ACC_REDIS_PORT:-6380}"

# 只探 TCP：不假设本机装了 mysql / redis-cli 客户端，也不假设跑在 docker 里
# （CI 里这两个是 GitHub Actions 的 service 容器，`docker ps` 看不到它们）。
probe() {
  node -e '
    const net = require("node:net")
    const [host, port] = [process.argv[1], Number(process.argv[2])]
    const s = net.connect({ host, port })
    s.setTimeout(3000)
    s.on("connect", () => { s.destroy(); process.exit(0) })
    s.on("timeout", () => { s.destroy(); process.exit(1) })
    s.on("error", () => process.exit(1))
  ' "$1" "$2"
}

if probe "$DB_HOST" "$DB_PORT"; then
  echo "  ${C_GREEN}✓${C_OFF} MySQL   ${DB_HOST}:${DB_PORT}"
else
  echo "  ${C_RED}✘${C_OFF} MySQL   ${DB_HOST}:${DB_PORT} 连不上"
  echo ""
  echo "  验收要在**真库**上跑（9 条里有 6 条断言的是数据行为）。先起本地依赖："
  echo "      ${C_BOLD}pnpm dev:infra${C_OFF}"
  echo "  已经起过就看容器状态：docker ps --filter name=taizan-"
  echo "  库不在 3307：ACC_DB_HOST=… ACC_DB_PORT=… ACC_DB_USER=… ACC_DB_PASS=… pnpm acceptance"
  exit 1
fi

if probe "$REDIS_HOST" "$REDIS_PORT"; then
  echo "  ${C_GREEN}✓${C_OFF} Redis   ${REDIS_HOST}:${REDIS_PORT}（验收占 12 号库）"
else
  echo "  ${C_RED}✘${C_OFF} Redis   ${REDIS_HOST}:${REDIS_PORT} 连不上"
  echo ""
  echo "  同上：${C_BOLD}pnpm dev:infra${C_OFF}；换地址用 ACC_REDIS_HOST / ACC_REDIS_PORT。"
  exit 1
fi

# ── 2. build ─────────────────────────────────────────────────────────────────
CURRENT="第 2 步：构建框架包"
HINT="pnpm --filter \"./packages/*\" build && pnpm -F create-taizan-saas build"
if [ "$SKIP_BUILD" -eq 1 ]; then
  STEP=$((STEP + 1))
  echo ""
  echo "${C_DIM}━━ 2/4 构建框架包 —— 按 --skip-build 跳过 ━━${C_OFF}"
else
  step "构建 packages/* 与生成器（dist 是 pnpm pack 的前提）"
  # 只构建**要被打进 tarball 的东西**，不跑根 `pnpm build`：
  # 验收要的是「生成出来的项目能不能跑」，本仓库 apps/ 的产物一个都用不上
  # （生成项目会在临时目录里自己 build 一遍 api）。
  # 本仓库 apps/ 全量构建由 ci.yml 的 unit job 负责，两边不重叠。
  pnpm --filter "./packages/*" build
  pnpm -F create-taizan-saas build
  echo "  ${C_GREEN}✓${C_OFF} 框架包与生成器都有 dist 了"
fi

# ── 3. 模板对账 ──────────────────────────────────────────────────────────────
CURRENT="第 3 步：build:templates:check"
HINT="pnpm build:templates   # 把 apps/ 的改动同步进模板，再重跑验收"
step "build:templates:check（模板与当前 apps/ 的 sha256 对账）"
# 自然顺序：这一步比对的是 apps/ 的当前内容，跟上一步构建 packages/* 互不相干
# （模板快照来自 apps/ 源文件，packages/* 的 dist 不在快照范围内），谁先谁后都一样。
pnpm build:templates:check
echo "  ${C_GREEN}✓${C_OFF} 模板是最新的"

# ── 4. 9 条断言 ──────────────────────────────────────────────────────────────
CURRENT="第 4 步：9 条验收断言"
HINT="pnpm -F create-taizan-saas test:e2e"
step "9 条验收断言（生成项目 → 装依赖 → 迁移 → seed → 起进程 → 逐条断言）"
echo "${C_DIM}  这一步慢：要 pnpm pack 全部框架包、真的装一遍依赖、真的建一个库。${C_OFF}"
if [ "$KEEP" -eq 1 ]; then
  echo "${C_DIM}  --keep：跑完保留临时目录与临时库，api 进程地址会打在最后。${C_OFF}"
  ACCEPTANCE_KEEP=1 pnpm -F create-taizan-saas test:e2e
else
  pnpm -F create-taizan-saas test:e2e
fi

ELAPSED=$(($(date +%s) - START))
CURRENT=""
trap - EXIT
echo ""
echo "${C_GREEN}${C_BOLD}✔ 验收通过：蓝图 §6 的 9 条全绿${C_OFF}   用时 ${ELAPSED}s"
echo "${C_DIM}  判据文件 tools/create-taizan-saas/e2e/acceptance.spec.ts${C_OFF}"
