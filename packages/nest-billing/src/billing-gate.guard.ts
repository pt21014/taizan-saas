/**
 * `BillingGateGuard`：商家后台的计费闸门（蓝图 §4.3 守卫链第三环）。
 *
 * 守卫链顺序在 `apps/api/src/bootstrap/app.module.ts` 一处定死：
 * `GlobalAuthGuard` → `PermissionsGuard` → `BillingGateGuard`。
 * 本包**不**自己注册 `APP_GUARD`，只导出 {@link provideBillingGateGuard} 让 app 按顺序摆。
 * 顺序不能反：闸门要读 `req.principal.tenantId`，那是 `GlobalAuthGuard` 挂上去的；
 * 而权限判定应当先于计费判定——「你没这个权限」比「你的店到期了」对用户更准确。
 *
 * ## 四条放行规则（顺序即优先级）
 *
 * 1. **不是 staff 身份**：平台超管与 C 端会员不走这道闸门。平台超管尤其不能被锁——
 *    平台自己要能给到期的商家操作续费。
 * 2. **不是写方法**：`GET`/`HEAD`/`OPTIONS` 一律放行。到期是「只读」不是「关门」，
 *    商家得能进来看到自己欠了多少、去哪续。
 * 3. **续费白名单**：`isRenewalPath(path)` 命中就放行，
 *    否则就是「到期 → 只读 → 续不了费 → 永远到期」的死循环。
 * 4. 以上都不命中，才真的判 {@link evaluateWithShadow}。
 *
 * ## 两个错误码是分开的
 *
 * 到期是 `1440301`（去续费），功能没买是 `1540302`（去升级套餐）。合成一个
 * 「无权限」的话，商家不知道该掏钱续期还是掏钱升档，只会来问客服。
 *
 * @packageDocumentation
 */

import {
  Inject,
  Injectable,
  Optional,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common'
import {
  checkFeatureAccess,
  isRenewalPath,
  WRITE_METHODS,
  type FeatureDef,
} from '@taizan/billing-rules'
import { ErrorCode } from '@taizan/contracts'
import { systemClock, requestPath, type Clock, type RequestWithPrincipal } from '@taizan/nest-auth'
import { AppLogger, BizException, currentContext } from '@taizan/nest-core'
import { evaluateWithShadow, shadowWarning } from './gate-eval'
import type { PlatformGateway } from './platform-gateway'
import type { ResolvedBillingOptions } from './billing.options'
import { BILLING_CLOCK, BILLING_FEATURES, BILLING_OPTIONS, PLATFORM_GATEWAY } from './tokens'

/** 带 method 的请求（`requestPath` 要的那部分之外，只多一个 `method`）。 */
type GatedRequest = RequestWithPrincipal & { method?: string }

@Injectable()
export class BillingGateGuard implements CanActivate {
  constructor(
    @Inject(PLATFORM_GATEWAY) private readonly gateway: PlatformGateway,
    @Inject(BILLING_OPTIONS) private readonly options: ResolvedBillingOptions,
    @Inject(BILLING_FEATURES) private readonly features: readonly FeatureDef[],
    @Optional() @Inject(BILLING_CLOCK) private readonly clock: Clock = systemClock,
    @Optional() @Inject(AppLogger) private readonly logger?: AppLogger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 只管 HTTP。队列 job 与 cron 里的写操作不经过这里——它们要不要受闸门管，
    // 由发起方自己调 `PlatformGateway` 决定（大多数不该管：到期后系统仍要把
    // 已收的钱结算完、把已发的通知补完）。
    if (context.getType() !== 'http') return true

    const req = context.switchToHttp().getRequest<GatedRequest>()
    const principal = req.principal
    if (principal?.kind !== 'staff') return true

    const method = (req.method ?? 'GET').toUpperCase()
    if (!WRITE_METHODS.has(method)) return true

    const path = requestPath(req)
    if (isRenewalPath(path)) return true

    // staff token 必带 tenantId（`GlobalAuthGuard` 保证），这里的兜底是为了
    // 让「有人绕过守卫链顺序」时表现为放行而不是 500——闸门不该是 500 的来源。
    const tenantId = principal.tenantId ?? currentContext()?.tenantId
    if (tenantId === undefined) return true

    const view = await this.gateway.getTenant(tenantId)
    // 租户读不到：那是 404 该报的事，闸门在这里报 403 只会误导。
    if (view === null) return true

    const now = new Date(this.clock.now())
    const gate = evaluateWithShadow(view, now, this.options.enforce, 'admin')

    if (gate.code !== null) {
      throw new BizException(ErrorCode.PLAN_READONLY, readonlyMessage(gate.effective.reason), {
        reason: gate.effective.reason,
        phase: gate.effective.phase,
        daysLeft: gate.effective.daysLeft,
        planExpireAt: view.planExpireAt,
        // 前端据此把「去续费」按钮指向白名单里的账单页，而不是弹一个死胡同提示。
        renewalPath: '/api/admin/billing',
      })
    }

    if (gate.shadowed) {
      this.logger?.warn(shadowWarning(view, gate, method, path), 'BillingGate')
    }

    // ── 功能开关。刻意**不受 BILLING_ENFORCE 管** ────────────────────────
    // 那个开关要解决的问题是「存量租户 planExpireAt 为空，一开就集体只读」，
    // 是个迁移期问题。功能开关没有这个问题：套餐没配 features 时是 `null`
    // （= 全部可用），本来就不会误伤任何人；反过来把它一起关掉，等于平台卖了
    // 高低档套餐却对谁都不生效，而且不报错——这种「静默不生效」最难发现。
    const access = checkFeatureAccess(this.features, view.features, path, method)
    if (!access.allowed) {
      throw new BizException(
        ErrorCode.FEATURE_NOT_INCLUDED,
        `当前套餐不包含「${access.required?.name ?? access.required?.key ?? '该功能'}」，请升级套餐`,
        {
          feature: access.required?.key ?? null,
          featureName: access.required?.name ?? null,
          planCode: view.planCode,
        },
      )
    }

    return true
  }
}

/** 按 reason 给一句人话。默认文案「套餐已到期，后台暂只读，请续费」对冻结/注销是错的。 */
function readonlyMessage(reason: string | null): string {
  switch (reason) {
    case 'SUSPENDED':
      return '店铺已被平台冻结，后台暂只读，请联系平台'
    case 'DEREGISTERED':
      return '店铺已提交注销，后台暂只读'
    case 'PENDING':
      return '店铺尚未开通套餐，后台暂只读，请先选购套餐'
    default:
      return '套餐已到期，后台暂只读，请续费'
  }
}
