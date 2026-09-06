import { Injectable } from '@nestjs/common'
import RedisMock from 'ioredis-mock'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { currentContext, runWithContext, type RequestContext } from '@taizan/nest-core'
import type { RedisClient } from '../redis/redis-client'
import { createInfraTestApp, type InfraTestApp } from '../testing/infra-test-kit'
import { DeadLetterService } from './dead-letter.service'
import type { JobEnvelope } from './envelope'
import { JobHandler, type JobProcessor } from './job-handler.decorator'
import { MemoryQueueDriver } from './memory.driver'
import { ProcessorFactory } from './processor.factory'
import { QueueService } from './queue.service'

interface Seen {
  data: unknown
  /** 执行上下文里的 traceId（每次执行都是新的）。 */
  traceId: string | undefined
  /** 执行上下文里的 parentTraceId（= 信封上的 traceId，即入队方那次）。 */
  parentTraceId: string | undefined
  tenantId: string | undefined
  /** 信封自己的 parentTraceId（入队方的上游，重放时指向被重放的那次）。 */
  envParentTraceId: string | undefined
}

/** 三个处理器共用的观察窗。测试进程只有一个，直接用模块级变量。 */
const seen: Seen[] = []
let failTimes = 0

@Injectable()
@JobHandler({ name: 'demo.ok', concurrency: 2 })
class OkHandler implements JobProcessor<{ n: number }> {
  async process(env: JobEnvelope<{ n: number }>): Promise<void> {
    const ctx = currentContext()
    seen.push({
      data: env.data,
      traceId: ctx?.traceId,
      parentTraceId: ctx?.parentTraceId,
      tenantId: ctx?.tenantId,
      envParentTraceId: env.parentTraceId,
    })
  }
}

@Injectable()
@JobHandler({ name: 'demo.flaky', attempts: 3, backoff: { type: 'fixed', delayMs: 5 } })
class FlakyHandler implements JobProcessor<{ n: number }> {
  async process(env: JobEnvelope<{ n: number }>): Promise<void> {
    const ctx = currentContext()
    seen.push({
      data: env.data,
      traceId: ctx?.traceId,
      parentTraceId: ctx?.parentTraceId,
      tenantId: ctx?.tenantId,
      envParentTraceId: env.parentTraceId,
    })
    if (failTimes > 0) {
      failTimes -= 1
      throw new Error('三方接口 502')
    }
  }
}

@Injectable()
@JobHandler({ name: 'demo.ok' })
class DuplicateNameHandler implements JobProcessor {
  async process(): Promise<void> {}
}

function makeContext(traceId: string, tenantId?: string): RequestContext {
  return {
    traceId,
    tenantId,
    ip: { client: '1.2.3.4', edge: '1.2.3.4' },
    startedAt: Date.now(),
  }
}

