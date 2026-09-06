# taizan-saas 部署指南

本目录是唯一的部署产物来源。三种部署形态共享同一份 `apps/api/.env.example`
（由 `src/config/env.ts` 的 zod schema 生成，见「env 清单」一节），互不冲突：

```
deploy/
├─ docker/    Dockerfile（api / 前端静态站）、docker-compose.{dev,prod}.yml
├─ pm2/       ecosystem.config.cjs（宝塔 PM2 管理器可直接加载）
├─ nginx/     四站点模板 + snippets（宝塔面板配置文件粘贴用）
├─ scripts/   build-release / remote-deploy / migrate / rollback
└─ checks/    线上只读自检：health / tenant-isolation / billing / ratelimit-spoof / cron-single
```

## 0. env 清单从哪来

**不要手写 `.env`**。清单的唯一真源是 `apps/api/src/config/env.ts` 的 zod schema，
`apps/api/.env.example` 由它自动生成（`pnpm -F @taizan/api taizan:env-example`）。
三把 JWT 密钥必须互不相同、`CRYPTO_KEY_CURRENT` 必须指向 `CRYPTO_KEYS` 里真实
存在的 keyId——这些跨字段校验在启动期就跑，缺字段会中文逐条列出再拒启，不会等到
第一次用到那个字段才炸。

`BILLING_ENFORCE` / `SMS_RETURN_DEV_CODE` / `WECHAT_DEV_FAKE_LOGIN` /
`CLIENT_DEV_LOGIN` 这几个「高风险开关」默认都是 `false`；`NODE_ENV=production`
时打开会被 `assertNoDevCodeInProd` 直接拒启。**打开 `BILLING_ENFORCE` 之前必须先跑
`deploy/checks/billing-check.sh`**，见下面的自检顺序。

## 1. 三种部署形态

### 形态 A：宝塔 + PM2（推荐给单机/中小规模）

```
1. 服务器建站点结构：mkdir -p <APP_DIR>/{releases,shared,ops}
2. 把 apps/api/.env.example 抄一份改成真实值，放到 <APP_DIR>/shared/.env
3. 本机执行：bash deploy/scripts/remote-deploy.sh --host <服务器> --user <账号>
   （内部会依次：build-release.sh 本机打包 → scp 上传 → 远端 pnpm install --prod
     → migrate.sh 预览+应用迁移 → 切 current 软链接 → pm2 reload → 探活）
4. nginx：面板里对每个站点（api / admin / platform / site / client）打开
   「设置 → 配置文件」，整段替换成 deploy/nginx/ 对应的模板（文件头写了具体路径）。
```

首次上线跑一遍 `pm2 save && pm2 startup` 固化开机自启。

### 形态 B：Docker Compose（推荐给容器化环境）

```bash
cp deploy/docker/.env.prod.example .env.prod   # 按文件内说明合并 apps/api/.env.example，再改成真实值
docker build -f deploy/docker/Dockerfile.api -t taizan-api:local .
docker compose -f deploy/docker/docker-compose.prod.yml --env-file .env.prod \
  up -d --scale api=3
```

- `docker-compose.prod.yml` 里的敏感值**不写死在文件里**——数据库密码、Redis
  密码通过 `${VAR:-占位}` 引用，真实值来自 `.env.prod`（不进 git）；
  `api` 服务额外用 `env_file: .env.prod`（`required: false`）整份注入
  `apps/api/.env.example` 清单里的全部业务变量。
- `docker compose -f deploy/docker/docker-compose.prod.yml config` 不需要
  `.env.prod` 也能跑通语法校验（占位默认值顶着）——但那是明文弱密码，
  **绝不能带着占位值真的 `up`**，上线前务必确认 `.env.prod` 已就位。
- nginx 服务用的是 `deploy/docker/nginx-compose.conf`（**不是**
  `deploy/nginx/api.conf`）：同样的安全规则（XFF、健康检查静默、支付回调不缓冲
  改写），但 upstream 是 compose 服务名 `api`（用 `resolver` + 变量做运行时解析，
  不在 nginx 启动那一刻就要求 `api`已经能被解析到，见该文件注释）。
