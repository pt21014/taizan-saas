/**
 * `LockService`：Redis 分布式锁（蓝图 §4.7）。
 *
 * 这是「4 实例并发跑 cron」那条线上活故障的根治点。老项目 knowledge 的
 * `order-close.service.ts` / `profit-sharing.service.ts` 用的是裸 `setInterval`，
 * pm2 cluster 起 4 个进程之后，同一笔订单被关了 4 次、同一笔分账被发起了 4 次。
 * 那不是「多跑几遍浪费点 CPU」，是**重复的对外副作用**。
 *
 * ## 四条不可退让
 *
 * 1. 加锁用 `SET key token NX PX ttl`——一条命令完成「不存在才写 + 带过期」。
 *    分两条写（`SETNX` 再 `EXPIRE`）时，进程死在两条之间，这把锁就**永远不过期**。
 * 2. 释放用 Lua 比对 token，不能裸 `DEL`（理由见 `scripts.ts`）。
 * 3. 拿不到锁**返回 `null`，不抛异常**。「没抢到 leader」是正常状态，不是错误；
 *    抛异常会让每个非 leader 实例每个 tick 都往错误日志里灌一条，真错误就淹了。
 * 4. `fn` 抛错时**先释放锁再重抛**。不释放的话，这个 key 要卡满一整个 TTL。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { RedisService } from '../redis/redis.service'
import { INFRA_INSTANCE_ID } from '../tokens'
import { RELEASE_LOCK_LUA, RENEW_LOCK_LUA } from './scripts'
import { startWatchdog } from './watchdog'

/** 锁 key 的强制前缀。 */
export const LOCK_KEY_PREFIX = 'lock:'

/** {@link LockService.withLock} 的可选项。 */
export interface WithLockOptions {
  /**
   * 开启续期看门狗：每 `ttlMs/3` 续一次，直到 `fn` 结束。
   *
   * 什么时候开：`fn` 的耗时不可预测（对账、批量推送、跑全表）。
   * 什么时候不开：`fn` 明显短于 `ttlMs`，多一个定时器不划算。
   */
  watchdog?: boolean
  /**
   * 拿不到锁时最多等多久（毫秒）。不传 = 不等，立刻返回 `null`。
   *
   * cron 场景**永远不要传**：等待等于排队，而排队正是我们要消灭的东西——
   * 一个 tick 没抢到就该跳过，下个 tick 再说。
   */
  waitMs?: number
  /** 重试间隔，默认 `min(50, ttlMs/10)`。只在传了 `waitMs` 时有意义。 */
  retryIntervalMs?: number
}

/** 一次成功加锁的凭据。 */
export interface AcquiredLock {
  /** 带 `lock:` 前缀的逻辑 key（不含 Redis 全局前缀）。 */
  readonly key: string
  /** 本次持有者的随机 token。释放与续期都要拿它比对。 */
  readonly token: string
}

/** 把任意 key 规整成 `lock:` 开头。 */
export function normalizeLockKey(key: string): string {
  const trimmed = key.trim()
  if (trimmed.length === 0) {
    throw new Error('[@taizan/nest-infra] 锁 key 不能为空')
  }
  return trimmed.startsWith(LOCK_KEY_PREFIX) ? trimmed : `${LOCK_KEY_PREFIX}${trimmed}`
}

@Injectable()
export class LockService {
  private tokenSeq = 0

  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(INFRA_INSTANCE_ID) private readonly instanceId: string,
  ) {}

  /**
   * 在锁的保护下执行 `fn`。
   *
   * @returns `fn` 的返回值；**没抢到锁时返回 `null`**（不抛）
   * @throws `fn` 抛出的任何异常（锁会先被释放）
   */
  async withLock<T>(
    key: string,
    ttlMs: number,
    fn: () => Promise<T>,
    opts: WithLockOptions = {},
  ): Promise<T | null> {
    const lock = await this.acquire(key, ttlMs, opts)
    if (!lock) return null

    const watchdog = opts.watchdog ? startWatchdog(ttlMs, () => this.renew(lock, ttlMs)) : undefined

    try {
      return await fn()
    } finally {
      watchdog?.stop()
      // 释放失败不能盖过 fn 的异常：这里只吞「释放本身」的错误，TTL 会兜底。
      await this.release(lock).catch(() => undefined)
    }
  }

  /**
   * 尝试加锁。低层入口，一般用 {@link LockService.withLock}。
   *
   * @returns 成功返回凭据，失败（含等待超时）返回 `null`
   */
  async acquire(
    key: string,
    ttlMs: number,
    opts: WithLockOptions = {},
  ): Promise<AcquiredLock | null> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error(`[@taizan/nest-infra] 锁 TTL 必须是正数，收到 ${ttlMs}`)
    }
    const lockKey = normalizeLockKey(key)
    const token = this.nextToken()
    const deadline = Date.now() + (opts.waitMs ?? 0)
    const retryInterval = opts.retryIntervalMs ?? Math.max(20, Math.min(50, Math.floor(ttlMs / 10)))

    for (;;) {
      if (await this.redis.setNx(lockKey, token, ttlMs)) {
        return { key: lockKey, token }
      }
      if (Date.now() + retryInterval > deadline) return null
      await sleep(retryInterval)
    }
  }

  /** 释放锁（Lua 比对 token）。返回 `false` 说明这把锁已经不是自己的了。 */
  async release(lock: AcquiredLock): Promise<boolean> {
    const res = await this.redis.eval(RELEASE_LOCK_LUA, [this.redis.key(lock.key)], [lock.token])
    return Number(res) === 1
  }

  /** 续期（Lua 比对 token）。返回 `false` 说明锁已易主或已过期。 */
  async renew(lock: AcquiredLock, ttlMs: number): Promise<boolean> {
    const res = await this.redis.eval(
      RENEW_LOCK_LUA,
      [this.redis.key(lock.key)],
      [lock.token, ttlMs],
    )
    return Number(res) === 1
  }

  /**
   * 生成持有者 token。
   *
   * 带上 `instanceId` 不是为了唯一性（后面的序号 + 随机数已经够了），
   * 而是为了**排查**：`GET lock:xxx` 直接看得到卡住这把锁的是哪台实例。
   */
  private nextToken(): string {
    this.tokenSeq += 1
    const rand = Math.random().toString(36).slice(2, 10)
    return `${this.instanceId}#${this.tokenSeq}#${rand}`
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // cluster-safe-allow: 抢锁重试的退避等待，不是业务调度
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
