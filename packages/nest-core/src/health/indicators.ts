import { Injectable } from '@nestjs/common'

/**
 * 健康探针（蓝图 §4.11）。
 *
 * `nest-core` **刻意不依赖 Prisma / Redis 客户端**——它是最底层的包，
 * 引一个 `@prisma/client` 进来会让所有下游包（包括纯前端用不到 DB 的）都拖上这个巨大的依赖。
 * DB / Redis / 队列的探针由 `@taizan/nest-prisma`、`@taizan/nest-infra` 各自实现这个接口注册进来。
 */
export interface HealthIndicator {
  /** 探针名，会成为 `/health` 响应里 `checks` 的键，例如 `db`、`redis`、`queue`。 */
  readonly name: string
  /**
   * 探测。**实现方自己负责超时**——探针挂死会把 `/health` 一起拖死，
   * 而 `/health` 挂死时 Nginx/PM2 拿不到 503，反而不会摘流量。
   */
  check(): Promise<'up' | 'down'>
}

/** 静态注入一批探针用的 token（可选；也可以用 {@link HealthRegistry} 动态注册）。 */
export const HEALTH_INDICATORS = Symbol.for('@taizan/nest-core:HEALTH_INDICATORS')

/**
 * 探针注册表。
 *
 * 为什么不是「一个 token + 各模块 provide 数组」：Nest 没有 multi-provider，
 * 两个模块 provide 同一个 token 后面那个会**静默覆盖**前面那个——
 * DB 探针被 Redis 探针盖掉，`/health` 从此永远是绿的，谁都不会发现。
 * 所以改成显式 `register()`，重名直接抛错。
 */
@Injectable()
export class HealthRegistry {
  private readonly indicators = new Map<string, HealthIndicator>()

  /** 注册一个探针。重名抛错——静默覆盖会让健康检查假绿。 */
  register(indicator: HealthIndicator): void {
    if (this.indicators.has(indicator.name)) {
      throw new Error(`[@taizan/nest-core] 健康探针 "${indicator.name}" 重复注册`)
    }
    this.indicators.set(indicator.name, indicator)
  }

  /** 批量注册。 */
  registerAll(indicators: readonly HealthIndicator[]): void {
    for (const indicator of indicators) {
      this.register(indicator)
    }
  }

  /** 当前所有探针。 */
  list(): readonly HealthIndicator[] {
    return [...this.indicators.values()]
  }
}

/**
 * 运行期计数器，随 `/health` 一起下发。
 *
 * 目前只留了 `auditFailures`：审计写失败是「安静的失败」——业务照常成功，
 * 只有日志里一行 error，没人会去看。把它挂到 `/health` 上，监控能直接抓到。
 * 由 `@taizan/nest-audit`（T1-6）在写失败时 `increment('auditFailures')`。
 */
@Injectable()
export class HealthCounters {
  private readonly counters = new Map<string, number>([['auditFailures', 0]])

  increment(name: string, delta = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + delta)
  }

  get(name: string): number {
    return this.counters.get(name) ?? 0
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters)
  }
}
