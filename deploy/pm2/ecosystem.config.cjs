/**
 * PM2 进程编排（宝塔面板「PM2 管理器」可直接加载本文件）。
 *
 * ── 为什么 cluster 模式在这个框架里是安全的 ──────────────────────────────────
 *
 * 常见的 ecosystem 配置会写死 `exec_mode: 'fork'`，并附一句
 * 「如需多核可改 cluster，但注意 cron 重复触发」——那是因为定时任务用的是
 * `@nestjs/schedule` 的 `@Cron`，这类任务绑在**进程自己的内存定时器**上，
 * cluster 开 4 个实例就是 4 份定时器，同一个任务一次 tick 跑 4 遍
 * （重复发通知、重复扣费、重复生成账单，都是真实事故）。
 *
 * 本框架从一开始就不允许这么写：`packages/nest-infra/src/cluster-safe/scan.ts`
 * 在 CI 里静态扫描，代码里出现 `@nestjs/schedule` 的 `@Cron`/`@Interval`/裸
 * `setInterval` 直接判违规——定时任务只能用 `@taizan/nest-infra` 的 `@LeaderCron`。
 *
 * `@LeaderCron` 的机制（见 `packages/nest-infra/src/cron/`）：
 *   - 每一跳到点，**每个实例**都会尝试对 `taizan:lock:cron:<key>` 抢一把 Redis 锁
 *     （`LockService`，SET NX PX，非阻塞）；
 *   - 抢到锁的那一个才真正执行方法体，其余实例直接跳过这一跳；
 *   - 执行结果落一行 `CronRun`（key + startedAt + instanceId + ok），
 *     `deploy/checks/cron-single-check.sh` 就是查这张表：
 *     「同一个 key、同一个时间窗口，只应该有一条 CronRun」。
 * 也就是说协调点在 **Redis**，不在进程数量——4 个实例、40 个实例，同一跳永远只有
 * 一个真正执行，跟 cluster 开几个 worker 完全无关。**前提只有一个：Redis 必须可达**
 * （`REDIS_URL` 配错，或者 Redis 挂了，抢锁会失败，`LockService` 的行为是「失败关闭」——
 * 宁可这一跳所有实例都不执行，也不会因为抢不到锁就退化成人人都执行）。
 *
 * 队列消费（`@taizan/nest-infra` 的 `@JobHandler` / BullMQ）同理天然是多消费者安全的
 * （消息只会被一个 worker 取走），不需要额外处理。
 *
 * ── CRON_ENABLED / QUEUE_ENABLED：要不要拆「只跑 HTTP」和「跑任务」两组进程 ────
 *
 * 默认（也是本文件下面 `module.exports` 里实际生效的配置）：**不拆**。
 * 一组 `taizan-api` cluster 实例，`CRON_ENABLED=true`、`QUEUE_ENABLED=true`。
 * 理由：既然 leader 锁已经保证了「同一跳只执行一次」，多份实例同时参与抢锁只是
 * 多几次多余的 `SET NX` 请求（Redis 一次操作的量级，可忽略），没有正确性代价。
 * 大多数项目到这一步就够了，不需要再拆进程组。
 *
 * 什么时候值得拆成两组（下面文件末尾给了可直接复制的示例）：
 *   1. 队列里有**吃 CPU 或长耗时**的任务（导出报表、生成海报），不希望它们跟
 *      HTTP 请求抢同一批实例的事件循环，影响接口的响应时间；
 *   2. 想让「跑任务」的那组实例数量与「跑 HTTP」的解耦扩缩容
 *      （HTTP 按并发量走，任务按任务吞吐走，两者不一定成比例）；
 *   3. 想在发布时任务组和 HTTP 组分开 `pm2 reload`，缩短任一边的发布窗口。
 * 拆开之后，`CRON_ENABLED=false` / `QUEUE_ENABLED=false` 的那组实例**完全不参与**
 * 抢锁与消费（见 `cron.scheduler.ts` / `processor.factory.ts` 的判断），
 * 避免「只跑 HTTP 的实例」平白多一份 Redis 轮询和潜在的任务副作用。
 *
 * ── 常用命令 ────────────────────────────────────────────────────────────────
 *   pm2 start deploy/pm2/ecosystem.config.cjs        # 启动
 *   pm2 reload deploy/pm2/ecosystem.config.cjs        # 0 停机滚动重载（见下面 kill_timeout 的说明）
 *   pm2 logs taizan-api --lines 200
 *   pm2 save && pm2 startup                           # 固化进程列表 + 开机自启
 *
 * ── 部署前置 ────────────────────────────────────────────────────────────────
 *   见 deploy/scripts/build-release.sh（本机打包）与 deploy/scripts/remote-deploy.sh
 *   （远端 `pnpm install --prod` + `prisma migrate deploy` + `pm2 reload`）。
 *   `cwd` 必须指向发布目录（release 的当前软链接，见 deploy/scripts/rollback.sh），
 *   `.env` 放在同一目录下，`dotenv/config` 会自动加载（main.ts 首行 import 的那个）。
 */

