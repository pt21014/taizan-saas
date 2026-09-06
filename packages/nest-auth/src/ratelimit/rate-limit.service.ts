/**
 * 限流的**运行时门面**：拿上下文里的 IP、调 `decide`、超了就抛 429。
 *
 * 守卫（{@link RateLimitGuard}）和业务流程（{@link AuthFlowService}）都走这一个入口，
 * 所以「怎么取 IP」「降级怎么打日志」「触顶抛什么」各只有一份实现。
 *
 * @packageDocumentation
 */

import { Inject, Injectable, Optional } from '@nestjs/common'
import { AppLogger, currentContext } from '@taizan/nest-core'
import {
  decide,
  findTier,
  type Decision,
  type RateLimitDimension,
  type RateLimitKeys,
  type RateLimitStore,
} from '@taizan/ratelimit-core'
import { RateLimitedException } from './rate-limit.exception'
import { RATE_LIMIT_OPTIONS, RATE_LIMIT_STORE } from '../tokens'

/** 上下文缺失时用的 key。用一个显眼的固定值，而不是空串或 `unknown`。 */
export const NO_CONTEXT_KEY = 'no-request-context'

/** 档位名不认识时退回的兜底档。 */
export const FALLBACK_TIER = 'public-default'

/** {@link RateLimitService.consume} 的选项。 */
export interface ConsumeOptions {
  /** 账号维度的取值（accountId / 手机号 / 用户名）。不传就跳过账号维度。 */
  account?: string | undefined
  /**
   * 只算这几个维度。默认全算。
   *
   * 守卫按请求算 client + edge（外加已登录时的 account），登录流程**只补算 account**——
   * 两边都算 client/edge 的话同一个请求被计两遍，实际额度直接减半，
   * 而「限流变严了」这种错在测试里看不出来。
   */
  dimensions?: readonly RateLimitDimension[]
  /** 覆盖 keys（几乎只在测试里用）。不传就从请求上下文取。 */
  keys?: RateLimitKeys
}

/** {@link RateLimitModuleOptions} 里能配的东西。 */
export interface RateLimitRuntimeOptions {
  /** key 前缀，多环境共用一个 Redis 时用来隔开计数。 */
  scope?: string
  /** 降级 error 日志的最小间隔（毫秒），默认 60 秒。 */
  degradeLogIntervalMs?: number
}

/** 默认降级日志限频间隔。 */
export const DEGRADE_LOG_INTERVAL_MS = 60_000

@Injectable()
export class RateLimitService {
  /** 上一次打降级日志的时间戳。 */
  // process-local: 只是日志限频的时间戳，不是限流计数。每个进程各限各的频，
  // 最坏情况是 N 个进程各打一条——那正是我们希望看到的（哪个实例连不上 Redis）。
  private lastDegradeLog = 0

  /** 已经就「这个档位名不认识」警告过的名字，避免每请求刷屏。 */
  // process-local: 同上，纯日志去重。
  private readonly warnedTiers = new Set<string>()

  constructor(
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
    @Optional() @Inject(RATE_LIMIT_OPTIONS) private readonly options?: RateLimitRuntimeOptions,
    @Optional() @Inject(AppLogger) private readonly logger?: AppLogger,
  ) {}

  /**
   * 从**请求上下文**取两个 IP。
   *
   * 这是全包唯一取 IP 的地方，而上下文里那两个值由 `ContextMiddleware` 通过
   * `IP_RESOLVER`（= `resolveIps`）填。所以不变量 6 在运行时只有这一条路径，
   * 没有第二处能绕过去——绕过去的写法会被 spec 13 静态扫出来。
   */
  private keysFrom(account?: string): RateLimitKeys {
    const ctx = currentContext()
    if (!ctx) {
      // 没有上下文说明 `ContextMiddleware` 没挂上（装配错误）。
      // 这时候**不能放行**：所有请求挤进同一个桶，粗到误伤，但看得见。
      this.warnOnce(
        'no-context',
        '限流拿不到请求上下文，退化成全局共用一个计数桶。检查 CoreModule 的 ContextMiddleware 是否挂上。',
      )
      return { client: NO_CONTEXT_KEY, edge: NO_CONTEXT_KEY, ...(account ? { account } : {}) }
    }
    return { client: ctx.ip.client, edge: ctx.ip.edge, ...(account ? { account } : {}) }
  }

  /**
   * 消费一次额度。**会计数**，无论最终放不放行。
   *
   * @param tierName - `@RateLimited(tier)` 里那个名字
   * @throws {@link RateLimitedException} 任一维度超额（HTTP 429 + 业务码 1042900）
   * @returns 未超额时的判定结果（调用方一般不用看）
   */
  async consume(tierName: string, options: ConsumeOptions = {}): Promise<Decision> {
    const tier = this.resolveTier(tierName)
    const keys = options.keys ?? this.keysFrom(options.account)

    const decision = await decide({
      tier,
      keys,
      store: this.store,
      ...(options.dimensions ? { dimensions: options.dimensions } : {}),
      ...(this.options?.scope ? { scope: this.options.scope } : {}),
    })

    if (decision.degraded) this.warnDegraded()

    if (!decision.allowed) {
      this.logger?.warn?.(
        `限流命中 tier=${decision.tier} dim=${decision.hitDimension ?? '-'} ` +
          `client=${keys.client} edge=${keys.edge} account=${keys.account ?? '-'} ` +
          `counts=${JSON.stringify(decision.counts)}`,
        'RateLimit',
      )
      throw new RateLimitedException({
        message: decision.message ?? '请求过于频繁，请稍后再试',
        retryAfterSec: decision.retryAfterSec ?? 60,
        tier: decision.tier,
        ...(decision.hitDimension ? { hitDimension: decision.hitDimension } : {}),
      })
    }

    return decision
  }

  /**
   * 档位名归一。
   *
   * 拼错的名字**不会**让路由变成「不限流」——那是最坏的失败方式（打错一个字母，
   * 一个登录接口就裸奔了，而且没有任何症状）。这里退回 {@link FALLBACK_TIER}
   * 并打一条 warn；CI 上由 spec 5 的静态扫描把「用了不存在的档位名」升级成失败。
   */
  private resolveTier(name: string): string {
    if (findTier(name)) return name
    this.warnOnce(
      name,
      `不认识的限流档位 ${name}，已退回兜底档 ${FALLBACK_TIER}。` +
        `档位名拼错不会让接口不限流，但它会用错阈值——请对照 RATE_LIMIT_TIER_NAMES 改正。`,
    )
    return FALLBACK_TIER
  }

  private warnOnce(key: string, message: string): void {
    if (this.warnedTiers.has(key)) return
    this.warnedTiers.add(key)
    this.logger?.warn?.(message, 'RateLimit')
  }

  /** 降级日志限频，别把磁盘写满。 */
  private warnDegraded(): void {
    const interval = this.options?.degradeLogIntervalMs ?? DEGRADE_LOG_INTERVAL_MS
    const now = Date.now()
    if (now - this.lastDegradeLog < interval) return
    this.lastDegradeLog = now
    this.logger?.error?.(
      '限流计数退回进程内存（Redis 不可用）。多进程下额度会变成「配置值 × 进程数」，' +
        '仍然拦得住，但比平时弱得多，尽快恢复 Redis。',
      undefined,
      'RateLimit',
    )
  }
}
