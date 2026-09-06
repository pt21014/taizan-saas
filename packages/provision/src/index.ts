/**
 * `@taizan/provision` —— 租户开通的**唯一一条路**。
 *
 * 平台后台开通、官网自助注册、批量导入存量商家，三条入口都调 {@link provisionTenant}，
 * 各自只负责自己那部分（限流、事务、审计、口令来源），**建店本身一个字都不许再写一遍**。
 *
 * ```ts
 * // raw-reason: 建租户是跨租户操作——这一刻租户还不存在，注入不了 tenantId。
 * const result = await prisma.raw.$transaction((tx) =>
 *   provisionTenant(
 *     tx,
 *     { slug, name, ownerPhone, ownerPassword, source: 'SIGNUP' },
 *     { now: () => new Date(), ulid, hashPassword, verifyPassword, rolePresets: BASE_ROLE_PRESETS },
 *   ),
 * )
 * ```
 *
 * 三条不可退让（详见 `provision.ts` 文件头）：
 *
 * 1. **`source` 不影响写进库里的任何一个字节**——`provision.spec.ts` 逐条比对
 *    `PLATFORM` 与 `SIGNUP` 的调用序列。这是「一条路」的可执行定义。
 * 2. **不下发 token**——注册成功后强制走一次登录，否则注册接口就是一个免验证码的登录口。
 * 3. **不改已有账号的口令**——一号多店要填对现有口令，验不过就什么都不建。
 *
 * @packageDocumentation
 */

export {
  DEFAULT_QUOTA_KINDS,
  OWNER_ROLE_CODE,
  buildProvisionAudit,
  provisionTenant,
  type ProvisionAuditPayload,
  type ProvisionDeps,
} from './provision'

export {
  DEFAULT_GRACE_DAYS,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_TRIAL_DAYS,
  NAME_MAX_LENGTH,
  NAME_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PHONE_PATTERN,
  assertOwnerPasswordPolicy,
  decideInitialStatus,
  normalizePhone,
  resolveTrialDays,
  validateSlug,
  validateTenantName,
  type CheckResult,
  type InitialStatusInput,
} from './rules'

export {
  RESERVED_SLUGS,
  SLUG_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  SLUG_PATTERN,
  isReservedSlug,
} from './reserved-slugs'

export {
  ProvisionError,
  isProvisionError,
  type ProvisionErrorReason,
  type ProvisionInput,
  type ProvisionResult,
  type ProvisionSource,
  type ProvisionTx,
  type QuotaCounterCreateInput,
  type RolePresetRow,
  type RolePresetSpec,
  type RoleSide,
  type StaffAccountRow,
  type TenantRow,
  type TenantStatusLike,
} from './types'

// spec 14 的扫描器（`scanTenantCreateCalls` 等）**不在这里导出**——它顶层
// `import { readdirSync } from 'node:fs'`，只给跑在 node 进程里的架构测试用。
// 混进这个浏览器可用的主入口会导致 `vite dev` 原生 ESM 加载整页崩溃
// （`apps/site` 曾经因此被迫绕过，见该应用 README「关键坑」）。
// 需要它的地方一律改从 `@taizan/provision/arch` 取（见 `src/arch/index.ts`）。