/** 发布目录（rollback.sh 维护的软链接：<APP_DIR>/current → releases/<时间戳>）。 */
const APP_DIR = process.env.TAIZAN_APP_DIR || '/www/wwwroot/taizan-saas/current'

/** apps/api 的产物相对发布目录的路径（tsup 产物入口，见 apps/api/tsup.config.ts）。 */
const API_ENTRY = 'apps/api/dist/main.js'

/** 三把 JWT 密钥、CRYPTO_KEYS 等敏感值不写在这里——PM2 的 env 字段最终会被
 * `pm2 save` 序列化进 `~/.pm2/dump.pm2`，明文落盘在服务器上。真正的敏感值放
 * `${APP_DIR}/.env`，交给应用自己的 `dotenv/config` 读，这里只放「进程编排」相关、
 * 不敏感、且必须按进程区分的几个开关。 */
const commonEnv = {
  NODE_ENV: 'production',
}

const common = {
  script: API_ENTRY,
  cwd: APP_DIR,
  exec_mode: 'cluster',
  // 起不来就别反复重启刷屏，留时间给人看日志；连续 10 次异常退出才放弃。
  autorestart: true,
  max_restarts: 10,
  min_uptime: '15s',
  // cluster 下单个实例涨到 1G 就重启它，其余实例继续扛流量，用户无感知——
  // 这跟 fork 单进程时设同样的值是完全不同的风险等级，fork 模式这么设会真实中断一次。
  max_memory_restart: '1G',
  // 收到 SIGTERM 之后，Nest 的 `enableShutdownHooks()`（apps/api/src/bootstrap/
  // configure-app.ts）会跑 `onModuleDestroy`，把 Prisma 连接池、Redis 连接、
  // BullMQ worker 关干净。这个过程需要时间——`kill_timeout` 太短的话 PM2 会在
  // 优雅关闭跑完之前发 SIGKILL，等于白做了 enableShutdownHooks 这件事。
  // 8 秒是经验值：连接池关闭通常 1-2 秒内完成，留出余量给「正在处理中的请求」跑完。
  kill_timeout: 8000,
  // 滚动重载时新实例要等它真正监听端口、旧实例还在服务，这个值决定"多久算启动失败"。
  listen_timeout: 8000,
  wait_ready: false,
  merge_logs: true,
  time: true, // 日志每行带时间戳，pino 自己也打时间戳，两者一起便于跟 nginx access log 对时间
  out_file: './logs/pm2/out.log',
  error_file: './logs/pm2/err.log',
}

module.exports = {
  apps: [
    {
      ...common,
      name: 'taizan-api',
      // 'max' = 按 CPU 核数起对应数量的实例。也可以写具体数字（例如线上机器还跑着
      // 别的站点、要给别人留 CPU 时）——可参考一组生产实测数据：
      // 4 实例约 2500 req/s，单实例常驻内存约 140MB，按这个数量级估算要留多少给别的站。
      instances: process.env.PM2_INSTANCES || 'max',
      env: {
        ...commonEnv,
        CRON_ENABLED: 'true',
        QUEUE_ENABLED: 'true',
      },
    },
  ],
}

/**
 * ── 参考：拆成「只跑 HTTP」和「跑任务」两组进程 ──────────────────────────────
 *
 * 需要时把下面这段贴进上面 `module.exports.apps` 数组（替换掉那个单一的
 * `taizan-api` 条目），两组监听同一个端口——PM2 cluster 内建的负载均衡是按
 * `name` 分组的，两个不同 `name` 的 app 各自起各自的端口监听会冲突，
 * 所以「跑任务」那组要么监听不同端口再由 nginx 只转发「只跑 HTTP」那组的端口，
 * 要么（更简单）用 `API_PORT` 环境变量给任务组一个不对外暴露的端口，nginx 完全不转发它。
 *
 * ```js
 * {
 *   ...common,
 *   name: 'taizan-api-web',
 *   instances: process.env.PM2_WEB_INSTANCES || 'max',
 *   env: { ...commonEnv, CRON_ENABLED: 'false', QUEUE_ENABLED: 'false' },
 * },
 * {
 *   ...common,
 *   name: 'taizan-api-worker',
 *   // 任务组不需要跟 HTTP 并发数挂钩，通常 1-2 个实例就够；
 *   // 多个实例仍然安全（cron 靠 leader 锁、队列消费天然多消费者安全），
 *   // 开多个只是为了任务组自己也有滚动重载的窗口。
 *   instances: process.env.PM2_WORKER_INSTANCES || 1,
 *   env: {
 *     ...commonEnv,
 *     CRON_ENABLED: 'true',
 *     QUEUE_ENABLED: 'true',
 *     API_PORT: '3001', // 不对外，nginx 的 upstream 只配 3000
 *   },
 * },
 * ```
 */
