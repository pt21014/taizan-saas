/**
 * 起一个装好 `InfraModule` 的最小 Nest 应用。
 *
 * 模拟多实例部署的关键在于：**几个应用共用同一个 Redis 客户端/服务器，
 * 但各有自己的容器与实例 id**——这正是 pm2 cluster / k8s 多副本的形状。
 * 单测里传同一个 `ioredis-mock` 实例给 3 个 `createInfraTestApp()` 就够了。
 *
 * Redis 客户端由调用方传进来（`ioredis-mock` 是本包的 devDependency，
 * 不能从发布产物里 import 它）。
 *
 * @packageDocumentation
 */

import {
  Global,
  Module,
  type INestApplicationContext,
  type Provider,
  type Type,
} from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaService } from '@taizan/nest-prisma'
import { InfraModule } from '../infra.module'
import type { InfraModuleOptions } from '../infra.options'
import type { InfraLogger } from '../logging'
import type { RedisClient } from '../redis/redis-client'
import { createFakeInfraDb, type FakeInfraDb } from './fake-infra-db'

/** 一条日志。 */
export interface RecordedLog {
  level: 'log' | 'warn' | 'error' | 'debug'
  message: string
}

/** 会把日志存下来的日志器，供断言用。 */
export class RecordingLogger implements InfraLogger {
  // process-local: 测试断言用的日志缓冲，只活在单个测试进程里。
  readonly entries: RecordedLog[] = []

  log(message: unknown): void {
    this.entries.push({ level: 'log', message: String(message) })
  }
  warn(message: unknown): void {
    this.entries.push({ level: 'warn', message: String(message) })
  }
  error(message: unknown): void {
    this.entries.push({ level: 'error', message: String(message) })
  }
  debug(message: unknown): void {
    this.entries.push({ level: 'debug', message: String(message) })
  }
  /** 含某段文字的日志。 */
  matching(fragment: string): RecordedLog[] {
    return this.entries.filter((e) => e.message.includes(fragment))
  }
}

/** {@link createInfraTestApp} 的入参。 */
export interface InfraTestAppOptions extends Omit<InfraModuleOptions, 'logger'> {
  /** 业务侧 provider（`@LeaderCron` / `@JobHandler` 所在的类）。 */
  providers?: Provider[]
  /** 共用同一份内存库（模拟多实例连同一个数据库）。不传就各建一份。 */
  db?: FakeInfraDb
  /** 自带的日志器，不传就新建一个 {@link RecordingLogger}。 */
  logger?: RecordingLogger
}

/** 一个已启动的测试应用。 */
export interface InfraTestApp {
  app: INestApplicationContext
  db: FakeInfraDb
  logger: RecordingLogger
  /** 取一个 provider。 */
  get<T>(token: Type<T> | symbol | string): T
  close(): Promise<void>
}

/** 起一个装好 `InfraModule` 的应用（默认关掉 cron/queue 调度，测试自己调 `runTick`）。 */
export async function createInfraTestApp(options: InfraTestAppOptions): Promise<InfraTestApp> {
  const db = options.db ?? createFakeInfraDb()
  const logger = options.logger ?? new RecordingLogger()

  @Global()
  @Module({
    providers: [{ provide: PrismaService, useValue: db.prisma }],
    exports: [PrismaService],
  })
  class FakePrismaModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [
      FakePrismaModule,
      InfraModule.forRoot({
        ...options,
        logger,
        cronEnabled: options.cronEnabled ?? false,
        queueEnabled: options.queueEnabled ?? false,
      }),
    ],
    providers: options.providers ?? [],
  }).compile()

  const app = await moduleRef.createNestApplication().init()

  return {
    app,
    db,
    logger,
    get<T>(token: Type<T> | symbol | string): T {
      return app.get<T>(token)
    },
    close: async (): Promise<void> => {
      await app.close()
    },
  }
}

/** 让 `RedisClient` 的类型在测试里好写一点。 */
export type TestRedisClient = RedisClient
