#!/bin/bash
# 多租户隔离自检：用两个真实租户的 staff token 交叉访问对方资源，断言拿到 1240300。
#
# 单元测试证明的是「隔离决策函数写对了」；这条脚本证明的是「线上这条链路
# 从登录到中间件到控制器接完，隔离真的生效」——两者不是一回事：中间件顺序装反、
# 某个新控制器忘了走 requireOwned、租户解析策略配错，任何一件都会让单测照样绿、
# 但线上悄悄跨租户泄漏。
#
# 只读：只登录 + GET（示例业务模块 example-goods 的详情接口），不新建/不修改/不删除
# 任何数据；用现有的两个租户各自已有的一条商品记录做交叉访问即可验证。
#
# 断言依据（apps/api/src/modules/example-goods/goods.service.ts 的 requireOwned）：
# 一条记录不属于当前 token 所在的租户（或压根不存在）—— 统一 1240300
# （`CROSS_TENANT_FORBIDDEN`），HTTP 状态码是 **200**（业务错误的传输层语义，
# 见蓝图 §4.9：业务错误 HTTP 200 + 业务码，不是 HTTP 403）。
#
# 用法：
#   bash deploy/checks/tenant-isolation-check.sh --base http://127.0.0.1:3000 \
#     --tenant-a-phone 13800000000 --tenant-a-password 123456 \
#     --tenant-b-phone 13800000001 --tenant-b-password 123456
#   BASE=... TENANT_A_PHONE=... TENANT_A_PASSWORD=... TENANT_B_PHONE=... TENANT_B_PASSWORD=... \
#     bash deploy/checks/tenant-isolation-check.sh
#   bash deploy/checks/tenant-isolation-check.sh --help
#
# 默认凭据是 apps/api/src/seed.ts 造出来的两个演示店店主（本地/CI 常见场景）；
# 生产环境请用 --tenant-a-* / --tenant-b-* 换成两个真实商家账号。
#
# 刻意不用 set -e：某个请求返回非预期状态码是这条脚本最想看到的输出而不是错误，
# set -e 会在第一处就中止，把最该看的后几项跳过。
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:3000}"
LOGIN_PATH="${LOGIN_PATH:-/api/admin/auth/login}"
GOODS_PATH="${GOODS_PATH:-/api/admin/goods}"
TENANT_A_PHONE="${TENANT_A_PHONE:-13800000000}"
TENANT_A_PASSWORD="${TENANT_A_PASSWORD:-123456}"
TENANT_B_PHONE="${TENANT_B_PHONE:-13800000001}"
TENANT_B_PASSWORD="${TENANT_B_PASSWORD:-123456}"

PASS=0
FAIL=0
ok()  { echo "  ✅ $1"; PASS=$((PASS + 1)); }
bad() { echo "  ❌ $1"; FAIL=$((FAIL + 1)); }

usage() {
  cat <<'USAGE'
用法：bash deploy/checks/tenant-isolation-check.sh [选项]

  用两个租户的 staff token 交叉访问对方资源，验证跨租户读取被拦（1240300）。
  只读：只登录 + GET，不新建/不修改/不删除任何数据。

选项：
  --base <URL>              被测 API 地址，默认 http://127.0.0.1:3000（或环境变量 BASE）
  --tenant-a-phone <手机号>   租户 A 的 staff 登录手机号，默认 13800000000（seed 演示店 A 店主）
  --tenant-a-password <密码> 租户 A 的登录密码，默认 123456
  --tenant-b-phone <手机号>   租户 B 的 staff 登录手机号，默认 13800000001（seed 演示店 B 店主）
  --tenant-b-password <密码> 租户 B 的登录密码，默认 123456
  --login-path <路径>        登录接口路径，默认 /api/admin/auth/login
  --goods-path <路径>        用来交叉访问的资源接口前缀，默认 /api/admin/goods
                             （示例业务模块 example-goods；换成别的资源时改这个）
  -h, --help                 显示本帮助

输出四段：
  1. 两个租户分别登录
  2. 各自的资源列表（确认能看到自己的、且互不出现在对方列表里）
  3. 交叉读取：B 用 A 的资源 ID 查详情，必须拿到 1240300
  4. 反过来：A 用 B 的资源 ID 查详情，必须拿到 1240300

退出码：0 全部通过；1 有检查项不通过（可能存在跨租户泄漏，要人看）；2 脚本自身没跑起来
（登录失败、连不上、拿不到任何资源 ID 之类，都算跑不起来而不是"隔离失败"）。
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:?}"; shift 2 ;;
    --tenant-a-phone) TENANT_A_PHONE="${2:?}"; shift 2 ;;
    --tenant-a-password) TENANT_A_PASSWORD="${2:?}"; shift 2 ;;
    --tenant-b-phone) TENANT_B_PHONE="${2:?}"; shift 2 ;;
    --tenant-b-password) TENANT_B_PASSWORD="${2:?}"; shift 2 ;;
    --login-path) LOGIN_PATH="${2:?}"; shift 2 ;;
    --goods-path) GOODS_PATH="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "❌ 认不出的参数：$1（--help 看用法）" >&2; usage >&2; exit 2 ;;
  esac
