/**
 * `@taizan/nest-rbac`：RBAC 的**执行层**（蓝图 §4.4、T1-2）。
 *
 * ## 三条不变量（改这个包之前先读这三条）
 *
 * 1. **判定逻辑一行都不在这里**。表达式求值、角色展开、菜单裁剪、数据范围翻译全部在
 *    `@taizan/rbac-core`（纯函数、零框架依赖、100% 单测）。本包只做两件事：
 *    把 Nest 的请求上下文喂给那些函数，以及把注册表镜像进 DB。
 *    在本包里看到 `if (granted.has(...))` 之类的判定，那就是一处需要被删掉的重复实现。
 * 2. **代码是真源，DB 是镜像**。权限点与菜单由 `definePermissions()` / `defineMenus()`
 *    在代码里声明，`taizan-rbac-sync` 单向覆盖写进 `Permission` / `Menu` 表。
 *    人工改库会在下次同步被冲掉，这是设计而不是缺陷。
 * 3. **守卫链顺序不在本包决定**。`PermissionsGuard` 默认**不**自动挂 `APP_GUARD`；
 *    顺序在 `apps/api/src/bootstrap/app.module.ts` 一处定死，用
 *    {@link providePermissionsGuard} 显式装。
 *
 * ## 装配
 *
 * ```ts
 * CoreModule.forRoot({ ... }),        // 必须在前
 * PrismaModule.forRoot({ ... }),
 * AuthModule.forRoot({ ... }),
 * RbacModule.forRoot({ permissions: [PERMISSIONS], menus: [MENUS], features: FEATURES }),
 * ```
 *
 * `GET /api/admin/auth/bootstrap` 的 **HTTP 控制器不在本包**——URL、DTO、Swagger、
 * `shops`/`quotas` 从哪查都是应用的决定，`apps/api` 侧的薄控制器注入
 * {@link BootstrapService} 即可。
 *
 * @packageDocumentation
 */

// ── 装配 ────────────────────────────────────────────────────────────────
export {
  provideDataScopeInterceptor,
  providePermissionsGuard,
  RbacModule,
  type RbacModuleOptions,
} from './rbac.module'
export {
  FEATURE_REGISTRY,
  MENU_REGISTRY,
  PERMISSION_REGISTRY,
  RBAC_CLOCK,
  RBAC_OPTIONS,
  SUBTREE_RESOLVER,
} from './tokens'

// ── 注册表 ──────────────────────────────────────────────────────────────
export {
  FeatureRegistry,
  MenuRegistry,
  PermissionRegistry,
  type FeatureDef,
  type PermissionTable,
  type RegisteredPermission,
} from './registry'

// ── 装饰器 ──────────────────────────────────────────────────────────────
export {
  DATA_SCOPE_KEY,
  DataScope,
  REQUIRE_PERMISSION_KEY,
  RequirePermission,
  SCOPE_WHERE_PROPERTY,
  ScopeWhere,
  type DataScopeOptions,
} from './decorators'

// ── 守卫与拦截器 ────────────────────────────────────────────────────────
export { GRANTED_PERMISSIONS_PROPERTY, PermissionsGuard } from './permissions.guard'
export {
  DataScopeInterceptor,
  SelfOnlySubtreeResolver,
  type ScopedPrincipal,
  type SubtreeResolver,
} from './data-scope.interceptor'
export {
  ROLE_CACHE_MAX,
  ROLE_CACHE_TTL_MS,
  RolePermissionsService,
  systemRbacClock,
  type RbacClock,
} from './role-permissions.service'

// ── 下发 ────────────────────────────────────────────────────────────────
export { BootstrapService, type BuildBootstrapOptions } from './bootstrap.service'

// ── 错误码 ──────────────────────────────────────────────────────────────
export { RBAC_ERRORS } from './errors'

// ── 注册表 → DB 同步 ────────────────────────────────────────────────────
export {
  buildMenuRows,
  buildPermissionRows,
  RbacSyncService,
  type MenuRow,
  type PermissionRow,
  type RbacSyncPrisma,
  type SyncOptions,
  type SyncReport,
} from './sync/sync.service'
export { mirrorId } from './sync/mirror-id'
export {
  parseArgs,
  runSyncCli,
  type CliArgs,
  type CliDeps,
  type RbacSyncAdapter,
  type RbacSyncContext,
} from './sync/run'

// ── 架构约束扫描器（蓝图 §8 spec 6 / 7 的样板实现，供 apps/api 复用）────
export {
  crossCheckPermissions,
  readSourceFiles,
  scanRequirePermissionUsages,
  SENTINEL_EXPECTATION,
  SENTINEL_SOURCE,
  type CrossCheckOptions,
  type PermissionDriftReport,
  type PermissionDriftViolation,
  type RequirePermissionUsage,
  type ScanInput,
  type SourceFile,
} from './arch/require-permission.scan'
export {
  verifyMenuComponentMap,
  type MenuMapReport,
  type MenuMapViolation,
  type VerifyMenuMapOptions,
} from './arch/menu-component-map'