describe('队列', () => {
  let client: RedisClient
  let driver: MemoryQueueDriver
  let app: InfraTestApp

  beforeEach(async () => {
    seen.length = 0
    failTimes = 0
    client = new RedisMock() as unknown as RedisClient
    driver = new MemoryQueueDriver()
    app = await createInfraTestApp({
      redis: client,
      providers: [OkHandler, FlakyHandler],
      queue: { driver },
      queueEnabled: true,
    })
  })

  afterEach(async () => {
    await app.close()
  })

  // 用例 ⑤
  it('worker 开新 traceId，parentTraceId == 入队时的 traceId，tenantId == originTenantId', async () => {
    const queue = app.get(QueueService)
    await runWithContext(makeContext('REQ-TRACE-0001'), async () => {
      await queue.add('demo.ok', { n: 1 }, { tenantId: 'TENANT-A' })
    })
    await driver.drain()

    expect(seen).toHaveLength(1)
    const first = seen[0]!
    expect(first.data).toEqual({ n: 1 })
    expect(first.parentTraceId).toBe('REQ-TRACE-0001')
    expect(first.traceId).toBeTypeOf('string')
    expect(first.traceId).not.toBe('REQ-TRACE-0001')
    expect(first.tenantId).toBe('TENANT-A')
  })

  it('不传 tenantId 就是平台级任务，worker 里没有租户上下文', async () => {
    const queue = app.get(QueueService)
    // 即便入队时**有**租户上下文，也不静默继承——必须显式传
    await runWithContext(makeContext('REQ-2', 'TENANT-X'), async () => {
      await queue.add('demo.ok', { n: 2 })
    })
    await driver.drain()
    expect(seen[0]?.tenantId).toBeUndefined()
  })

  it('同一个 jobId 重复入队是幂等的', async () => {
    const queue = app.get(QueueService)
    await queue.add('demo.ok', { n: 3 }, { jobId: 'order-42' })
    await queue.add('demo.ok', { n: 3 }, { jobId: 'order-42' })
    await driver.drain()
    expect(seen).toHaveLength(1)
  })

  it('失败会按 attempts 重试，重试成功就不进死信', async () => {
    failTimes = 2
    await app.get(QueueService).add('demo.flaky', { n: 9 }, { tenantId: 'T1', attempts: 3 })
    await driver.drain()

    expect(seen).toHaveLength(3)
    expect(app.db.rows('JobDeadLetter')).toHaveLength(0)
  })

  // 用例 ④
  it('失败 attempts 次后进 JobDeadLetter，replay 后重新执行并标 resolvedAt', async () => {
    failTimes = 99
    await runWithContext(makeContext('REQ-DL-1'), async () => {
      await app.get(QueueService).add('demo.flaky', { n: 7 }, { tenantId: 'T9', attempts: 3 })
    })
    await driver.drain()

    expect(seen).toHaveLength(3)
    const dead = app.db.rows('JobDeadLetter')
    expect(dead).toHaveLength(1)
    const row = dead[0]!
    expect(row['queue']).toBe('demo.flaky')
    expect(row['jobName']).toBe('demo.flaky')
    expect(row['originTenantId']).toBe('T9')
    expect(row['attempts']).toBe(3)
    expect(String(row['lastError'])).toContain('三方接口 502')
    expect(row['traceId']).toBeTypeOf('string')
    expect(row['resolvedAt']).toBeUndefined()
    expect((row['payload'] as JobEnvelope).data).toEqual({ n: 7 })

    // 重放：这次让它成功
    seen.length = 0
    failTimes = 0
    const jobId = await app.get(DeadLetterService).replay(String(row['id']))
    expect(jobId).toBeTypeOf('string')
    await driver.drain()

    expect(seen).toHaveLength(1)
    expect(seen[0]?.data).toEqual({ n: 7 })
    expect(seen[0]?.tenantId).toBe('T9')
    // 链路：原始请求 REQ-DL-1 → 重放入队（信封的 parentTraceId 指回它）→ 本次执行
    expect(seen[0]?.envParentTraceId).toBe('REQ-DL-1')
    expect(seen[0]?.parentTraceId).toBeTypeOf('string')
    expect(seen[0]?.parentTraceId).not.toBe('REQ-DL-1')
    expect(app.db.rows('JobDeadLetter')[0]?.['resolvedAt']).toBeInstanceOf(Date)
  })

  it('重放不存在的死信直接抛', async () => {
    await expect(app.get(DeadLetterService).replay('NOPE')).rejects.toThrow(/不存在/)
  })

  it('name 重复时启动就抛', async () => {
    await expect(
      createInfraTestApp({
        redis: client,
        providers: [OkHandler, DuplicateNameHandler],
        queue: { driver: new MemoryQueueDriver() },
        queueEnabled: true,
      }),
    ).rejects.toThrow(/@JobHandler name 重复/)
  })
})

describe('QUEUE_ENABLED', () => {
  it('QUEUE_ENABLED=false 时只入队不消费', async () => {
    const driver = new MemoryQueueDriver()
    const app = await createInfraTestApp({
      redis: new RedisMock() as unknown as RedisClient,
      providers: [OkHandler],
      queue: { driver },
      queueEnabled: false,
    })
    seen.length = 0

    await app.get(QueueService).add('demo.ok', { n: 1 })
    await driver.drain()
    expect(seen).toHaveLength(0)
    expect(app.get(ProcessorFactory).discovered.map((d) => d.name)).toEqual(['demo.ok'])
    expect(app.logger.matching('QUEUE_ENABLED=false')).toHaveLength(1)

    await app.close()
  })

  it('没配 queue.connection 时退回内存驱动并打 error 日志', async () => {
    const app = await createInfraTestApp({ redis: new RedisMock() as unknown as RedisClient })
    expect(app.get(QueueService).driverKind).toBe('memory')
    expect(app.logger.matching('退回**进程内内存驱动**').some((e) => e.level === 'error')).toBe(
      true,
    )
    await app.close()
  })
})