done

command -v curl >/dev/null 2>&1 || { echo "❌ 没有 curl" >&2; exit 2; }

# 从 JSON 里抠一个字符串字段的值，够用就好，不引入 jq（同 billing-check.sh 的考量：
# 部署环境不一定有 jq，但一定有 curl；这里的 JSON 是自家应用产出的，形状固定）。
j() {
  # $1 = 字段名  $2 = JSON 文本
  echo "$2" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed -E "s/.*:\"([^\"]*)\"/\1/"
}

login() {
  # $1=phone $2=password，输出 access token（失败输出空）
  local resp
  resp=$(curl -s -X POST "${BASE%/}${LOGIN_PATH}" -H 'Content-Type: application/json' \
    --connect-timeout 10 --max-time 20 \
    -d "{\"phone\":\"$1\",\"password\":\"$2\"}")
  j access "$resp"
}

echo "被测地址：$BASE"
echo ""
echo "########## 1. 两个租户分别登录 ##########"
TOKEN_A=$(login "$TENANT_A_PHONE" "$TENANT_A_PASSWORD")
TOKEN_B=$(login "$TENANT_B_PHONE" "$TENANT_B_PASSWORD")

[ -n "$TOKEN_A" ] || { echo "❌ 租户 A（$TENANT_A_PHONE）登录失败，拿不到 token。" >&2; exit 2; }
[ -n "$TOKEN_B" ] || { echo "❌ 租户 B（$TENANT_B_PHONE）登录失败，拿不到 token。" >&2; exit 2; }
echo "  A（$TENANT_A_PHONE）登录成功"
echo "  B（$TENANT_B_PHONE）登录成功"

echo ""
echo "########## 2. 各自的资源列表 ##########"
LIST_A=$(curl -s "${BASE%/}${GOODS_PATH}" -H "Authorization: Bearer $TOKEN_A")
LIST_B=$(curl -s "${BASE%/}${GOODS_PATH}" -H "Authorization: Bearer $TOKEN_B")

ID_A=$(echo "$LIST_A" | grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/')
ID_B=$(echo "$LIST_B" | grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/')

[ -n "$ID_A" ] || { echo "❌ 租户 A 名下一条资源都没有，没有可用于交叉访问的 ID。先跑一次 pnpm seed，或换 --goods-path 指到一个真的有数据的接口。" >&2; exit 2; }
[ -n "$ID_B" ] || { echo "❌ 租户 B 名下一条资源都没有，没有可用于交叉访问的 ID。" >&2; exit 2; }
echo "  A 的一条资源 ID：$ID_A"
echo "  B 的一条资源 ID：$ID_B"

if echo "$LIST_B" | grep -q "\"$ID_A\""; then
  bad "B 的列表接口里出现了 A 的资源 ID——列表查询本身就没做租户过滤"
else
  ok "B 的列表里看不到 A 的资源"
fi
if echo "$LIST_A" | grep -q "\"$ID_B\""; then
  bad "A 的列表接口里出现了 B 的资源 ID——列表查询本身就没做租户过滤"
else
  ok "A 的列表里看不到 B 的资源"
fi

echo ""
echo "########## 3. B 用 A 的资源 ID 查详情 ##########"
RESP=$(curl -s "${BASE%/}${GOODS_PATH}/$ID_A" -H "Authorization: Bearer $TOKEN_B")
CODE=$(echo "$RESP" | grep -o '"code"[[:space:]]*:[[:space:]]*[0-9]*' | head -1 | sed -E 's/.*:[[:space:]]*([0-9]*)/\1/')
if [ "$CODE" = "1240300" ]; then
  ok "B 读 A 的资源 → 1240300（跨租户越权，正确）"
else
  bad "B 读 A 的资源没有拿到 1240300（实际返回：$RESP）——可能存在跨租户读取泄漏"
fi

echo ""
echo "########## 4. 反过来：A 用 B 的资源 ID 查详情 ##########"
RESP=$(curl -s "${BASE%/}${GOODS_PATH}/$ID_B" -H "Authorization: Bearer $TOKEN_A")
CODE=$(echo "$RESP" | grep -o '"code"[[:space:]]*:[[:space:]]*[0-9]*' | head -1 | sed -E 's/.*:[[:space:]]*([0-9]*)/\1/')
if [ "$CODE" = "1240300" ]; then
  ok "A 读 B 的资源 → 1240300（跨租户越权，正确）"
else
  bad "A 读 B 的资源没有拿到 1240300（实际返回：$RESP）——可能存在跨租户读取泄漏"
fi

echo ""
echo "=============================================="
echo "通过 $PASS 项，失败 $FAIL 项"
[ $FAIL -eq 0 ] && echo "🎉 多租户隔离验证全部通过" || echo "⚠️  存在隔离缺陷，必须修复"
[ $FAIL -eq 0 ] || exit 1