- 前端静态站用 `deploy/docker/Dockerfile.web --build-arg APP=admin|platform|site`
  单独构建镜像，套 `deploy/nginx/{admin,platform,site,client}.conf` 或另起一个
  独立的静态站 nginx 容器都可以——本仓 `docker-compose.prod.yml` 范围只到
  api + mysql + redis + nginx（反代），前端站点的编排留给项目自己决定
  （宝塔静态站 vs 独立容器 vs CDN 直出，三选一都不影响 api 这条链路）。

### 形态 C：混合（Docker 起数据库/中间件，宝塔 + PM2 跑 api，宝塔跑前端静态站）

```
docker compose -f deploy/docker/docker-compose.dev.yml up -d   # 只借它的 mysql/redis，端口 3307/6380
# 之后走形态 A 的步骤，DATABASE_URL / REDIS_URL 指到这两个容器暴露的端口
```

## 2. cluster 为什么是安全的（PM2 / Docker 副本数 > 1）

`deploy/pm2/ecosystem.config.cjs` 默认 `exec_mode: 'cluster'`、`instances: 'max'`。
跟老项目（xiaodian 固定 `fork`、knowledge 要求「cluster 前提是 Redis 可用」）的
差异只有一处根本变化：**cron 不再靠单进程假设活着，靠 Redis leader 锁**
（`@taizan/nest-infra` 的 `@LeaderCron`，见 ecosystem 文件里那段大注释）——
CI 静态扫描（`cluster-safe/scan.ts`）直接把 `@nestjs/schedule` 的 `@Cron` 和裸
`setInterval` 判违规，框架里没有第二条路可以绕开这条约束去写「假装单进程」的定时任务。
`CRON_ENABLED` / `QUEUE_ENABLED` 两个 env 用来把「只跑 HTTP」和「跑任务」两组进程
分开（可选，多数项目不需要），ecosystem 文件里给了两组配置的示例。

## 3. 与老项目部署方式的关键差异

| 项 | 老项目（xiaodian / knowledge） | taizan-saas |
|---|---|---|
| 多实例 | xiaodian 固定 fork；knowledge cluster 但要求 Redis 前提 | cluster 默认开，cron 靠 Redis leader 锁而非「只有一个进程」的假设 |
| 支付回调 | nginx 反代按普通请求处理 | `rawBody: true` 是**装配硬要求**（main.ts 与 e2e 必须用同一段 `configureApp`）；nginx 侧同一 location 刻意不加任何改写请求体的指令 |
| X-Forwarded-For | knowledge 线上真的因为漏配这行被绕过限流（CLAUDE.md 第 6 条） | 本仓全部 nginx 模板都带 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` 并在旁边写了「缺了它会发生什么」；`deploy/checks/ratelimit-spoof-check.sh` 就是打这里 |
| 业务错误的 HTTP 语义 | 视项目而定 | 统一收口：业务错误一律 **HTTP 200 + 7 位业务码**（`{code,message,data}`），只有认证/限流/未知异常走真实 HTTP 状态码——`tenant-isolation-check.sh` 断言的是响应体里的 `code:1240300`，不是 HTTP 403 |
| `/health` | 各自实现 | 裸 JSON（`@RawResponse()`），任一依赖 down → **503**；Nginx/PM2/容器编排按状态码摘流量 |

## 4. 上线前自检顺序

**必须按这个顺序跑，前一项红了不要跳到下一项**：

```bash
# 1. 服务本身活着、依赖都通
bash deploy/checks/health-check.sh --url https://api.example.com/health

# 2. 多租户隔离没有被最近的改动破坏（框架最不能出事的一条红线）
bash deploy/checks/tenant-isolation-check.sh --base https://api.example.com \
  --tenant-a-phone <真实商家A手机号> --tenant-a-password <密码> \
  --tenant-b-phone <真实商家B手机号> --tenant-b-password <密码>

# 3. 打开 BILLING_ENFORCE 之前，看清楚谁会被锁只读、谁会打烊
bash deploy/checks/billing-check.sh --url "$DATABASE_URL"

# 4. 限流没有被 nginx 配置漏改（这条只能从公网打，见脚本里的说明）
bash deploy/checks/ratelimit-spoof-check.sh --base https://api.example.com

