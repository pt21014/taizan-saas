/**
 * BullMQ 真机集成测试。
 *
 * ## 为什么这条 spec 必须连真 Redis
 *
 * BullMQ 的入队脚本用了 Lua 的 `cmsgpack`，而 `ioredis-mock` 的 Lua VM 里没有这个全局对象
 * （`addStandardJob` 直接抛 `attempt to index a nil value (global 'cmsgpack')`）。
 * 也就是说队列的**传输层**在 mock 上根本跑不起来。
 *
 * 语义层（上下文注入、重试、死信、重放）在内存驱动上测（`queue.spec.ts`），
 * 这里补的是「换成真 BullMQ 之后，同样的语义还成立吗」。
 *
 * ## 怎么起 Redis
 *
 * 直接用 `docker run`（redis:7-alpine，端口 **6380**，避开本机可能已经占用的 6379），
 * 而不是 testcontainers：后者会额外拉一个 ryuk 镜像、多一棵不小的依赖树，
 * 而我们要的只是「起一个容器、等它 PING 通、跑完删掉」这三步。
 *
 * 6380 上**已经有 Redis 在跑**时（本机常备的 taizan-redis-dev 就是）直接复用它，
 * 不去抢端口：队列前缀与 key 前缀每轮都带一个随机段，不会和别人的数据串。
 * 只有自己起的容器才会在跑完之后被删掉。
 *
 * **没有 docker 时整个 describe 跳过**，不让 CI 因为环境差异变红——
 * 但本地/CI 有 docker 时它是真的会跑的（跳过与否会打印在结果里）。
 */

import { execFileSync } from 'node:child_process'
import { Injectable } from '@nestjs/common'
import Redis from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { currentContext, runWithContext, type RequestContext } from '@taizan/nest-core'
import { ulid } from '@taizan/contracts'
import type { RedisClient } from '../redis/redis-client'
import { createInfraTestApp, type InfraTestApp } from '../testing/infra-test-kit'
import { DeadLetterService } from './dead-letter.service'
import type { JobEnvelope } from './envelope'
import { JobHandler, type JobProcessor } from './job-handler.decorator'
import { QueueService } from './queue.service'

const REDIS_PORT = 6380
const CONTAINER = 'taizan-nest-infra-test-redis'
const IMAGE = 'redis:7-alpine'

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function dockerAvailable(): boolean {
  try {
    docker('version', '--format', '{{.Server.Os}}')
    return true
  } catch {
    return false
  }
}

const HAS_DOCKER = dockerAvailable()

interface Seen {
  data: unknown
  traceId: string | undefined
  parentTraceId: string | undefined
  tenantId: string | undefined
  attempt: number
}

const seen: Seen[] = []
let failTimes = 0

@Injectable()
@JobHandler({ name: 'bull.ok' })
class BullOkHandler implements JobProcessor<{ n: number }> {
  async process(env: JobEnvelope<{ n: number }>): Promise<void> {
    const ctx = currentContext()
    seen.push({
      data: env.data,
      traceId: ctx?.traceId,
      parentTraceId: ctx?.parentTraceId,
      tenantId: ctx?.tenantId,
      attempt: seen.length + 1,
    })
  }
}

@Injectable()
@JobHandler({ name: 'bull.flaky', attempts: 3, backoff: { type: 'fixed', delayMs: 50 } })
class BullFlakyHandler implements JobProcessor<{ n: number }> {
  async process(env: JobEnvelope<{ n: number }>): Promise<void> {
    const ctx = currentContext()
    seen.push({
      data: env.data,
      traceId: ctx?.traceId,
      parentTraceId: ctx?.parentTraceId,
      tenantId: ctx?.tenantId,
      attempt: seen.length + 1,
    })
    if (failTimes > 0) {
      failTimes -= 1
      throw new Error('三方接口 502')
    }
  }
}

