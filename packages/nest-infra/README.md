# @taizan/nest-infra

集群安全的基础设施层（蓝图 §4.7 / §4.11 / §8 第 12 条）。

老项目 knowledge 线上有一条活故障：pm2 cluster 起 4 个进程，`order-close.service.ts` /
`profit-sharing.service.ts` 里的裸 `setInterval` 于是每 30 秒同时跑 4 遍——同一笔订单被关 4 次、
同一笔分账被发起 4 次。这不是「浪费点 CPU」，是**重复的对外副作用**。本包就是那条故障的根治面。

| 机制 | 入口 | 守的问题 |
| --- | --- | --- |
| 分布式锁 | `LockService.withLock` | 同一段临界区多实例同时进 |
| leader cron | `@LeaderCron` + `CronScheduler` | 同一个定时任务多实例同时跑 |
| 幂等 | `IdempotencyService.run` | 同一个请求 / 回调被处理两次 |
| 队列 + 死信 | `QueueService` / `DeadLetterService` | 失败任务无声消失 |
| 租户前缀缓存 | `CacheService` | 跨租户脏读 |
| 事务发件箱 | `OutboxService` / `OutboxRelay` | 写库成功但消息丢了 |
| 静态约束扫描 | `scanClusterSafety` | 以上约定被绕过而没人发现 |

## 装配

```ts
// apps/api/src/bootstrap/app.module.ts
import Redis from 'ioredis'
import { InfraModule } from '@taizan/nest-infra'

InfraModule.forRoot({
  redis: new Redis(env.REDIS_URL),
  // BullMQ 要**连接选项**，不要传现成的 ioredis 实例：worker 的阻塞命令会把共用连接堵住
  queue: { connection: { host: '127.0.0.1', port: 6379 } },
  cronEnabled: env.CRON_ENABLED,
  queueEnabled: env.QUEUE_ENABLED,
  logger: appLogger,
  outbox: true,
})
```

`CRON_ENABLED` / `QUEUE_ENABLED` 不在 `@taizan/nest-core` 的 `BASE_ENV_SCHEMA` 里（那是别的包的契约，
本包不改它）。把 `INFRA_ENV_SHAPE` 合进项目自己的 env schema 即可：

```ts
export const APP_ENV_SCHEMA = defineEnvSchema(BASE_ENV_SCHEMA, { ...INFRA_ENV_SHAPE })
```

不传这两个选项时退化成直接读 `process.env`（默认都开），最小装配也能跑。

## 用法速览

```ts
// 定时任务：4 个实例同一秒醒来，只有一个真正执行
@LeaderCron({ key: 'plan-expire-notify', cron: '0 9 * * *', lockTtlMs: 300_000, watchdog: true })
async run(): Promise<void> { ... }

// 队列：入队时封信封（traceId 是发起方的），worker 里自动换成新 traceId + parentTraceId
await queue.add('goods.sync', { goodsId }, { tenantId })

@JobHandler({ name: 'goods.sync', concurrency: 5, attempts: 5 })
class GoodsSyncHandler implements JobProcessor<Payload> {
  async process(env: JobEnvelope<Payload>): Promise<void> { ... }
}

// 幂等：并发同 key 只执行一次
const { fresh, result } = await idem.run('pay.notify.wechat', transactionId, () => handle())

// 缓存：key 是 t:{tenantId}:{ns}:{k}；无租户上下文且 ns 不以 platform: 开头 → 直接抛
await cache.set('goods', id, dto, 60)
await cache.set('platform:plan', id, dto, 300) // 平台级放行
```

## 几个刻意的决定

- **抢不到 leader 锁就跳过，不排队。** 排队等于把并发推迟到下一秒，而 cron 的语义本来就是
  「到点做一次」。
- **cron 用 `setTimeout` 逐次重排，不用 `setInterval`。** cron 表达式的间隔不是固定的
  （夏令时那天 `0 9 * * *` 之间隔的是 23 或 25 小时）。这是本包唯一允许出现调度定时器的地方。
- **Redis 不可用就响亮地失败**，不像老项目那样静默退回进程内存。降级的代价是限流额度变成
  「额度 × 进程数」、锁变成「每个进程都是 leader」，而日志里只有一行 warn。
