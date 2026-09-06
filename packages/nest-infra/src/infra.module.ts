/**
 * `InfraModule`：把 Redis / 锁 / cron / 队列 / 幂等 / 缓存 / 发件箱接起来。
 *
 * @example
 * ```ts
 * // apps/api/src/bootstrap/app.module.ts
 * InfraModule.forRoot({
 *   redis: new Redis(env.REDIS_URL),
 *   queue: { connection: { host: '127.0.0.1', port: 6379 } },
 *   cronEnabled: env.CRON_ENABLED,
 *   queueEnabled: env.QUEUE_ENABLED,
 *   logger: appLogger,
 *   outbox: true,
 * })
 * ```
 *
 * `@Global()` 的理由与 `PrismaModule` 相同：这些是横切依赖，让每个业务模块逐个
 * `imports: [InfraModule]` 纯属噪音。
 *
 * @packageDocumentation
 */

import {
  Global,
  Inject,
  Logger,
  Module,
  Optional,
  type DynamicModule,
  type OnApplicationShutdown,
  type OnModuleInit,
  type Provider,
} from '@nestjs/common'
import { DiscoveryModule } from '@nestjs/core'
import { HealthRegistry } from '@taizan/nest-core'
import { CacheService } from './cache/cache.service'
import { CronRegistry } from './cron/cron.registry'
import { CronRunRecorder } from './cron/cron-run.recorder'
import { CronScheduler } from './cron/cron.scheduler'
import { IdempotencyService } from './idempotency/idempotency.service'
import { LockService } from './lock/lock.service'
import { OutboxRelay } from './outbox/outbox.relay'
import { OutboxService } from './outbox/outbox.service'
import { BullMqQueueDriver } from './queue/bullmq.driver'
import { DeadLetterService } from './queue/dead-letter.service'
import { JobRegistry } from './queue/job.registry'
import { MemoryQueueDriver } from './queue/memory.driver'
import { ProcessorFactory } from './queue/processor.factory'
import { QueueService } from './queue/queue.service'
import { RedisService } from './redis/redis.service'
import {
  normalizeInfraOptions,
  type InfraModuleOptions,
  type NormalizedInfraOptions,
} from './infra.options'
import {
  INFRA_INSTANCE_ID,
  INFRA_KEY_PREFIX,
  INFRA_LOGGER,
  INFRA_OPTIONS,
  INFRA_REDIS,
  QUEUE_DRIVER,
} from './tokens'
import type { InfraLogger } from './logging'
import type { QueueDriver } from './queue/queue-driver'

@Global()
@Module({})
export class InfraModule implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(QUEUE_DRIVER) private readonly driver: QueueDriver,
    @Inject(INFRA_LOGGER) private readonly logger: InfraLogger,
    @Optional() @Inject(HealthRegistry) private readonly health?: HealthRegistry,
  ) {}

  static forRoot(options: InfraModuleOptions): DynamicModule {
    const normalized = normalizeInfraOptions(options)
    const logger: InfraLogger = options.logger ?? new Logger('InfraModule')

    const providers: Provider[] = [
      { provide: INFRA_OPTIONS, useValue: normalized },
      { provide: INFRA_REDIS, useValue: options.redis },
      { provide: INFRA_KEY_PREFIX, useValue: normalized.prefix },
      { provide: INFRA_INSTANCE_ID, useValue: normalized.instanceId },
      { provide: INFRA_LOGGER, useValue: logger },
      {
        provide: QUEUE_DRIVER,
        useFactory: (): QueueDriver => createQueueDriver(normalized, logger),
      },
      RedisService,
      LockService,
      CronRegistry,
      CronRunRecorder,
      CronScheduler,
      JobRegistry,
      QueueService,
      DeadLetterService,
      ProcessorFactory,
      IdempotencyService,
      CacheService,
    ]

    const exported: NonNullable<DynamicModule['exports']> = [
      INFRA_REDIS,
      INFRA_INSTANCE_ID,
      QUEUE_DRIVER,
      RedisService,
      LockService,
      CronScheduler,
      JobRegistry,
      QueueService,
      DeadLetterService,
      ProcessorFactory,
      IdempotencyService,
      CacheService,
    ]

    if (normalized.outbox) {
      providers.push(OutboxService, OutboxRelay)
      exported.push(OutboxService, OutboxRelay)
    }

    return {
      module: InfraModule,
      // DiscoveryModule 提供 DiscoveryService / MetadataScanner，
      // CronRegistry 与 ProcessorFactory 靠它们扫装饰器。
      imports: [DiscoveryModule],
      providers,
      exports: exported,
    }
  }

  onModuleInit(): void {
    // 注册 redis 探针。HealthRegistry 不在容器里（比如单测的最小装配）时跳过——
    // 探针缺席只影响 /health 的详尽程度，不该让应用起不来。
    this.health?.register(this.redis.healthIndicator)
  }

  async onApplicationShutdown(): Promise<void> {
    await this.driver.close().catch((err: unknown) => {
      this.logger.error(
        `[@taizan/nest-infra] 关闭队列驱动失败：${err instanceof Error ? err.message : String(err)}`,
        undefined,
        'InfraModule',
      )
    })
  }
}

function createQueueDriver(options: NormalizedInfraOptions, logger: InfraLogger): QueueDriver {
  if (options.queue.driver) return options.queue.driver
  if (options.queue.connection) {
    return new BullMqQueueDriver({
      connection: options.queue.connection,
      ...(options.queue.prefix !== undefined ? { prefix: options.queue.prefix } : {}),
    })
  }
  // error 而不是 warn：多实例下「队列只活在本进程」表现为消息凭空消失，
  // 那种故障值得在日志里刺眼一点。
  logger.error(
    '[@taizan/nest-infra] 没有配置 queue.connection，队列退回**进程内内存驱动**。' +
      '多实例部署下消息不会跨进程传递，生产环境必须配 BullMQ 连接。',
    undefined,
    'InfraModule',
  )
  return new MemoryQueueDriver()
}
