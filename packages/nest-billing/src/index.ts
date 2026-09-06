/**
 * `@taizan/nest-billing`：计费闸门的**执行层**（蓝图 §4.1 / §4.3 / §4.5）。
 *
 * ## 分工（这条边界是本包存在的理由）
 *
 * - **判定**在 `@taizan/billing-rules`：`evaluateTenantGate` / `checkQuota` / `hasFeature`
 *   / `matchFeatureByPath` / `isRenewalPath` 全是纯函数，零依赖，四条不可退让写在那里。
 * - **执行**在这里：从库里读租户与套餐拼成入参、缓存、把结论翻译成 `BizException`、
 *   把配额落回 `QuotaCounter`。本包**一条规则都不重写**。
 *
 * 想改「到期算不算」「宽限几天」「三态怎么定」，去改 `@taizan/billing-rules`。
 * 在这里加一个 `if` 就是让规则出现第二份实现，而两份里晚改的那份迟早漏掉一种状态。
 *
 * ## 四道闸门，四个码，各拦各的
 *
 * | 闸门 | 谁拦 | 码 | 商家该干什么 |
 * |---|---|---|---|
 * | 后台到期只读 | {@link BillingGateGuard} | `1440301` | 去续费 |
 * | C 端打烊 | {@link TenantGateMiddleware} | `1440302` | 去续费 |
 * | 配额超限 | {@link QuotaService} | `1540301` | 升套餐 / 先清理 |
 * | 功能没买 | {@link BillingGateGuard} | `1540302` | 升套餐 |
 *
 * 合成一个笼统的「无权限」，商家不知道该续费、升档、还是删两个员工，只会来问客服。
 *
 * ## 三件必须由 `apps/api` 做的接线
 *
 * 1. **守卫顺序**：`provideBillingGateGuard()` 摆在 `PermissionsGuard` 之后
 *    （蓝图 §4.3 要求顺序在 `app.module.ts` 一处定死，所以本包默认不自己注册）。
 * 2. **C 端中间件**：`BillingModule.forRoot({ registerClientMiddleware: true })`，
 *    且必须排在 `TenantMiddleware` 之后（否则读不到 tenantId，会静默放行）。
 * 3. **续费后 invalidate**：`PlanOrder` fulfil / 冻结 / 解冻 / 改套餐之后调
 *    `PlatformGateway.invalidate(tenantId)`，否则商家付完钱最多还要再等 30 秒。
 *
 * ## 打开 `BILLING_ENFORCE` 之前
 *
 * 跑 `bash deploy/checks/billing-check.sh`，它只读不写，回答「现在打开谁会被锁、
 * 谁会打烊、谁 7 天内到期」。开关关着时闸门照常计算并 `logger.warn`，
 * 两者互为印证（日志里 grep `BILLING_ENFORCE=false`）。
 *
 * @packageDocumentation
 */

// ── 装配 ────────────────────────────────────────────────────────────────
export { BillingModule, provideBillingGateGuard } from './billing.module'
export {
  readEnforceFromEnv,
  type BillingModuleOptions,
  type ResolvedBillingOptions,
} from './billing.options'
export {
  BILLING_CLOCK,
  BILLING_FEATURES,
  BILLING_OPTIONS,
  GATEWAY_OPTIONS,
  PLATFORM_GATEWAY,
} from './tokens'
export { BILLING_ENV_SCHEMA, BILLING_ENV_SHAPE, type BillingEnv } from './env'

// ── 平台网关 ────────────────────────────────────────────────────────────
export {
  GATE_CACHE_TTL_MS,
  normalizeFeatures,
  normalizeQuotas,
  PrismaPlatformGateway,
  QUOTA_MAX_RETRY,
  type PlatformGateway,
  type PlatformGatewayOptions,
  type QuotaMutationResult,
  type QuotaTx,
  type TenantGateView,
} from './platform-gateway'

// ── 闸门 ────────────────────────────────────────────────────────────────
export { BillingGateGuard } from './billing-gate.guard'
export {
  CLIENT_GATE_PREFIXES,
  isClientGatePath,
  TenantGateMiddleware,
} from './tenant-gate.middleware'
export { evaluateWithShadow, gateInputOf, shadowWarning, type ShadowGateResult } from './gate-eval'

// ── 配额 ────────────────────────────────────────────────────────────────
export { QuotaService, type QuotaUsage } from './quota.service'
export {
  ConsumeQuota,
  ConsumeQuotaInterceptor,
  CONSUME_QUOTA_KEY,
  type ConsumeQuotaMeta,
} from './consume-quota.decorator'

// ── 架构断言（蓝图 §8 第 8 条） ─────────────────────────────────────────
export {
  assertRenewalPrefixes,
  verifyRenewalPrefixes,
  type RenewalPrefixReport,
  type RenewalPrefixViolation,
} from './billing-routes'
