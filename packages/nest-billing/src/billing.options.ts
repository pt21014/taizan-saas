/**
 * `BillingModule.forRoot()` 的入参与它归一化之后的形状。
 *
 * @packageDocumentation
 */

import type { FeatureDef } from '@taizan/billing-rules'
import type { Clock } from '@taizan/nest-auth'
import type { PlatformGateway, PlatformGatewayOptions } from './platform-gateway'

/** {@link BillingModule.forRoot} 的选项。 */
export interface BillingModuleOptions {
  /**
   * 功能开关注册表：平台一共卖哪些功能项、各自盖住哪些路径前缀。
   *
   * 空数组 = 不做功能开关判定（所有路径都不需要功能项）。这与租户侧
   * `Plan.features` 的三态是两回事，别混：这里是**目录**，那里是**这家店买到的**。
   *
   * 启动时会跑 {@link assertFeatureNotShadowingRenewal}，任何一条前缀盖住
   * `/api/admin/auth|billing|bootstrap` 都会直接拒启。
   */
  features: readonly FeatureDef[]
  /**
   * 计费闸门总开关。不传就读 `process.env.BILLING_ENFORCE`，仍然没有就是 `false`。
   *
   * **默认关**是蓝图 §4.5 的第四条不可退让：先上代码、照常计算并打 warn，
   * 配 `deploy/checks/billing-check.sh` 回答「谁会被锁」，确认影响面之后再打开。
   * 反过来先开的话，所有 `planExpireAt` 为空的存量租户会在部署那一刻集体只读。
   */
  enforce?: boolean
  /**
   * 换掉 `PlatformGateway` 实现（平台侧独立成服务之后就是在这里换成 HTTP 客户端）。
   * 不传就用 {@link PrismaPlatformGateway}。
   */
  gateway?: PlatformGateway
  /** 时钟。测试里传可推进的假时钟。 */
  clock?: Clock
  /** 传给 {@link PrismaPlatformGateway} 的装配项（缓存时长、租户配额覆盖加载器）。 */
  gatewayOptions?: PlatformGatewayOptions
  /**
   * 是否把 {@link BillingGateGuard} 注册成 `APP_GUARD`，默认 **`false`**。
   *
   * 默认关是有意的：守卫链顺序必须在 `apps/api` 的 `app.module.ts` 里一处定死
   * （蓝图 §4.3），模块各自往 `APP_GUARD` 里塞就没人说得清最终顺序。
   * app 侧用 {@link provideBillingGateGuard} 把它摆在 `PermissionsGuard` 之后。
   */
  registerGlobalGuard?: boolean
  /**
   * 是否把 {@link TenantGateMiddleware} 挂到 {@link CLIENT_GATE_PREFIXES}，默认 **`false`**。
   *
   * 同上：中间件顺序（`ContextMiddleware` → `TenantMiddleware` → 本中间件）
   * 是应用的决定，本包只提供类与前缀常量。
   */
  registerClientMiddleware?: boolean
}

/** {@link BILLING_OPTIONS} 里存的东西。 */
export interface ResolvedBillingOptions {
  enforce: boolean
  registerClientMiddleware: boolean
}

/**
 * 读 `BILLING_ENFORCE` 环境变量。
 *
 * 与 `@taizan/nest-core` 的 `envBoolean` 口径一致（`1/true/yes/on` 为真），
 * 但**拼错一律当假**——这里是运行期兜底，真正的拼写校验在 zod schema
 * （见 `src/env.ts`），那边会拒启。
 */
export function readEnforceFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['BILLING_ENFORCE']
  if (raw === undefined) return false
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}
