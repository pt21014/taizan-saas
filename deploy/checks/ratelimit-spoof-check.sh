#!/bin/bash
# 限流伪造自检：**验证伪造 X-Forwarded-For 绕不过限流**。
#
# 它回答的问题只有一个：
#   「攻击者每次换一个 X-Forwarded-For 前缀，还能不能无限次地打我们的登录接口。」
#
# 这不是假想的攻击。knowledge 线上真的被这么绕过去过（CLAUDE.md 第 6 条）：
#
#   链路是 客户端 → EdgeOne → nginx → Node，nginx 用 $proxy_add_x_forwarded_for 追加，
#   所以 XFF 开头几段是客户端自己写的、可任意伪造（实测过：伪造后限流 key 直接变成
#   伪造值，限流形同虚设）。可信的只有末尾由基础设施追加的段，段数由 TRUSTED_PROXY_HOPS
#   控制（当前 2）。
#
# 单测能证明 resolveIps 这个函数是对的，但证明不了**线上这条链路**是对的：
# nginx 的反代配置漏了 X-Forwarded-For、CDN 换了一层、TRUSTED_PROXY_HOPS 配错了一位数，
# 这三件事任何一件都会让限流回到「形同虚设」，而代码一个字都没改。所以这一条只能从公网打。
#
# **只读**：它只发失败的登录请求，不写任何数据，随时可以跑。
# 代价是跑完之后本机 IP 在那个窗口内会被限住（属预期，等窗口过期自动恢复）。
#
# 用法：
#   bash deploy/checks/ratelimit-spoof-check.sh --base https://api.example.com
#   BASE=https://api.example.com bash deploy/checks/ratelimit-spoof-check.sh
#   bash deploy/checks/ratelimit-spoof-check.sh --path /api/admin/auth/login --limit 10
#   bash deploy/checks/ratelimit-spoof-check.sh --help
#
# 刻意不用 set -e：下面几段里「某个请求返回非 0 状态」是正常输出而不是错误，
# set -e 会在第一处就中止，把最该看的后几项跳过——有问题时反而检查得更少。
set -uo pipefail

BASE=${BASE:-}
LOGIN_PATH=${LOGIN_PATH:-/api/admin/auth/login}
# 与 @taizan/ratelimit-core 的 login 档一致：clientLimit=10。
# 改了那边的数值，这里也要改，否则这个脚本会在「其实是对的」的时候报红。
CLIENT_LIMIT=${CLIENT_LIMIT:-10}
BODY=${BODY:-'{"username":"ratelimit-spoof-check","password":"definitely-wrong-on-purpose"}'}

PASS=0
FAIL=0
ok() {
  echo "  ✅ $1"
  PASS=$((PASS + 1))
}
bad() {
  echo "  ❌ $1"
  FAIL=$((FAIL + 1))
}

usage() {
  cat <<'USAGE'
用法：bash deploy/checks/ratelimit-spoof-check.sh [选项]

  从公网发若干次「注定失败」的登录请求，验证限流拦得住，且伪造 X-Forwarded-For 绕不过去。
  只读，不写任何数据。

选项：
  --base <URL>     被测站点，形如 https://api.example.com（必填，也可用环境变量 BASE）
  --path <路径>    登录接口路径，默认 /api/admin/auth/login
  --limit <次数>   login 档的客户端 IP 额度，默认 10（要与 ratelimit-core 的 clientLimit 一致）
  -h, --help       显示本帮助

输出四段：
  1. 连通性（打不通就没必要往下走）
  2. 轮换伪造 IP：必须出现 429
  3. 伪造与不伪造共用同一个限流桶：伪造过之后，诚实请求也应当已经被限住
  4. 429 响应的形状：必须带 Retry-After，且响应体是 {"code":1042900,...} 的统一信封

退出码：0 全部通过；1 有检查项不通过（限流可能被绕过，要人看）；2 脚本自身没跑起来。
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --base)
      BASE=${2:-}
      shift 2
      ;;
    --path)
      LOGIN_PATH=${2:-}
      shift 2
      ;;
    --limit)
      CLIENT_LIMIT=${2:-}
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "❌ 未知参数：$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$BASE" ]; then
  echo "❌ 没给 --base。要打的是**公网入口**（带 CDN 那条真实攻击路径），" >&2
  echo "   打 127.0.0.1:3000 是测不出问题的：那条路上根本没有 CDN 与 nginx 追加的那几段。" >&2
  exit 2
fi

command -v curl >/dev/null 2>&1 || {
  echo "❌ 没有 curl" >&2
  exit 2
}

