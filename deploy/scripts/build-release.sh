#!/bin/bash
# 本机打包：把 @taizan/api 需要的那一小片 monorepo（自身 + 全部 workspace 依赖）
# 裁剪出来、装依赖、编译，产出一个可以直接上传到服务器「解压 + pnpm install --prod +
# pm2 reload」就能跑起来的 release 包。
#
# 为什么不是直接把整个仓库 tar 起来传上去：@taizan/api 依赖十几个 workspace 包
# （nest-core / nest-auth / prisma-base / …），但 admin/platform/site/client/app-*
# 那几个前端 app、每个包的测试与 devDependencies，服务器跑 API 一个都用不上。
# 传整仓要么很慢（monorepo 的 node_modules 一份就是几百 MB），要么逼着在服务器上
# 重新 `pnpm install` 全量依赖——这份脚本用 `turbo prune` 先把范围收窄到
# 「@taizan/api 和它的依赖闭包」，产出天然比整仓小一个数量级。
#
# 跟 `deploy/docker/Dockerfile.api` 是**同一个配方**（都是 turbo prune → install →
# build），区别只是产物形态：Docker 版最终封进镜像，这份封成 tar.gz 给宝塔 + PM2 用。
# 两处都要改的时候记得对着改，别只改一处。
#
# 用法：
#   bash deploy/scripts/build-release.sh                    # 产出 deploy/.releases/taizan-release-<时间戳>.tar.gz
#   bash deploy/scripts/build-release.sh --out /tmp/xxx.tar.gz
#   bash deploy/scripts/build-release.sh --dry-run           # 只打印会执行哪些步骤，不真的跑
#   bash deploy/scripts/build-release.sh --help
#
# 这是「有副作用」的脚本（会真的跑 install/build），不是自检脚本，所以跟
# deploy/checks/*.sh 的写法反过来：这里**要用 set -e**——任何一步失败都必须
# 立刻停下，绝不能拿着编译失败一半的产物继续往下打包上传。
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TS=$(date +%Y%m%d%H%M%S)
OUT_FILE="$REPO_ROOT/deploy/.releases/taizan-release-${TS}.tar.gz"
DRY_RUN=0
PACKAGE_FILTER="@taizan/api"

usage() {
  cat <<'USAGE'
用法：bash deploy/scripts/build-release.sh [选项]

  裁剪 monorepo → pnpm install → turbo build → 打包成 tar.gz。

选项：
  --out <文件路径>   产物路径，默认 deploy/.releases/taizan-release-<时间戳>.tar.gz
  --filter <包名>    要打包的 workspace 包，默认 @taizan/api
  --dry-run          只打印会执行的步骤，不真的跑 install/build/打包
  -h, --help         显示本帮助

产出的 tar.gz 解压后是一份可独立 `pnpm install --prod` 的裁剪 workspace：
  package.json / pnpm-lock.yaml / pnpm-workspace.yaml（裁剪过，只含依赖闭包）
  apps/api/{dist,prisma,prisma.config.ts,package.json}
  packages/<被依赖的包>/{dist,package.json}
不含 node_modules（服务器自己装，保证跟服务器的系统架构/libc 匹配——本机如果是
Windows/macOS 打包，二进制原生模块在服务器上装不了，这也是不能直接把本机
node_modules 一起打包带走的原因）。
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT_FILE="${2:?--out 后面要跟文件路径}"; shift 2 ;;
    --filter) PACKAGE_FILTER="${2:?--filter 后面要跟 workspace 包名}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "❌ 认不出的参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
done

run() {
  echo "+ $*"
  [ "$DRY_RUN" = "1" ] || "$@"
}

PRUNE_DIR="$REPO_ROOT/deploy/.build/prune-out"

echo "=========== 1. 裁剪 workspace（turbo prune $PACKAGE_FILTER） ==========="
run rm -rf "$PRUNE_DIR"
run mkdir -p "$(dirname "$PRUNE_DIR")"
if [ "$DRY_RUN" = "1" ]; then
  echo "+ (cd \"$REPO_ROOT\" && npx turbo@2.10.12 prune \"$PACKAGE_FILTER\" --out-dir \"$PRUNE_DIR\")"
