/**
 * `@taizan/prisma-base` —— 框架基础表。
 *
 * 本包提供四样东西，其中前两样是**对外契约**，改动按破坏性变更对待：
 * 1. `schema/` 下 8 个 Prisma 片段 + 1 个 datasource 片段（表结构本身）；
 * 2. {@link BASE_TENANT_MODELS} / {@link ENCRYPTED_COLUMNS}（哪些表受隔离、哪些列是密文）；
 * 3. `taizan-schema-sync` / `taizan-verify-schema` 两个 CLI；
 * 4. {@link seedBase}（幂等基础 seed）。
 *
 * 数据约定（蓝图 §3.1，不可协商）：ULID 主键、camelCase 不 `@map`、状态一律 enum、
 * 金额一律 `*Cents Int`、软删 `deletedAt`、租户列 NOT NULL、不建指向 Tenant 的外键。
 * 这些约定由 `src/schema.spec.ts` 逐条静态断言，不是靠自觉。
 *
 * @packageDocumentation
 */

export { PRISMA_BASE_PACKAGE_NAME, PRISMA_BASE_VERSION } from './version'

export {
  BASE_LOCK_FILE_NAME,
  BASE_SCHEMA_DIR_NAME,
  BASE_SCHEMA_FILES,
  MANAGED_FILE_BANNER,
  findPackageRoot,
  resolveBaseSchemaDir,
} from './schema-files'

export { BASE_PLATFORM_ALLOWLIST, BASE_TENANT_MODELS, createBaseRegistry } from './tenant-models'

export {
  ENCRYPTED_COLUMNS,
  ENCRYPTED_COLUMN_SUFFIX,
  type EncryptedColumn,
} from './encrypted-columns'

export {
  buildBaseSchemaLock,
  checkSchemaSync,
  hashSchemaContent,
  normalizeEol,
  parseSchemaSyncArgs,
  readBaseSchemaFiles,
  runSchemaSyncCli,
  writeSchemaSync,
  type BaseSchemaLock,
  type SchemaSyncCheckResult,
  type SchemaSyncCliArgs,
  type SchemaSyncDiff,
  type SchemaSyncWriteResult,
} from './cli/sync'

export { runBaseVerifySchemaCli, withBaseArgs } from './cli/verify'

export {
  LINT_SENTINEL_SCHEMA,
  formatSchemaLintReport,
  lintSchemaConventions,
  parsePrismaSchema,
  runSchemaLintSentinel,
  type PrismaEnum,
  type PrismaField,
  type PrismaModel,
  type PrismaSchemaAst,
  type SchemaLintFinding,
  type SchemaLintOptions,
} from './schema-lint'

export {
  BASE_PLAN_SEEDS,
  BASE_ROLE_PRESETS,
  DEFAULT_ADMIN_NAME,
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_ADMIN_USERNAME,
  DEFAULT_SCRYPT_PARAMS,
  DEMO_OWNER_NAME,
  DEMO_OWNER_PASSWORD,
  DEMO_OWNER_PHONE,
  DEMO_TENANT_NAME,
  DEMO_TENANT_SLUG,
  DEMO_TRIAL_DAYS,
  NOTIFY_TEMPLATE_KEYS,
  NOTIFY_TEMPLATE_SEEDS,
  OWNER_ROLE_CODE,
  PASSWORD_HASH_ALGORITHM,
  PLAN_EXPIRE_STAGES,
  PLAN_EXPIRE_STAGE_DAYS_LEFT,
  STANDARD_PLAN_CODE,
  TRIAL_PLAN_CODE,
  hashPassword,
  hashPasswordSync,
  needsRehash,
  parsePasswordHash,
  planExpireInboxKey,
  planExpireSmsKey,
  seedBase,
  seedDemoTenant,
  seedNotifyTemplates,
  seedPlans,
  seedPlatformAdmin,
  seedRolePresets,
  verifyPassword,
  verifyPasswordSync,
  type NotifyTemplateSeedSpec,
  type ParsedPasswordHash,
  type PlanExpireStage,
  type PlanSeedSpec,
  type RolePresetSeedSpec,
  type ScryptParams,
  type SeedBaseOptions,
  type SeedBaseResult,
  type SeedContext,
  type SeedDelegate,
  type SeedNotifyTemplatesInput,
  type SeedRow,
  type SeedUpsertArgs,
} from './seed/index'
