import 'reflect-metadata'
import { PrismaService, callOperation } from '@taizan/nest-prisma'
import type { JobEnvelope } from '@taizan/nest-infra'
import {
  MemoryQueueDriver,
  createInfraTestApp,
  type TestRedisClient,
  type InfraTestApp,
} from '@taizan/nest-infra/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { NotifyRetryHandler } from './notify-retry.handler'
import { NOTIFY_CHANNELS } from './tokens'
import { NOTIFY_RETRY_JOB, type NotifyRetryPayload } from './notify-retry.types'
import type { NotifyChannelDriver, NotifyMessage } from './types'

/** 最小的 ioredis 形状替身：本测试只用队列，用不到锁/缓存/幂等，方法都是不会被调用的桩。 */
function fakeRedis(): TestRedisClient {
  const notUsed = (): never => {
    throw new Error('本测试不应该用到 redis')
  }
  return {
    get: notUsed,
    set: notUsed,
    del: notUsed,
    getdel: notUsed,
    pexpire: notUsed,
    pttl: notUsed,
    scan: notUsed,
    eval: notUsed,
    ping: async () => 'PONG',
    quit: async () => 'OK',
  } as unknown as TestRedisClient
}

const message: NotifyMessage = {
  templateKey: 'sms.login-code',
  title: '登录验证码',
  content: '您的验证码是 1234',
  vars: { code: '1234' },
  to: { phone: '13800000000' },
}

/**
 * 直接把信封塞进 driver，而不是通过 `testApp.get(QueueService)` + `QueueService.add`。
 *
 * 不能用 `testApp.get(QueueService)` 的原因：`@taizan/nest-infra` 的
 * `tsup.config.ts` 是 `entry: ['src/index.ts', 'src/testing/index.ts']` +
 * `splitting: false`，两个入口各自打包，`QueueService` 在主入口与 `/testing`
 * 入口里是**两个不同的 class 引用**。`createInfraTestApp` 内部用的是 `/testing`
 * 那份，从 `@taizan/nest-infra`（主入口）import 来的 `QueueService` 去
 * `testApp.get()` 会报"provider does not exist"——这是 nest-infra 构建方式带来
 * 的，不是本包能改的，绕开的办法就是不经过容器，直接用拿到的 `driver` 实例
 * 入队（`JobHandler` 靠 `Symbol.for` 的全局符号注册表跨这两个入口仍然认得出，
 * 所以 worker 侧不受影响）。
 *
 * 直接用 `driver.add()` 后还要等一小段时间：`add()` 内部会
 * `void this.kick()` 在后台异步跑第一次尝试（不等它），如果紧接着就调用
 * `driver.drain()`，两条并发的处理循环会在"job 被取出、还没跑完、还没被放回
 * pending"的极短窗口里都读到"队列空了"，`drain()` 因此提前返回——这是
 * `MemoryQueueDriver` 的已知时序特性（源码 `add()`/`kick()`/`drain()` 之间没有
 * 互斥锁），不是本包的问题，也不该改 `@taizan/nest-infra`。等一小段时间让
 * `kick()` 的第一轮完全跑完（含捕获异常、重新入队）之后再 `drain()`，就能避开
 * 这个竞态。
 */
async function enqueueAndSettle(
  driver: MemoryQueueDriver,
  payload: NotifyRetryPayload,
  opts: { attempts: number; backoff: { type: 'exponential' | 'fixed'; delayMs: number } },
): Promise<void> {
  const envelope: JobEnvelope<NotifyRetryPayload> = {
    traceId: 'test-trace',
    data: payload,
    enqueuedAt: Date.now(),
  }
  await driver.add(NOTIFY_RETRY_JOB, envelope, opts)
  await new Promise((resolve) => setTimeout(resolve, 30))
}

/**
 * `MemoryQueueDriver` 的重试等待用的是 `setTimeout(...).unref()`（见
 * `queue/memory.driver.ts` 的 `sleepUntilNext`），单测进程里往往没有别的
 * ref 住事件循环的活动，那个定时器可能根本等不到触发就被判定"没什么可等的"了。
 * `drain()` 期间开一个会 ref 住事件循环的 `setInterval` 兜底，让退避定时器
 * 有机会真正触发——这不是在改被测逻辑，只是给单测进程一个"别提前躺平"的理由。
 */
