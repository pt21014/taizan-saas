#!/bin/bash
# 健康检查自检：打 `/health`，任一依赖 down 就非零退出并打印 checks 明细。
#
# `/health` 的形状是定死的（蓝图 §4.11、packages/nest-core/src/health/health.controller.ts）：
#   { status: 'up'|'down', checks: {db:'up'|'down', redis:..., queue:...}, uptime, version, counters }
# **任一** check 是 down，HTTP 状态码就是 503（不是 200 + status:down）——
# Nginx/PM2/容器编排都是按 HTTP 状态码摘流量的，这条脚本首先验证的就是「状态码
# 真的按这个语义在变」，而不只是看 JSON 里的字段。
#
# 只读：只发 GET，不改任何状态。可以放进部署流程的探活步骤，也可以单独定时跑。
#
# 用法：
#   bash deploy/checks/health-check.sh                              # 打 http://127.0.0.1:3000/health
#   bash deploy/checks/health-check.sh --url http://127.0.0.1:3000/health
#   bash deploy/checks/health-check.sh --url https://api.example.com/health
#   bash deploy/checks/health-check.sh --help
#
# 刻意不用 set -e：curl 打到 503 是这条脚本最想看清楚的正常输出之一，
# set -e 会在那一刻就中止，把「哪个 check 具体是 down」这几行最有用的输出跳过。
set -uo pipefail

URL="${TAIZAN_HEALTH_URL:-http://127.0.0.1:3000/health}"

usage() {
  cat <<'USAGE'
用法：bash deploy/checks/health-check.sh [选项]

  打 /health，检查 HTTP 状态码与 checks 明细是否一致；只读，不改任何状态。

选项：
  --url <地址>   健康检查接口地址，默认 http://127.0.0.1:3000/health
                 （或用环境变量 TAIZAN_HEALTH_URL）
  -h, --help     显示本帮助

输出：
  - HTTP 状态码（200 = 全部 up；503 = 至少一项 down）
  - checks 里每一项的 up/down 明细
  - uptime / version

退出码：0 全部 up；1 至少一项 down 或状态码与 checks 内容不一致（属于要人看的异常）；
        2 请求本身失败（连不上，脚本没能真正跑起来）。
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2:?--url 后面要跟地址}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "❌ 认不出的参数：$1（--help 看用法）" >&2; usage >&2; exit 2 ;;
  esac
done

command -v curl >/dev/null 2>&1 || { echo "❌ 没有 curl" >&2; exit 2; }

BODY_FILE=$(mktemp)
trap 'rm -f "$BODY_FILE"' EXIT

HTTP_CODE=$(curl -s -o "$BODY_FILE" -w '%{http_code}' --connect-timeout 5 --max-time 10 "$URL")
CURL_EXIT=$?

echo "被测地址：$URL"

if [ "$CURL_EXIT" -ne 0 ] || [ "$HTTP_CODE" = "000" ]; then
  echo "❌ 连不上（curl 退出码 $CURL_EXIT）。服务没起来，或者地址/端口不对。" >&2
  exit 2
fi

BODY=$(cat "$BODY_FILE")
echo "HTTP 状态码：$HTTP_CODE"
echo "响应体：$BODY"
echo ""

# 不引入 jq 依赖（部署脚本要在「系统有点不对劲」时也能跑，见 billing-check.sh 的
# 同款考量），用 grep/sed 从 JSON 里抠字段——这里的 JSON 是我们自己应用产出的，
# 形状固定，不需要通用 JSON parser 的健壮性。
extract_field() {
  # $1 = 字段名，取 "字段名":"值" 或 "字段名":数字/布尔 的值
  echo "$BODY" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"\?[a-zA-Z0-9_.]*\"\?" | head -1 | sed -E "s/.*:[[:space:]]*\"?([a-zA-Z0-9_.]*)\"?/\1/"
}

STATUS=$(extract_field status)
UPTIME=$(extract_field uptime)
VERSION=$(extract_field version)

echo "=========== checks 明细 ==========="
DOWN_COUNT=0
# 把 "checks":{...} 这一段单独抠出来，再逐个 "name":"up|down" 配对着数。
CHECKS_BLOCK=$(echo "$BODY" | sed -n 's/.*"checks"[[:space:]]*:[[:space:]]*{\([^}]*\)}.*/\1/p')
if [ -z "$CHECKS_BLOCK" ]; then
  if echo "$BODY" | grep -q '"code"[[:space:]]*:[[:space:]]*1240400'; then
    # 回归断言：这条曾经是真实事故——TenantMiddleware 把 /health 当业务路径解析租户，
    # 解析不到就失败关闭抛 1240400，探活拿到「HTTP 200 + 店铺不存在」而不是健康报告。
    # 已修（packages/nest-auth/src/tenant-resolver/{strategy.ts,tenant.middleware.ts}）：
    # 中间件现在先判 isApiPath()，不在 /api/ 下的路径（/health、/docs 等）直接放行，
    # 根本不会走到租户解析这一步。这个分支如果又被触发，说明那道判断被改掉了，
    # 按退出码 1 处理，不是网络问题。
    echo "  ❌ 回归：响应体又是 1240400（无法确定当前店铺），不是 HealthReport。" >&2
    echo "     /health 又被 TenantMiddleware 拦住了——检查 packages/nest-auth/src/tenant-resolver/" >&2
    echo "     tenant.middleware.ts 里 isApiPath(path) 的短路判断是否还在 use() 的最前面。" >&2
    DOWN_COUNT=1
  else
    echo "  ⚠️  响应体里没找到 checks 字段——响应形状跟预期的不一样，脚本可能需要跟着 HealthReport 接口更新。"
  fi
else
  echo "$CHECKS_BLOCK" | grep -o '"[a-zA-Z0-9_]*"[[:space:]]*:[[:space:]]*"[a-z]*"' | while IFS= read -r pair; do
    name=$(echo "$pair" | sed -E 's/"([a-zA-Z0-9_]*)".*/\1/')
    val=$(echo "$pair" | sed -E 's/.*:[[:space:]]*"([a-z]*)"/\1/')
    if [ "$val" = "up" ]; then
      echo "  ✅ $name: up"
    else
      echo "  ❌ $name: $val"
    fi
  done
  DOWN_COUNT=$(echo "$CHECKS_BLOCK" | grep -o '"down"' | grep -c '' || true)
fi
echo ""
echo "uptime: ${UPTIME:-?}s   version: ${VERSION:-?}"
echo ""

echo "=========== 结论 ==========="
EXIT=0
if [ "$HTTP_CODE" = "200" ]; then
  if [ "$STATUS" = "up" ] && [ "${DOWN_COUNT:-0}" = "0" ]; then
    echo "✅ 全部依赖 up，HTTP 200。"
  else
    echo "❌ HTTP 200 但 checks 里有 down（或 status 字段不是 up）——响应码和内容不一致，" >&2
    echo "   按蓝图 §4.11「任一依赖 down 返回 503」，这是不该出现的状态，要看代码而不是网络。" >&2
    EXIT=1
  fi
elif [ "$HTTP_CODE" = "503" ]; then
  echo "❌ HTTP 503：至少一项依赖 down（明细见上面），Nginx/PM2 应该已经把这个实例摘掉了。" >&2
  EXIT=1
else
  echo "❌ 意料之外的状态码 $HTTP_CODE（预期只有 200 或 503）。" >&2
  EXIT=1
fi

exit $EXIT
