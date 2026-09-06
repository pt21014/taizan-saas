/**
 * `@taizan/tenant-scope` —— 多租户隔离的决策层。
 *
 * 零运行时依赖：不 import `@prisma/client`、不 import `@nestjs/*`、不 import 任何 npm 包，
 * 只有 `verify.ts` 用到 `node:fs` / `node:path`。这样它才能被单测 100% 覆盖、被生成器
 * 产出的每个项目直接依赖，也才能保证「隔离规则只有一份」。
 *
 * 三块内容：
 * - {@link planTenantScope}：一次 Prisma 调用该怎么隔离（纯函数，四条不可退让见 `plan.ts` 文件头）。
 * - {@link createTenantModelRegistry}：哪些表受隔离约束（启动期登记、freeze 后不可改）。
 * - {@link verifySchema}：注册表与 `.prisma` 双向比对 + 解析器哨兵，防「漏登记 = 静默泄漏」。
 *
 * 执行层（Prisma Client Extension、Nest 模块）在 `@taizan/nest-prisma`，本包不碰运行时。
 *
 * @packageDocumentation
 */

export {
  TenantScopeError,
  isTenantScopeError,
  type TenantScopeErrorContext,
  type TenantScopeErrorReason,
} from './errors'

export {
  CREATE_OPERATIONS,
  SUPPORTED_OPERATIONS,
  UNIQUE_MUTATION_OPERATIONS,
  UNIQUE_READ_OPERATIONS,
  WHERE_OPERATIONS,
  assertResultOwner,
  modelToClientKey,
  planTenantScope,
  type AssertResultOwnerParams,
  type NestedCreateStrategy,
  type PlanTenantScopeParams,
  type ScopePlan,
  type TenantModelLookup,
} from './plan'

export { createTenantModelRegistry, type TenantModelRegistry } from './registry'

export {
  SENTINEL_SCHEMA,
  formatVerifySchemaReport,
  parsePrismaModels,
  runParserSentinel,
  verifySchema,
  type InvalidAllowlistEntry,
  type PrismaModelInfo,
  type PrismaSchemaParser,
  type TenantModelAllowlistEntry,
  type VerifySchemaOptions,
  type VerifySchemaResult,
} from './verify'