# 5. cluster 多实例下 cron 真的只跑了一次
bash deploy/checks/cron-single-check.sh --url "$DATABASE_URL"
```

为什么是这个顺序：health 是「进程活着」的门槛，跑不过后面全白搭；
tenant-isolation 是隔离红线，比计费/限流更优先；billing 决定要不要真的打开一个
高风险开关；ratelimit-spoof 依赖 nginx 已经按新配置生效；cron-single 需要至少
跑过一个调度周期才有数据，放最后。

## 5. 回滚流程

```bash
# 宝塔 + PM2：在服务器上
bash <APP_DIR>/ops/rollback.sh --app-dir <APP_DIR> --ecosystem <APP_DIR>/ecosystem.config.cjs
#   → 把 <APP_DIR>/current 切回上一个 release，pm2 reload，保留最近 5 个 release 目录

# Docker Compose：回滚镜像 tag 再 up -d
docker compose -f deploy/docker/docker-compose.prod.yml --env-file .env.prod \
  up -d --no-deps api   # TAIZAN_IMAGE_TAG 指到上一个已知良好的镜像 tag
```

**回滚不碰数据库**（不 down 迁移、不建反向迁移）——原因写在 `rollback.sh` 脚本内
注释第 3 节：迁移不对称（`DROP COLUMN` 这类破坏性变更回滚等于丢数据）、
回滚的典型场景是「代码有 bug」而不是「数据库结构有问题」、真要撤销某次迁移
必须人工看清楚影响面再手写 SQL。回滚后如确实需要处理数据库，先用
`deploy/scripts/migrate.sh` 同款的 `prisma migrate diff` 预览手法看清楚要撤销的
那次迁移改了什么，再有针对性地处理。

## 6. 已修复问题

`/health` 与 `/docs` 曾经**没有**被排除在 `TenantMiddleware` 之外——不带任何租户
上下文打 `/health`，会先被中间件拦下来返回业务码 `1240400`（HTTP 200，不是
200/503 的 HealthReport 形状），导致监控/负载均衡按状态码摘流量这件事失效
（它们看到的是 HTTP 200，以为一切正常）。

修法：`packages/nest-auth/src/tenant-resolver/tenant.middleware.ts` 的
`TenantMiddleware.use()` 现在先判 `isApiPath(path)`（`strategy.ts` 新增），
不落在 `/api/` 下的路径——`/health`、`/docs`、`/docs-json` 等——直接 `next()`
放行，压根不跑租户解析链；判断依据是「像不像业务 API」而不是某份手抄的路径
白名单，以后加任何新的框架路由都不需要再想起来改一份清单。`TENANT_FREE_PREFIXES`
（`/api/public`、`/api/platform`）语义不变，仍然只管 `/api/*` 内部哪些命名空间
免租户。另外 `packages/nest-core/src/health/health.controller.ts` 补了与
`@taizan/nest-auth` 的 `@Public()` / `@RateLimited('public-default')` 等价的
metadata（手写同名 key，避免 nest-core 反向依赖 nest-auth 成环），保证装了
`GlobalAuthGuard` 的应用里 `/health` 不需要 token 也能被打，同时仍受限流约束。

验证：`bash deploy/checks/health-check.sh <url>` 对修复后的实例返回 HTTP 200 +
`{status:"up",checks:{...}}` 且退出码 0；该脚本里识别 `1240400` 特征的分支保留
为**回归断言**（一旦再出现就判定失败退出，而不是给诊断提示），用于在这类改动
被不小心改回去时尽早发现。

其余未覆盖点：
- `apps/admin`、`apps/platform`、`apps/site` 三个前端尚未落地（仓库目前只有
  `apps/api`、`apps/client`），`deploy/docker/Dockerfile.web` 与
  `deploy/nginx/{admin,platform,site,client}.conf` 按标准 Vite/Taro 产物形状
  预先写好，等这几个 app 长出来即可直接用，未做实际 `docker build` 验证。
- `docker-compose.prod.yml` 完整拉起 `api` 服务需要真实的短信/支付厂商配置——
  参考实现里 `apps/api/src/notify/channels.ts` 故意在 `NODE_ENV=production` 时
  拒绝启用 mock 短信 provider（`assertMockNotInProd`），这是框架的设计意图
  （逼着接入方在上线前换真厂商），不是本任务要修的问题；已验证到「镜像可独立
  运行、模块解析与依赖注入全部正常、env 校验与生产安全闸门按预期触发」这一步。