else
  (cd "$REPO_ROOT" && npx --yes turbo@2.10.12 prune "$PACKAGE_FILTER" --out-dir "$PRUNE_DIR")
fi

echo ""
echo "=========== 1.5 修一个已知的 pnpm-workspace.yaml 占位值 ==========="
# 仓库根 pnpm-workspace.yaml 的 allowBuilds 里，`msgpackr-extract` 那一行是一句
# 没填完的占位注释（`msgpackr-extract: set this to true or false`，字面量字符串
# 不是布尔值）。日常开发时 node_modules 已经装好、pnpm install 直接短路成
# "Already up to date"，不会触发这个问题；但在这份「全新裁剪出来的目录」里是一次
# **全新安装**，pnpm 11 对没有明确 allow/deny 的构建脚本会直接把 install 判失败
# （`ERR_PNPM_IGNORED_BUILDS`，逼你先 `pnpm approve-builds`）——不是这份脚本引入的
# 问题，是仓库那一行本来就没写完；根配置不在本任务改动范围内，这里只改**裁剪出来的
# 临时副本**，不动仓库里的原文件。
if [ "$DRY_RUN" != "1" ]; then
  sed -i 's/^\(\s*msgpackr-extract:\).*/\1 true/' "$PRUNE_DIR/pnpm-workspace.yaml"
fi

echo ""
echo "=========== 2. 装依赖（含 devDependencies，编译要用） ==========="
if [ "$DRY_RUN" = "1" ]; then
  echo "+ (cd \"$PRUNE_DIR\" && pnpm install --frozen-lockfile)"
else
  (cd "$PRUNE_DIR" && pnpm install --frozen-lockfile)
fi

echo ""
echo "=========== 3. 生成 Prisma Client + 编译 ==========="
# prisma generate 只要求 DATABASE_URL 这个环境变量「存在」（schema 里
# `url = env("DATABASE_URL")`），不需要真的连得上——本机打包阶段没有生产数据库。
if [ "$DRY_RUN" = "1" ]; then
  echo "+ (cd \"$PRUNE_DIR\" && DATABASE_URL=... pnpm --filter=$PACKAGE_FILTER exec prisma generate)"
  echo "+ (cd \"$PRUNE_DIR\" && pnpm turbo run build --filter=${PACKAGE_FILTER}...)"
else
  (cd "$PRUNE_DIR" && DATABASE_URL="mysql://build:build@build-placeholder:3306/build" \
    pnpm --filter="$PACKAGE_FILTER" exec prisma generate)
  (cd "$PRUNE_DIR" && pnpm turbo run build --filter="${PACKAGE_FILTER}...")
fi

echo ""
echo "=========== 4. 去掉 node_modules 与源码，只留运行时需要的文件 ==========="
# 服务器会自己 `pnpm install --prod`（装出跟服务器同架构/libc 的原生模块），
# 本机的 node_modules 不能带走；src/test 编译产物已经在 dist 里，一并去掉减小体积。
if [ "$DRY_RUN" = "1" ]; then
  echo "+ find \"$PRUNE_DIR\" -maxdepth 4 -type d \( -name node_modules -o -name src -o -name test -o -name .turbo \) -prune -exec rm -rf {} +"
else
  find "$PRUNE_DIR" -maxdepth 4 -type d \( -name node_modules -o -name src -o -name test -o -name .turbo \) -prune -exec rm -rf {} +
fi

echo ""
echo "=========== 5. 打包 ==========="
run mkdir -p "$(dirname "$OUT_FILE")"
if [ "$DRY_RUN" = "1" ]; then
  echo "+ tar -czf \"$OUT_FILE\" -C \"$PRUNE_DIR\" ."
else
  tar -czf "$OUT_FILE" -C "$PRUNE_DIR" .
  echo "✅ 产物：$OUT_FILE（$(du -h "$OUT_FILE" | cut -f1)）"
fi
