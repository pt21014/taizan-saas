/**
 * `@taizan/billing-rules` —— 套餐 / 配额 / 功能开关 / 到期闸门 / 续费白名单 / 续期日期的**纯函数**集合。
 *
 * 零框架依赖（只用 `@taizan/contracts` 的错误码），不碰数据库、不读时钟、不读进程时区。
 * 执行层（守卫、中间件、物化计数）在 `@taizan/nest-billing`；本包只回答「按规则该不该放行、算出来是几号」。
 *
 * ---
 *
 * # 四条不可退让
 *
 * **① 到期永远现算，不落 `EXPIRED` 状态。**
 * `TenantStatus` 刻意只有 `TRIAL/ACTIVE/SUSPENDED/DEREGISTERED`。存一个到期状态位就得有人负责
 * 在到期那一刻把它改过来，定时任务漏跑一次商家就免费用下去——而且这种漏跑不报错、没人会发现。
 *
 * **② 续费路径永远可写。**
 * {@link ALWAYS_WRITABLE_PREFIXES} 三条前缀在任何闸门下都放行写操作。锁掉它们就是
 * 「到期 → 后台只读 → 续不了费 → 永远到期」的死循环，而平台恰恰是想收钱的那一方。
 *
 * **③ 三道闸门并列不合并。**
 * 套餐到期 `1440301`/`1440302`、配额超限 `1540301`、功能未包含 `1540302` 是四个独立的码。
 * 合成一个笼统的「无权限」，商家不知道该去续费、升套餐、还是删两个员工，只会来问客服。
 *
 * **④ 配额与功能都是三态。**
 * 配额：`null` 不限量 / `0` 一个都不给 / 正整数为上限；功能：`null` 全部可用 / `[]` 一个都不给。
 * 合并成两态的那一天，所有存量商家会同时失去（或同时白得）一整批能力。
 *
 * ---
 *
 * @packageDocumentation
 */

export {
  evaluateTenantGate,
  gateToErrorCode,
  type GatePhase,
  type GateReason,
  type GateSide,
  type TenantGateInput,
  type TenantGateResult,
  type TenantStatusLike,
} from './gate'

export {
  QUOTA_EXCEEDED_CODE,
  checkQuota,
  quotaToErrorCode,
  resolveQuota,
  type PlanQuotas,
  type QuotaCheckResult,
} from './quota'

export {
  FEATURE_NOT_INCLUDED_CODE,
  WRITE_METHODS,
  checkFeatureAccess,
  featureToErrorCode,
  hasFeature,
  matchFeatureByPath,
  normalizePathPrefix,
  pathHasPrefix,
  type FeatureDef,
} from './feature'

export {
  ALWAYS_WRITABLE_PREFIXES,
  assertFeatureNotShadowingRenewal,
  findRenewalShadowConflicts,
  isRenewalPath,
  type AlwaysWritablePrefix,
  type RenewalShadowConflict,
} from './renewal'

export {
  DAY_MS,
  DEFAULT_TIMEZONE,
  MAX_PERIODS_PER_ORDER,
  addCalendarDays,
  addCalendarMonths,
  assertValidDate,
  calendarDayOf,
  computeRefundRollback,
  computeRenewal,
  computeTrialEnd,
  daysInMonth,
  diffCalendarDays,
  endOfCalendarDay,
  endOfDayInZone,
  startOfCalendarDay,
  zonedParts,
  type CalendarDay,
  type ComputeRenewalInput,
  type ComputeRenewalResult,
  type RefundRollbackInput,
  type RefundRollbackResult,
  type ZonedParts,
} from './period'
