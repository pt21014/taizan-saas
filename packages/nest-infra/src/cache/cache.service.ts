/**
 * `CacheService`：带强制租户前缀的缓存（蓝图 §4.7）。
 *
 * key 规则与「为什么缺租户就抛」写在 `key-builder.ts` 的文件头。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { currentContext } from '@taizan/nest-core'
import { RedisService } from '../redis/redis.service'
import { buildCacheKey, buildNamespacePattern } from './key-builder'

@Injectable()
export class CacheService {
  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  /**
   * 读缓存。
   *
   * @returns 没命中或反序列化失败都返回 `null`——缓存读不出来只该退化成回源，不该抛
   * @throws {CacheTenantContextError} 非平台命名空间且没有租户上下文
   */
  async get<T>(ns: string, key: string): Promise<T | null> {
    const raw = await this.redis.get(this.keyOf(ns, key))
    return decode<T>(raw)
  }

  /**
   * 写缓存。
   *
   * @param ttlSec - 过期秒数。**必填**：没有过期时间的缓存会在改了数据结构之后
   *   一直返回旧形状，而且没人记得去清
   * @throws {CacheTenantContextError} 非平台命名空间且没有租户上下文
   */
  async set<T>(ns: string, key: string, value: T, ttlSec: number): Promise<void> {
    if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
      throw new Error(`[@taizan/nest-infra] 缓存 ttlSec 必须是正数，收到 ${ttlSec}`)
    }
    await this.redis.set(this.keyOf(ns, key), JSON.stringify(value ?? null), ttlSec * 1000)
  }

  /** 删单个 key。 */
  async del(ns: string, key: string): Promise<void> {
    await this.redis.del(this.keyOf(ns, key))
  }

  /**
   * 清空**当前租户**在某个命名空间下的全部缓存。
   *
   * 用 `SCAN` 不用 `KEYS`（理由见 `RedisService.scanKeys`）。
   * 注意它只清当前租户那一片——`delNs('goods')` 不会影响别的店。
   */
  async delNs(ns: string): Promise<number> {
    const pattern = buildNamespacePattern(ns, currentContext()?.tenantId)
    const keys = await this.redis.scanKeys(pattern)
    if (keys.length === 0) return 0
    // 分批删：一次 DEL 几万个 key 同样会阻塞 Redis 主线程。
    let removed = 0
    for (let i = 0; i < keys.length; i += 200) {
      removed += await this.redis.del(...keys.slice(i, i + 200))
    }
    return removed
  }

  /**
   * 取一次就删（`GETDEL`）。**一次性凭据必须走它**——
   * 微信网页授权 state、短信验证码、一次性登录票据。
   *
   * 先 `get` 再 `del` 的写法在多进程下会让同一个 state 被两个进程都判为有效，
   * 而 state 的全部意义就在于只能用一次（knowledge 不变量 7）。
   */
  async takeOnce<T>(ns: string, key: string): Promise<T | null> {
    const raw = await this.redis.takeOnce(this.keyOf(ns, key))
    return decode<T>(raw)
  }

  /** 组出最终 key（不含 Redis 全局前缀）。暴露出来是为了让测试能断言 key 形状。 */
  keyOf(ns: string, key: string): string {
    return buildCacheKey(ns, key, currentContext()?.tenantId)
  }
}

function decode<T>(raw: string | null): T | null {
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}