- **幂等结果本体存 Redis，不落表。** `IdempotencyKey` 表只有 `resultHash`——那些结果里最常见的
  就是支付回调原文，落库等于把三方报文明文摊在一张谁都能查的表上。
- **cron 库选 `cron-parser` v5（不是 croner）。** 我们只需要「给定表达式和当前时间，算下一次什么时候」，
  调度与 leader 选举必须握在自己手里；croner 自带调度反而要绕开它一半的功能。

## 测试

```bash
pnpm -F @taizan/nest-infra lint && pnpm -F @taizan/nest-infra typecheck \
  && pnpm -F @taizan/nest-infra test && pnpm -F @taizan/nest-infra build
```

多实例是这样模拟的：**同一个 `ioredis-mock` 实例 + 同一份内存库 + 三个各自独立的 Nest 应用**——
这正是 pm2 cluster / k8s 多副本的形状（共享外部状态，各有各的进程内状态）。

### BullMQ 为什么另起一条 docker spec

BullMQ 的入队脚本用了 Lua 的 `cmsgpack`，`ioredis-mock` 的 Lua VM 里没有这个全局对象，
`addStandardJob` 直接抛 `attempt to index a nil value (global 'cmsgpack')`。也就是说队列的
**传输层**在 mock 上根本跑不起来。

所以分两层：

- **语义层**（上下文注入、重试、死信、重放）用 `MemoryQueueDriver` 测（`queue.spec.ts`）——
  这一层的代码两个驱动完全共用；
- **传输层**用 `bullmq.integration.spec.ts` 连真 Redis 测，端口 **6380**（避开可能被占用的 6379）。
  6380 上已经有 Redis 在跑时直接复用（本机常备的 `taizan-redis-dev` 就是），否则自己
  `docker run --rm redis:7-alpine` 起一个、跑完删掉。队列前缀与 key 前缀每轮都带随机段，不会串数据。
  **没有 docker 时这个 describe 整体跳过**，CI 不会因为环境差异变红。

没用 testcontainers：它会额外拉一个 ryuk 镜像、多一棵不小的依赖树，而我们要的只有
「起容器 → 等 PING 通 → 删掉」三步。

### `cluster-safe.spec.ts`（蓝图 §8 spec 12）

扫描器导出在 `@taizan/nest-infra/testing`，T0-8 的全仓 spec 与 T4-2 的生成器模板**直接复用**，
不要各写一遍正则：

```ts
import { collectSourceFiles, scanClusterSafety, formatViolations } from '@taizan/nest-infra/testing'

const violations = scanClusterSafety(collectSourceFiles(resolve(root, 'src')))
expect(violations, formatViolations(violations)).toEqual([])
```

四条规则与它们的豁免方式：

| 规则 | 豁免 |
| --- | --- |
| 禁止裸 `setInterval` / `setTimeout` 做业务调度 | 白名单文件，或 `// cluster-safe-allow: 理由` |
| 禁止 `@nestjs/schedule` 的 `@Cron` / `@Interval` / `@Timeout` | 无（必须改 `@LeaderCron`） |
| 一次性凭据（state / nonce / ticket / once）禁止 `get(` | `// cluster-safe-allow: 理由` |
| 长驻的 `new Map()` / `new Set()`（模块级或类字段） | `// process-local: 理由` |

spec 里带**防假通过哨兵**：先用一组人造坏代码喂给扫描器，确认每条规则都真的报得出来，
再扫本包源码断言零违规。没有前半截的话，正则写错时后半截会永远绿，而绿的原因是「什么都没匹配到」。

## 已知未覆盖

- BullMQ 的**并发度**（`concurrency`）与**延迟投递**（`delayMs`）只有类型与透传，没有专门的行为断言。
- `MemoryQueueDriver` 顺序执行，不模拟并发；`concurrency` 在它上面是空转。
- 真实的「进程被 kill」用「拿了锁不释放」模拟，没有真起子进程再 kill。
- 死信的查看 / 重放接口（`apps/api/src/modules/platform/job/`）属于 T2-1 的应用侧，不在本包。
