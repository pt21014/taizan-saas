/**
 * `IdempotencyService`：同一个 `(scope, key)` 只执行一次（蓝图 §4.7）。
 *
 * 典型用户：支付回调（微信会重推最多 15 次）、对外下单、C 端「重复点了两下提交」。
 *
 * ## 为什么 Redis 与表两边都写
 *
 * | 层 | 作用 | 没有它会怎样 |
 * |---|---|---|
 * | Redis `SET NX PX` | **抢占**，保证并发只有一个执行者 | 两个进程同时进 fn，扣两次款 |
 * | `IdempotencyKey` 表 | **留痕**，过了缓存期还能回答「这单处理过没有」 | Redis 一 flush，全部重放 |
 *
 * 只有 Redis 不够（它会过期、会被清空），只有表也不够（`INSERT` 冲突要靠唯一索引，
 * 而冲突发生时前一个事务可能还没提交，读不到结果）。
 *
 * ## 结果本体存在 Redis，不落表
 *
 * `IdempotencyKey` 表里只有 `resultHash`，**刻意不存结果本体**：这些结果里最常见的
 * 就是支付回调的原文和下单响应，落库等于把三方报文明文摊在一张谁都能查的表上。
 * 表里的 hash 用来回答「重放请求的参数和第一次是不是一致」，结果本体则缓存在 Redis，
 * 过期后重放只会拿到 `result: undefined`——调用方据此自己去查真实状态，而不是拿到旧数据。
 *
 * @packageDocumentation
 */

import { createHash } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { ulid } from '@taizan/contracts'
import { callOperation, PrismaService } from '@taizan/nest-prisma'
import { RedisService } from '../redis/redis.service'
import { INFRA_LOGGER } from '../tokens'
import type { InfraLogger } from '../logging'

/** `IdempotencyKey` 在客户端上的属性名（camelCase）。 */
const IDEMPOTENCY_KEY = 'idempotencyKey'

/** Redis 占位值：表示「有人正在跑，还没有结果」。 */
export const IDEMPOTENCY_PENDING = 'PENDING'

/** 默认留痕时长：24 小时。微信回调最长重推 24 小时出头，取整到一天。 */
export const DEFAULT_IDEMPOTENCY_TTL_SEC = 24 * 60 * 60

/**
 * 执行结果。
 *
 * `fresh: true` 时 `result` 一定有值（就是这次 `fn` 的返回值）；
 * `fresh: false` 时可能拿不到结果本体（缓存已过期），此时是 `undefined`。
 */
export type IdempotencyOutcome<T> =
  { fresh: true; result: T } | { fresh: false; result: T | undefined }

/** 组 Redis key。 */
export function idempotencyRedisKey(scope: string, key: string): string {
  return `idem:${scope}:${key}`
}

@Injectable()
export class IdempotencyService {
  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(INFRA_LOGGER) private readonly logger: InfraLogger,
  ) {}

  /**
   * 幂等地执行 `fn`。
   *
   * @param scope - 作用域，通常是接口名，例如 `pay.notify.wechat`
   * @param key - 调用方给的幂等键，例如 `transactionId`
   * @param ttlSec - 留痕时长，默认 24 小时
   */
  async run<T>(
    scope: string,
    key: string,
    fn: () => Promise<T>,
    ttlSec: number = DEFAULT_IDEMPOTENCY_TTL_SEC,
  ): Promise<IdempotencyOutcome<T>> {
    const redisKey = idempotencyRedisKey(scope, key)
    const ttlMs = ttlSec * 1000

    const acquired = await this.redis.setNx(redisKey, IDEMPOTENCY_PENDING, ttlMs)
    if (!acquired) {
      return { fresh: false, result: await this.readCached<T>(redisKey) }
    }

    let result: T
    try {
      result = await fn()
    } catch (err) {
      // 失败要把占位放掉，否则这个 key 在整个 TTL 内都进不来——
      // 一次网络抖动会让这笔支付回调 24 小时都无法重试。
      await this.redis.del(redisKey).catch(() => undefined)
      throw err
    }

    const serialized = serialize(result)
    // 先写 Redis 再写表：Redis 是并发请求真正读的那一份，先落它能把「窗口期内
    // 第二次请求拿到 PENDING」的时间压到最短。
    await this.redis.set(redisKey, serialized, ttlMs)
    await this.persist(scope, key, serialized, ttlSec)

    return { fresh: true, result }
  }

  /**
   * 只查不执行：这个 `(scope, key)` 之前处理过吗。
   *
   * Redis 过期后仍然能从表里查到——这正是留痕的意义。
   */
  async seen(scope: string, key: string): Promise<boolean> {
    const cached = await this.redis.get(idempotencyRedisKey(scope, key))
    if (cached !== null) return true
    // raw-reason: 平台域基础设施表
    const row = await callOperation(this.prisma.raw as object, IDEMPOTENCY_KEY, 'findUnique', {
      where: { scope_key: { scope, key } },
    })
    return row !== null && row !== undefined
  }

  private async readCached<T>(redisKey: string): Promise<T | undefined> {
    const raw = await this.redis.get(redisKey)
    if (raw === null || raw === IDEMPOTENCY_PENDING) return undefined
    try {
      return JSON.parse(raw) as T
    } catch {
      return undefined
    }
  }

  /**
   * 落 `IdempotencyKey` 表。
   *
   * 写失败**不抛**：`fn` 已经跑完了，副作用已经发生，这时候抛异常只会让调用方
   * 以为「没成功」而重试一遍。打 error 让监控看得到就够了。
   */
  private async persist(
    scope: string,
    key: string,
    serialized: string,
    ttlSec: number,
  ): Promise<void> {
    const resultHash = createHash('sha256').update(serialized).digest('hex')
    const expiresAt = new Date(Date.now() + ttlSec * 1000)
    try {
      // raw-reason: 平台域基础设施表
      await callOperation(this.prisma.raw as object, IDEMPOTENCY_KEY, 'upsert', {
        where: { scope_key: { scope, key } },
        create: { id: ulid(), scope, key, status: 'SUCCEEDED', resultHash, expiresAt },
        update: { status: 'SUCCEEDED', resultHash, expiresAt },
      })
    } catch (err) {
      this.logger.error(
        `[@taizan/nest-infra] 写 IdempotencyKey 失败（${scope}/${key}）：` +
          (err instanceof Error ? err.message : String(err)),
        err instanceof Error ? err.stack : undefined,
        'IdempotencyService',
      )
    }
  }
}

function serialize(value: unknown): string {
  // `undefined` 不是合法 JSON；统一存成 null，读回来是 null 而不是崩在 JSON.parse 上。
  return JSON.stringify(value ?? null)
}
