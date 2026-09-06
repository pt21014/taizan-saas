import { Controller, Get, HttpStatus, Inject, Optional, Res, SetMetadata } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { Response } from 'express'
import { RawResponse } from '../http/raw-response.decorator'
import { AppLogger } from '../logging/logger.service'
import { HealthCounters, HealthRegistry } from './indicators'

/**
 * `@taizan/nest-auth` 的 `@Public()` / `@RateLimited(tier)` 用的 metadata key。
 *
 * **不能 `import` 那个包**：`@taizan/nest-auth` 依赖 `@taizan/nest-core`（读 `BizException` /
 * `patchCurrentContext`），反过来 import 会成环——workspace 里两个包互相 `dependencies`
 * 对方，`pnpm` 装得起来，但 TS 的 project references / 打包顺序会先炸。
 *
 * 这两个 key 是纯字符串常量（`SetMetadata` 存的是 key-value，`GlobalAuthGuard` /
 * `RateLimitGuard` 用 `Reflector` 按 key 读，不关心是谁定义的），所以在这里手写同一对
 * 字面量、不经过 `@taizan/nest-auth` 的装饰器函数，运行时完全等价。
 * 权威定义见 `packages/nest-auth/src/decorators/index.ts` 的 `IS_PUBLIC_KEY` /
 * `RATE_LIMIT_KEY`——两边的字面量改动必须同步，这也是为什么它们各自都在头部
 * 写清楚了来源，而不是分散在装饰器调用的地方。
 */
const AUTH_IS_PUBLIC_KEY = 'taizan:auth:public'
/** 见上，对应 `@taizan/nest-auth` 的 `RATE_LIMIT_KEY`。 */
const AUTH_RATE_LIMIT_KEY = 'taizan:auth:rate-limit'

/** `/health` 的响应形状。 */
export interface HealthReport {
  status: 'up' | 'down'
  /** 每个探针的结果，键是探针名 */
  checks: Record<string, 'up' | 'down'>
  /** 进程运行秒数 */
  uptime: number
  /** 应用版本 */
  version: string
  /** 运行期计数器（目前只有 auditFailures） */
  counters: Record<string, number>
}

/** 应用版本号的注入 token。 */
export const HEALTH_VERSION = Symbol.for('@taizan/nest-core:HEALTH_VERSION')

/**
 * 健康检查（蓝图 §4.11）。
 *
 * 三个不可退让：
 * 1. **任一探针 down → HTTP 503**。Nginx `proxy_next_upstream` 与 PM2 都是按状态码摘流量的，
 *    200 + `{status:'down'}` 等于没做健康检查。
 * 2. **`@RawResponse()`**：探活方（Nginx / K8s / 云监控）读的是顶层字段，
 *    套上 `{code,message,data}` 之后它们得改配置去读 `data.status`，而且改不动的那些就永远读不到。
 * 3. **必须免登录**：探活方不会、也不该持有一份 token。装了 `@taizan/nest-auth` 的应用会把
 *    `GlobalAuthGuard` 注册成 `APP_GUARD`（默认拒绝），没有声明「公开」的路由一律 401——
 *    `/health` 若漏了这个声明，探活会从「200/503 混着 1240400」变成清一色 401，
 *    效果和这次要修的 bug 一样：探活失效。这里手写了跟 `@Public()` /
 *    `@RateLimited('public-default')` 等价的 metadata（见上面 `AUTH_IS_PUBLIC_KEY` 的注释），
 *    公开的同时仍然挂着限流档位，不是一个没有防护的洞。
 */
@ApiTags('health')
@Controller('health')
@SetMetadata(AUTH_IS_PUBLIC_KEY, true)
@SetMetadata(AUTH_RATE_LIMIT_KEY, 'public-default')
export class HealthController {
  constructor(
    @Inject(HealthRegistry) private readonly registry: HealthRegistry,
    @Inject(HealthCounters) private readonly counters: HealthCounters,
    @Optional() @Inject(HEALTH_VERSION) private readonly version: string = '0.0.0',
    @Optional() @Inject(AppLogger) private readonly logger?: AppLogger,
  ) {}

  @Get()
  @RawResponse()
  @ApiOperation({ summary: '健康检查；任一依赖 down 返回 503' })
  async check(@Res() res: Response): Promise<void> {
    const indicators = this.registry.list()
    const results = await Promise.all(
      indicators.map(async (indicator) => {
        try {
          return [indicator.name, await indicator.check()] as const
        } catch (error) {
          // 探针自己抛了 = down。吞掉异常，否则一个探针实现有 bug 就让 /health 整个 500，
          // 运维分不清是「依赖挂了」还是「健康检查本身挂了」。
          this.logger?.warn?.(
            `健康探针 ${indicator.name} 抛错：${error instanceof Error ? error.message : String(error)}`,
            'Health',
          )
          return [indicator.name, 'down'] as const
        }
      }),
    )

    const checks = Object.fromEntries(results) as Record<string, 'up' | 'down'>
    const down = results.some(([, status]) => status === 'down')
    const report: HealthReport = {
      status: down ? 'down' : 'up',
      checks,
      uptime: Math.round(process.uptime()),
      version: this.version,
      counters: this.counters.snapshot(),
    }
    res.status(down ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK).json(report)
  }
}
