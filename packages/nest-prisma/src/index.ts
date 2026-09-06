/**
 * `@taizan/nest-prisma`：多租户隔离的**执行层**。
 *
 * ## 分工（这条边界是本包存在的理由）
 *
 * - **决策**在 `@taizan/tenant-scope`：`planTenantScope()` 是纯函数，零依赖，
 *   四条不可退让（`where` 用 `AND` 包裹 / `upsert` 显式分支 / `findUnique` 补
 *   `select.tenantId` / 未识别操作抛错）全部写在那里，被 100% 单测覆盖。
 * - **执行**在这里：`$extends` 拿到 `(model, operation, args)` 之后，原样交给决策函数，
 *   再按返回的 `ScopePlan` 分四支办事。本包**一条隔离规则都不重写**，
 *   `no-bypass.spec.ts` 扫描源码强制这件事。
 *
 * ## 三个扩展的叠加顺序（不能换）
 *
 * ```
 * base.$extends(tenant).$extends(softDelete).$extends(ulid)
 *      ↑ 最外层，先执行    ↑ 中间             ↑ 最内层，最后执行
 * ```
 *
 * Prisma 的 query 钩子按 `$extends` 的先后组合，**先加的先执行**。租户必须最外层：
 * 软删会把 `delete` 改写成 `update`，租户判断必须基于调用方真正发起的那个操作。
 *
 * ## 两个句柄
 *
 * `prisma.tenant`（业务代码只准用它）与 `prisma.raw`（无租户注入，只允许登录跨租户找
 * 账号、支付回调定位租户、平台后台三处）。想让 raw 的使用点可扫描，注入
 * {@link RawPrismaService}。
 *
 * @packageDocumentation
 */

// ── 装配 ────────────────────────────────────────────────────────────────
export { createDefaultPrismaClient, PrismaModule } from './prisma.module'
export type { PrismaModuleAsyncOptions, PrismaModuleOptions } from './prisma.options'
export { DbHealthIndicator, PrismaService, type ExtendedPrismaClient } from './prisma.service'
export { RawPrismaService } from './raw-prisma.service'
export { PRISMA_BASE_CLIENT, PRISMA_MODULE_OPTIONS } from './tokens'

// ── 扩展 ────────────────────────────────────────────────────────────────
export { createTenantExtension, type TenantExtensionDeps } from './extensions/tenant'
export {
  createSoftDeleteExtension,
  hardDelete,
  hardDeleteMany,
  WITH_DELETED_ARG,
  type SoftDeleteExtensionOptions,
} from './extensions/soft-delete'
export {
  defineClientBoundQueryExtension,
  defineModelAndQueryExtension,
  defineQueryExtension,
  extensionContext,
  type ModelExtensionContext,
  type ModelOverride,
  type PrismaExtension,
} from './define-extension'
export { createUlidExtension, type UlidExtensionOptions } from './extensions/ulid'
export {
  updateWithVersion,
  type UpdateWithVersionParams,
  type UpdateWithVersionResult,
} from './extensions/optimistic-lock'

// ── 错误 ────────────────────────────────────────────────────────────────
export {
  isOptimisticLockError,
  OptimisticLockError,
  type OptimisticLockErrorContext,
} from './errors'

// ── 结构化类型 ──────────────────────────────────────────────────────────
export {
  callOperation,
  isPlainObject,
  modelDelegateOf,
  toArgsObject,
  type DelegateOperation,
  type ModelDelegate,
  type PrismaArgs,
  type PrismaClientLike,
  type QueryHook,
  type QueryHookParams,
} from './types'
