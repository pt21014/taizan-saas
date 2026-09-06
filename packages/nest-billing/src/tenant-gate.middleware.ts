/**
 * C 端闸门（蓝图 §4.1 + §4.5）：到期 / 冻结 / 注销的店铺**打烊**，返回 `1440302`。
 *
 * ## 为什么是中间件而不是守卫
 *
 * C 端大量接口是 `@Public()` 的（商品列表、店铺主页、下单前的询价）。守卫链里
 * `GlobalAuthGuard` 遇到 `@Public()` 直接 return true，后面的守卫照跑没错，但
 * 「店铺打烊」这件事应当在**进业务之前**就挡住，包括那些根本没有守卫元数据的路径。
 * 中间件还能保证一件事：打烊时连一次业务查询都不发生，到期店铺不再消耗任何资源。
 *
 * ## 挂载位置
 *
 * `ContextMiddleware`（nest-core）→ `TenantMiddleware`（nest-auth，解析出 tenantId）
 * → **本中间件** → 路由。顺序错了就读不到 `currentContext().tenantId`，
 * 那时本中间件会**放行**（见 `use()` 里的注释），不会把整个 C 端拦死。
 *
 * 装配由 app 端做（`BillingModule` 默认不挂），理由见 `BillingModuleOptions.registerClientMiddleware`。
 *
 * ## 与后台闸门的两处不同
 *
 * 1. **不分读写**。打烊就是打烊，看也看不了——`GET /api/client/goods` 一样拦。
 *    后台留只读是为了让商家能看到欠费并去续，C 端顾客没有这个需要。
 * 2. **冻结/注销与开关无关**。`evaluateTenantGate` 里硬闸门走 `hard()` 分支，
 *    `enforcing` 不参与——平台按下去的东西，开关掀不动。
 *
 * @packageDocumentation
 */

import { Inject, Injectable, Optional, type NestMiddleware } from '@nestjs/common'
import { ErrorCode } from '@taizan/contracts'
import { systemClock, requestPath, type Clock } from '@taizan/nest-auth'
import { AppLogger, BizException, currentContext } from '@taizan/nest-core'
import type { NextFunction, Request, Response } from 'express'
import { evaluateWithShadow, shadowWarning } from './gate-eval'
import type { PlatformGateway } from './platform-gateway'
import type { ResolvedBillingOptions } from './billing.options'
import { BILLING_CLOCK, BILLING_OPTIONS, PLATFORM_GATEWAY } from './tokens'

/**
 * C 端闸门生效的路径前缀。
 *
 * 只有 `/api/client`。`/api/public/*` **不在**里面——注册、店铺配置、支付回调都在
 * 那个前缀下，把它们一起拦掉的话，一家到期的店连续费回调都收不到
 * （回调进不来 → 订单不 fulfil → 永远到期）。
 */
export const CLIENT_GATE_PREFIXES: readonly string[] = ['/api/client'] as const

/** 路径是否落在 C 端闸门范围内。 */
export function isClientGatePath(path: string): boolean {
  return CLIENT_GATE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

@Injectable()
export class TenantGateMiddleware implements NestMiddleware {
  constructor(
    @Inject(PLATFORM_GATEWAY) private readonly gateway: PlatformGateway,
    @Inject(BILLING_OPTIONS) private readonly options: ResolvedBillingOptions,
    @Optional() @Inject(BILLING_CLOCK) private readonly clock: Clock = systemClock,
    @Optional() @Inject(AppLogger) private readonly logger?: AppLogger,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const path = requestPath(req as unknown as Parameters<typeof requestPath>[0])

    // 双保险：装配时已经限定了 forRoutes，这里再判一次。装配是可被下游改坏的
    // （谁手抄一份前缀清单漏了一个），这条判断改不坏。
    if (!isClientGatePath(path)) {
      next()
      return
    }

    const tenantId = currentContext()?.tenantId
    // 还没解析出租户：`TenantMiddleware` 会为此报 `1240400`（店铺不存在）。
    // 这里抢着报「打烊」是错的——店都还没定位到，谈不上开没开门。
    if (tenantId === undefined) {
      next()
      return
    }

    // 错误一律走 `next(error)` 而不是 `throw`：异步中间件里 throw 出去的 rejection
    // 只有 Express 5 接得住，Nest 自己不接，而这件事不该依赖 HTTP 适配器版本。
    try {
      const view = await this.gateway.getTenant(tenantId)
      if (view === null) {
        next()
        return
      }

      const gate = evaluateWithShadow(
        view,
        new Date(this.clock.now()),
        this.options.enforce,
        'client',
      )

      if (gate.code !== null) {
        next(
          new BizException(ErrorCode.SHOP_CLOSED, closedMessage(gate.effective.reason), {
            reason: gate.effective.reason,
            phase: gate.effective.phase,
            shopName: view.name,
          }),
        )
        return
      }

      if (gate.shadowed) {
        this.logger?.warn(
          shadowWarning(view, gate, (req.method ?? 'GET').toUpperCase(), path),
          'TenantGate',
        )
      }

      next()
    } catch (error) {
      next(error)
    }
  }
}

/** 给顾客看的文案。**不写「欠费」「到期」**——那是商家和平台之间的事，顾客不必知道。 */
function closedMessage(reason: string | null): string {
  switch (reason) {
    case 'SUSPENDED':
    case 'DEREGISTERED':
      return '店铺已停止营业'
    case 'PENDING':
      return '店铺尚未开业'
    default:
      return '店铺已打烊，请稍后再来'
  }
}