async function drainKeepingAlive(driver: MemoryQueueDriver): Promise<void> {
  const keepAlive = setInterval(() => {}, 20)
  try {
    await driver.drain()
  } finally {
    clearInterval(keepAlive)
  }
}

let app: InfraTestApp | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

async function boot(
  channel: NotifyChannelDriver,
): Promise<{ app: InfraTestApp; driver: MemoryQueueDriver }> {
  const driver = new MemoryQueueDriver()
  const created = await createInfraTestApp({
    redis: fakeRedis(),
    queueEnabled: true,
    cronEnabled: false,
    queue: { driver },
    providers: [{ provide: NOTIFY_CHANNELS, useValue: [channel] }, NotifyRetryHandler],
  })
  app = created
  return { app: created, driver }
}

describe('NotifyRetryHandler：无 fallback 时失败入队重试、3 次后死信', () => {
  it('每次都失败：重试 3 次后进 JobDeadLetter，NotifyRecord 最终是 FAILED', async () => {
    let calls = 0
    const alwaysFail: NotifyChannelDriver = {
      kind: 'SMS',
      send: async () => {
        calls += 1
        return { ok: false, channel: 'SMS', error: `第 ${calls} 次仍然失败` }
      },
    }
    const { app: testApp, driver } = await boot(alwaysFail)
    const prisma = testApp.get(PrismaService)

    await callOperation(prisma.raw as object, 'platformNotifyRecord', 'create', {
      data: {
        id: 'rec-1',
        channel: 'SMS',
        templateKey: message.templateKey,
        to: '13800000000',
        vars: message.vars,
        status: 'FAILED',
        error: '首次发送失败',
        traceId: 't1',
        sentAt: null,
      },
    })

    const payload: NotifyRetryPayload = {
      channel: 'SMS',
      message,
      recordId: 'rec-1',
    }
    // backoff 覆盖成极短间隔，只是为了不让单测真的等 2s+4s；次数仍然是 3 次。
    await enqueueAndSettle(driver, payload, {
      attempts: 3,
      backoff: { type: 'exponential', delayMs: 5 },
    })
    await drainKeepingAlive(driver)

    expect(calls).toBe(3)
    const deadLetters = testApp.db.rows('JobDeadLetter')
    expect(deadLetters).toHaveLength(1)
    expect(deadLetters[0]?.['jobName']).toBe(NOTIFY_RETRY_JOB)
    expect(deadLetters[0]?.['attempts']).toBe(3)

    const records = testApp.db.rows('PlatformNotifyRecord')
    const rec = records.find((r) => r['id'] === 'rec-1')
    expect(rec?.['status']).toBe('FAILED')
    expect(rec?.['error']).toBe('第 3 次仍然失败')
  })

  it('重试成功：状态更新为 SENT，不进死信', async () => {
    let calls = 0
    const failThenSucceed: NotifyChannelDriver = {
      kind: 'SMS',
      send: async () => {
        calls += 1
        if (calls === 1) return { ok: false, channel: 'SMS', error: '第一次还是失败' }
        return { ok: true, channel: 'SMS', vendorRef: 'ok-2' }
      },
    }
    const { app: testApp, driver } = await boot(failThenSucceed)
    const prisma = testApp.get(PrismaService)

    await callOperation(prisma.raw as object, 'platformNotifyRecord', 'create', {
      data: {
        id: 'rec-2',
        channel: 'SMS',
        templateKey: message.templateKey,
        to: '13800000000',
        vars: message.vars,
        status: 'FAILED',
        error: '首次发送失败',
        traceId: 't2',
        sentAt: null,
      },
    })

    await enqueueAndSettle(
      driver,
      { channel: 'SMS', message, recordId: 'rec-2' },
      { attempts: 3, backoff: { type: 'exponential', delayMs: 5 } },
    )
    await drainKeepingAlive(driver)

    expect(calls).toBe(2)
    expect(testApp.db.rows('JobDeadLetter')).toHaveLength(0)
    const rec = testApp.db.rows('PlatformNotifyRecord').find((r) => r['id'] === 'rec-2')
    expect(rec?.['status']).toBe('SENT')
    expect(rec?.['error']).toBeNull()
  })
})