URL="${BASE%/}${LOGIN_PATH}"

# 发一次注定失败的登录。$1 = X-Forwarded-For 的值（空则不带这个头）。
# 输出「状态码 空格 Retry-After」。
post() {
  local headers=()
  [ -n "${1:-}" ] && headers=(-H "X-Forwarded-For: $1")
  curl -s -o /tmp/rl-body.$$ -D /tmp/rl-head.$$ -w '%{http_code}' \
    -X POST "$URL" -H 'Content-Type: application/json' \
    --connect-timeout 10 --max-time 20 \
    "${headers[@]}" -d "$BODY"
}

retry_after() {
  grep -i '^retry-after:' /tmp/rl-head.$$ 2>/dev/null | tr -d '\r' | awk '{print $2}'
}

cleanup() { rm -f /tmp/rl-body.$$ /tmp/rl-head.$$; }
trap cleanup EXIT

echo "被测入口：$URL"
echo "login 档客户端额度：$CLIENT_LIMIT 次/窗口"
echo ""

echo "########## 1. 连通性 ##########"
FIRST=$(post "")
if [ "$FIRST" = "000" ]; then
  echo "  ❌ 连不上 $URL（DNS / 证书 / 防火墙？）" >&2
  exit 2
fi
echo "  首次请求返回 $FIRST"
if [ "$FIRST" = "429" ]; then
  echo "  ⚠️  一上来就是 429：上一轮自检的窗口还没过，等窗口过期再跑（login 档默认 5 分钟）。"
  exit 2
fi
ok "接口通"

echo ""
echo "########## 2. 每次换一个伪造 IP，尝试绕过限流 ##########"
echo "  手法：X-Forwarded-For: 10.0.0.N, 172.16.9.N —— 攻击者能往开头塞任意段"
CODES=""
SPOOF_429=0
for i in $(seq 1 $((CLIENT_LIMIT + 4))); do
  CODE=$(post "10.0.0.$i, 172.16.9.$i")
  CODES="$CODES $CODE"
  [ "$CODE" = "429" ] && SPOOF_429=1
done
echo "  返回码序列:$CODES"
if [ $SPOOF_429 -eq 1 ]; then
  ok "轮换伪造 IP 仍然被拦下（出现 429）——限流 key 没有被伪造值带偏"
else
  bad "轮换伪造 IP 一次都没被拦。限流很可能取了 XFF 的开头段：查 TRUSTED_PROXY_HOPS 与 nginx 的 proxy_set_header"
fi

echo ""
echo "########## 3. 伪造与不伪造共用同一个桶 ##########"
echo "  上一段已经把额度打满了。此时**不带**伪造头再打一次，应当同样被拦——"
echo "  两者若分属两个桶，就说明伪造头确实改变了限流 key。"
HONEST=$(post "")
echo "  不带伪造头的返回码：$HONEST"
if [ "$HONEST" = "429" ]; then
  ok "诚实请求与伪造请求落在同一个限流桶里"
else
  bad "伪造过之后诚实请求仍未被限（返回 $HONEST）——伪造头把限流 key 换掉了"
fi

echo ""
echo "########## 4. 429 的形状 ##########"
if [ "$HONEST" = "429" ] || [ $SPOOF_429 -eq 1 ]; then
  LAST=$(post "")
  RA=$(retry_after)
  BODY_TXT=$(cat /tmp/rl-body.$$ 2>/dev/null)
  echo "  Retry-After: ${RA:-<无>}"
  echo "  响应体: $(echo "$BODY_TXT" | head -c 200)"
  if [ -n "$RA" ]; then
    ok "带了 Retry-After（客户端与 CDN 靠它决定什么时候重试）"
  else
    bad "429 没带 Retry-After：客户端只能盲目重试，等于把限流变成了持续压力"
  fi
  if echo "$BODY_TXT" | grep -q '1042900'; then
    ok "响应体是统一信封，业务码 1042900"
  else
    bad "响应体里没有 1042900（前端那一行 httpSemantic(code)===429 会判不出来）"
  fi
  [ "$LAST" = "429" ] || echo "  ⚠️  最后一次返回 $LAST（窗口可能刚好翻页，可忽略）"
else
  echo "  跳过：前面根本没触发过 429"
fi

echo ""
echo "=============================================="
echo "通过 $PASS 项，失败 $FAIL 项"
echo ""
echo "说明：本机 IP 现在处于被限状态，属预期。额度只按窗口过期恢复（login 档 5 分钟），"
echo "      期间用这个 IP 登录会被拦——换个网络或等窗口过去即可。"
[ $FAIL -eq 0 ] || exit 1