function makeContext(traceId: string): RequestContext {
  return { traceId, ip: { client: '1.2.3.4', edge: '1.2.3.4' }, startedAt: Date.now() }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('等待超时')
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** 6380 上有没有一个能 PING 通的 Redis。 */
async function redisReachable(): Promise<boolean> {
  const probe = new Redis({
    host: '127.0.0.1',
    port: REDIS_PORT,
    lazyConnect: true,
    connectTimeout: 800,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  })
  try {
    await probe.connect()
    return (await probe.ping()) === 'PONG'
  } catch {
    return false
  } finally {
    probe.disconnect()
  }
}

describe.skipIf(!HAS_DOCKER)('BullMQ 驱动（docker 真 Redis :6380）', () => {
  let app: InfraTestApp
  let raw: Redis
  /** 自己起的容器才由自己删。 */
  let startedContainer = false
  /** 每次跑用不同前缀：既避免上一轮遗留的 job 干扰，也避免和复用的那台 Redis 上别人的数据串。 */
  const prefix = `taizan-test-${ulid().slice(-8)}`

  beforeAll(async () => {
    if (await redisReachable()) {
      // 6380 上已经有 Redis（本机常备的 taizan-redis-dev），复用它，不抢端口
      startedContainer = false
    } else {
      docker('run', '-d', '--rm', '--name', CONTAINER, '-p', `${REDIS_PORT}:6379`, IMAGE)
      startedContainer = true
      await waitFor(redisReachable, 30_000)
    }

    raw = new Redis({ host: '127.0.0.1', port: REDIS_PORT, maxRetriesPerRequest: null })
    await waitFor(() => raw.status === 'ready', 30_000)

    app = await createInfraTestApp({
      redis: raw as unknown as RedisClient,
      providers: [BullOkHandler, BullFlakyHandler],
      // key 前缀也带随机段：万一复用的是别人的 Redis，锁与缓存不会串
      prefix: `${prefix}:`,
      queue: { connection: { host: '127.0.0.1', port: REDIS_PORT }, prefix },
      queueEnabled: true,
    })
  }, 60_000)

  afterAll(async () => {
    await app?.close()
    await raw?.quit().catch(() => undefined)
    if (startedContainer) {
      try {
        docker('rm', '-f', CONTAINER)
      } catch {
        // --rm 已经收了
      }
    }
  }, 30_000)

  it('用的是 bullmq 驱动，不是内存驱动', () => {
    expect(app.get(QueueService).driverKind).toBe('bullmq')
  })

  // 用例 ⑤（真 BullMQ）
  it('worker 开新 traceId，parentTraceId == 入队时 traceId，tenantId == originTenantId', async () => {
    seen.length = 0
    await runWithContext(makeContext('REQ-BULL-1'), async () => {
      await app.get(QueueService).add('bull.ok', { n: 1 }, { tenantId: 'TENANT-BULL' })
    })
    await waitFor(() => seen.length >= 1)

    const first = seen[0]!
    expect(first.data).toEqual({ n: 1 })
    expect(first.parentTraceId).toBe('REQ-BULL-1')
    expect(first.traceId).toBeTypeOf('string')
    expect(first.traceId).not.toBe('REQ-BULL-1')
    expect(first.tenantId).toBe('TENANT-BULL')
  })

  // 用例 ④（真 BullMQ）
  it('失败 attempts 次后进 JobDeadLetter，replay 后重新执行并标 resolvedAt', async () => {
    seen.length = 0
    failTimes = 99
    await runWithContext(makeContext('REQ-BULL-DL'), async () => {
      await app.get(QueueService).add('bull.flaky', { n: 7 }, { tenantId: 'T-BULL-9' })
    })

    // 处理器声明了 attempts: 3，QueueService 会从 JobRegistry 里读到它
    await waitFor(() => app.db.rows('JobDeadLetter').length >= 1, 30_000)
    expect(seen).toHaveLength(3)

    const row = app.db.rows('JobDeadLetter')[0]!
    expect(row['jobName']).toBe('bull.flaky')
    expect(row['originTenantId']).toBe('T-BULL-9')
    expect(row['attempts']).toBe(3)
    expect(String(row['lastError'])).toContain('三方接口 502')
    expect(row['resolvedAt']).toBeUndefined()

    seen.length = 0
    failTimes = 0
    await app.get(DeadLetterService).replay(String(row['id']))
    await waitFor(() => seen.length >= 1)

    expect(seen[0]?.data).toEqual({ n: 7 })
    expect(seen[0]?.tenantId).toBe('T-BULL-9')
    expect(app.db.rows('JobDeadLetter')[0]?.['resolvedAt']).toBeInstanceOf(Date)
  }, 60_000)

  it('分布式锁在真 Redis 上同样只放一个持有者', async () => {
    const { LockService } = await import('../lock/lock.service')
    const lock = app.get(LockService)
    let inside = 0
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        lock.withLock('real-redis-demo', 3000, async () => {
          inside += 1
          await new Promise((r) => setTimeout(r, 120))
          return 'ok'
        }),
      ),
    )
    expect(inside).toBe(1)
    expect(results.filter((r) => r !== null)).toEqual(['ok'])
  })
})

describe.skipIf(HAS_DOCKER)('BullMQ 驱动（跳过说明）', () => {
  it('本机没有 docker，BullMQ 真机集成测试已跳过（语义层仍由 queue.spec.ts 覆盖）', () => {
    expect(HAS_DOCKER).toBe(false)
  })
})
