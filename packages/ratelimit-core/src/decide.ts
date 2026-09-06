/**
 * 三维度限流判定。
 *
 * ## 一句话
 *
 * {@link decide} 对「客户端 IP / 入口 IP / 账号」三个维度**各加一次计数**，
 * 任何一个维度超过它自己的阈值就拒绝，并回一个 `retryAfterSec`。
 *
 * ## Redis 挂了怎么办：**弱化，但绝不放行**
 *
 * 这是本文件最要紧的一段，抄 knowledge `rate-limit.service.ts` 的原注释：
 *
 * > **Redis 挂了退回进程内计数，而不是放行**。放行等于在 Redis 抖动的那几分钟里
 * > 完全没有防护；退回进程内至少还剩「额度 × 进程数」这一档——
 * > 比今天的单进程弱，但比零强得多。这一档会打 error 日志。
 *
 * 「Redis 挂了就放行」是一行 `catch { return { allowed: true } }` 的事，
 * 而它的后果是：抖动的那几分钟里限流完全消失，**且没有任何东西会报错**。
 * 所以本文件里 store 抛错的分支**必须**落到 {@link processLocalStore}，
 * 并把 `degraded: true` 带回给调用方去打日志。
 *
 * @packageDocumentation
 */

import { findTier, renderTierMessage, type RateLimitTier, type RateLimitTierName } from './config'
import { buildKey, MemoryRateLimitStore, type RateLimitStore } from './store'

/** 三个计数维度。 */
export type RateLimitDimension = 'client' | 'edge' | 'account'

/** 全部维度，按判定顺序（先报最具体的那个）。 */
export const ALL_DIMENSIONS: readonly RateLimitDimension[] = ['client', 'edge', 'account']

/** 本次请求在三个维度上的取值。 */
export interface RateLimitKeys {
  /** 可信客户端 IP，来自 `resolveIps().client`。**不要**从 XFF 第一段取。 */
  client: string
  /** 入口 IP，来自 `resolveIps().edge`。 */
  edge: string
  /** 账号标识（accountId / 手机号 / 用户名）。没有就不传，账号维度会被跳过。 */
  account?: string
}

/** {@link decide} 的入参。 */
export interface DecideInput {
  /** 档位名或档位对象。名字不认识会抛 {@link UnknownTierError}。 */
  tier: RateLimitTierName | string | RateLimitTier
  keys: RateLimitKeys
  /** 计数后端。Redis / 内存 / 任何满足签名的东西。 */
  store: RateLimitStore
  /**
   * 只算这几个维度，默认全算。
   *
   * 有一个真实用途：守卫在**每个请求**上算 client + edge，而登录流程在拿到
   * 「他要登哪个账号」之后**再**补算 account 一次。如果流程那次也把 client/edge
   * 算进去，同一个请求就被计了两遍，实际额度直接减半——而这种错在测试里
   * 很难看出来（限流「更严了」看起来不像 bug）。
   */
  dimensions?: readonly RateLimitDimension[]
  /** key 的额外前缀（多环境共用一个 Redis 时用来隔开），见 `buildKey`。 */
  scope?: string
  /** 时间源，只影响降级路径的进程内计数。默认 `Date.now()`。 */
  now?: number
}

/** 判定结果。 */
export interface Decision {
  /** 放行还是拒绝。 */
  allowed: boolean
  /** 档位名。 */
  tier: string
  /** 命中的维度；`allowed` 为 true 时没有。 */
  hitDimension?: RateLimitDimension
  /** 还要等多少秒。命中时一定有，且**至少是 1**（回 0 会让客户端立刻重试）。 */
  retryAfterSec?: number
  /** 给用户看的话（已经把 `{sec}` 换掉）。命中时一定有。 */
  message?: string
  /**
   * **是否降级**：至少有一个维度是因为 store 抛错而退回进程内计数的。
   *
   * 调用方看到 `true` 必须打 error 日志（限频，别把磁盘写满）。
   * 它不影响 `allowed`——降级路径照样会拒绝。
   */
  degraded: boolean
  /** 各维度自增后的计数，用来打日志和写测试。 */
  counts: Partial<Record<RateLimitDimension, number>>
}

/** `@RateLimited('typo')` 这种。 */
export class UnknownTierError extends Error {
  override readonly name = 'UnknownTierError'
  constructor(readonly tierName: string) {
    super(`[@taizan/ratelimit-core] 不认识的限流档位 ${tierName}`)
  }
}

