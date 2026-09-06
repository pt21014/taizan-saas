/**
 * `MemoryQueueDriver` 的并发/竞态回归用例。
 *
 * 背景：之前 `add()`（经 `kick()`）与 `drain()` 各跑各的消费循环，互不知情地
 * 同时读写 `pending`/`workers`——`drain()` 判断「跑完了」的逻辑完全没考虑另一
 * 个循环里还在飞的任务，`await driver.drain()` 因此可能在真正跑完之前就返回
 * （漏处理），或者让本该串行的 handler 并发跑起来。
 *
 * 这里直接测驱动本身（不经过 Nest/InfraModule），聚焦驱动层的消费语义。
 *
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest'
import type { JobEnvelope } from './envelope'
import { MemoryQueueDriver } from './memory.driver'
import type { DriverJob } from './queue-driver'

function envelope(n: number): JobEnvelope<{ n: number }> {
  return {
    originTenantId: undefined,
    traceId: `trace-${n}`,
    parentTraceId: undefined,
    data: { n },
    enqueuedAt: Date.now(),
  }
}

describe('MemoryQueueDriver 并发', () => {
  it('100 次并发 add 后 drain：每个 job 恰好处理一次，无重复无遗漏', async () => {
    const driver = new MemoryQueueDriver()
    const processed: number[] = []
    let concurrent = 0
    let maxConcurrent = 0

    await driver.startWorker(
      'demo',
      { concurrency: 1 },
      async (job: DriverJob) => {
        concurrent += 1
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        // 让出一次微任务，放大竞态窗口——如果驱动没有真正串行化，
        // 两个 runOnce() 循环会在这里发生交叠。
        await Promise.resolve()
        processed.push((job.envelope.data as { n: number }).n)
        concurrent -= 1
      },
      async () => {},
    )

    // 100 次并发 add：不 await 每一次，模拟「同一时刻一堆请求都在入队」。
    await Promise.all(Array.from({ length: 100 }, (_, i) => driver.add('demo', envelope(i), {})))

    await driver.drain()

    expect(processed).toHaveLength(100)
    // 无重复、无遗漏：排序后应该正好是 0..99。
    expect([...processed].sort((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, i) => i))
    // 驱动语义上 handler 应该串行跑，不应该出现「同一时刻两个 handler 都在飞」。
    expect(maxConcurrent).toBe(1)

    await driver.close()
  })

  it('drain 进行中再 add：新任务最终也会被处理（不会被提前返回的 drain 漏掉）', async () => {
    const driver = new MemoryQueueDriver()
    const processed: number[] = []

    await driver.startWorker(
      'demo',
      { concurrency: 1 },
      async (job: DriverJob) => {
        const n = (job.envelope.data as { n: number }).n
        // 处理第一个任务时，顺手在 drain 还没返回之前再塞一个新任务进去。
        if (n === 0) {
          await driver.add('demo', envelope(1), {})
        }
        await Promise.resolve()
        processed.push(n)
      },
      async () => {},
    )

    await driver.add('demo', envelope(0), {})
    await driver.drain()

    expect(processed).toEqual([0, 1])

    await driver.close()
  })

  it('并发 add 时如果 handler 失败重试，drain 之后重试也一定跑完', async () => {
    const driver = new MemoryQueueDriver()
    const attempts = new Map<number, number>()
    const done: number[] = []

    await driver.startWorker(
      'flaky',
      { concurrency: 1 },
      async (job: DriverJob) => {
        const n = (job.envelope.data as { n: number }).n
        const count = (attempts.get(n) ?? 0) + 1
        attempts.set(n, count)
        if (count < 2) throw new Error('boom')
        done.push(n)
      },
      async () => {},
    )

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        driver.add('flaky', envelope(i), { attempts: 3, backoff: { type: 'fixed', delayMs: 5 } }),
      ),
    )

    await driver.drain()

    expect([...done].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i))
    for (const count of attempts.values()) {
      expect(count).toBe(2)
    }

    await driver.close()
  })
})