/**
 * 降级用的进程内计数器，**整个进程共用一个**。
 *
 * process-local: 这是「Redis 不可用时退回进程内」这条降级路径本身，不是缓存优化。
 * 多进程下额度会变成「配置值 × 进程数」，这是已知且被接受的代价——
 * 详见本文件头部那段引文。蓝图 §8 spec 12 要求进程内状态必须写明理由，这就是理由。
 */
const processLocalStore = new MemoryRateLimitStore()

/** 清空降级计数器（测试用；生产没有清它的理由）。 */
export function resetProcessLocalCounters(): void {
  processLocalStore.reset()
}

/** 把已过期的降级计数器扫掉。长驻进程可以挂在定时器上，不挂也只是多占点内存。 */
export function sweepProcessLocalCounters(): void {
  processLocalStore.sweep()
}

function resolveTierArg(tier: DecideInput['tier']): RateLimitTier {
  if (typeof tier !== 'string') return tier
  const found = findTier(tier)
  if (!found) throw new UnknownTierError(tier)
  return found
}

function limitOf(tier: RateLimitTier, dimension: RateLimitDimension): number | undefined {
  if (dimension === 'client') return tier.clientLimit
  if (dimension === 'edge') return tier.edgeLimit
  return tier.accountLimit
}

/**
 * 判定一次请求。**会计数**——这个函数不是「只看看」，调一次就消耗一次额度。
 *
 * 判定规则：自增后的计数 `> limit` 才算超。也就是说 `clientLimit: 3` 的含义是
 * 「窗口内放过 3 次，第 4 次拒绝」，而不是「第 3 次就拒绝」。
 *
 * 三个维度**全部都会被计数**，不会在第一个命中的维度上短路。原因是短路会让
 * 后面的维度漏计：攻击者只要把前一个维度打满，后面两个维度就永远停在旧值上，
 * 等他换个 IP 继续打的时候，账号维度还是干净的。
 *
 * @throws {@link UnknownTierError} 档位名不认识（不会因为不认识就放行）
 */
export async function decide(input: DecideInput): Promise<Decision> {
  const tier = resolveTierArg(input.tier)
  const dimensions = input.dimensions ?? ALL_DIMENSIONS
  const now = input.now ?? Date.now()

  const counts: Partial<Record<RateLimitDimension, number>> = {}
  let degraded = false
  let hit: { dimension: RateLimitDimension; key: string; fromLocal: boolean } | undefined

  for (const dimension of ALL_DIMENSIONS) {
    if (!dimensions.includes(dimension)) continue

    const value = dimension === 'account' ? input.keys.account : input.keys[dimension]
    if (value === undefined || value === '') continue

    const limit = limitOf(tier, dimension)
    // 这一档没配这个维度（例如 lookup 没有 accountLimit）就跳过，不是「无限额度」。
    if (limit === undefined) continue

    const key = buildKey(tier.name, dimension, value, input.scope)

    let count: number
    let fromLocal = false
    try {
      count = await input.store.incr(key, tier.windowSec)
    } catch {
      // ── Redis 不可用 ──────────────────────────────────────────────────
      // 这里**不能** return allowed:true。见文件头那段引文。
      degraded = true
      fromLocal = true
      count = processLocalStore.incrSync(key, tier.windowSec, now)
    }

    counts[dimension] = count
    if (count > limit && !hit) {
      hit = { dimension, key, fromLocal }
    }
  }

  if (!hit) {
    return { allowed: true, tier: tier.name, degraded, counts }
  }

  const retryAfterSec = await remainingSec(input.store, hit.key, tier, hit.fromLocal, now)
  return {
    allowed: false,
    tier: tier.name,
    hitDimension: hit.dimension,
    retryAfterSec,
    message: renderTierMessage(tier, retryAfterSec),
    degraded,
    counts,
  }
}

/**
 * 还要等多久。
 *
 * store 没实现 `ttlSec` 时退回整个窗口长度：让用户多等一会儿，好过回一个偏小的值
 * 让他立刻重试、再被拒一次（然后他会以为是接口坏了）。
 */
async function remainingSec(
  store: RateLimitStore,
  key: string,
  tier: RateLimitTier,
  fromLocal: boolean,
  now: number,
): Promise<number> {
  if (fromLocal) {
    return Math.max(1, processLocalStore.ttlSecSync(key, now) ?? tier.windowSec)
  }
  if (store.ttlSec) {
    try {
      const ttl = await store.ttlSec(key)
      if (ttl !== null && ttl > 0) return ttl
    } catch {
      // TTL 查不到不影响判定，用窗口长度兜底。
    }
  }
  return tier.windowSec
}
