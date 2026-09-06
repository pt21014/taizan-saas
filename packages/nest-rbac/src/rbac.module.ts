/**
 * 装配入口。
 *
 * @packageDocumentation
 */

import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common'
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core'
import type { MenuDef } from '@taizan/contracts'
import { BootstrapService } from './bootstrap.service'
import {
  DataScopeInterceptor,
  SelfOnlySubtreeResolver,
  type SubtreeResolver,
} from './data-scope.interceptor'
import { PermissionsGuard } from './permissions.guard'
import {
  FeatureRegistry,
  MenuRegistry,
  PermissionRegistry,
  type FeatureDef,
  type PermissionTable,
} from './registry'
import { RolePermissionsService, systemRbacClock, type RbacClock } from './role-permissions.service'
import { RbacSyncService } from './sync/sync.service'
import {
  FEATURE_REGISTRY,
  MENU_REGISTRY,
  PERMISSION_REGISTRY,
  RBAC_CLOCK,
  SUBTREE_RESOLVER,
} from './tokens'

/** {@link RbacModule.forRoot} 的选项。 */
export interface RbacModuleOptions {
  /**
   * 各业务模块的 `definePermissions()` 结果，按数组传进来合并。
   *
   * 之所以是「数组的数组」而不是让每个模块自己 `register()`：装配顺序一旦分散到
   * 各个模块的 `onModuleInit`，「注册表在哪一刻算装完」就没有确定答案了，
   * 而守卫在第一个请求进来时就要读它。一处传全，一处装完。
   */
  permissions: readonly PermissionTable[]
  /** 各业务模块的 `defineMenus()` 结果。 */
  menus: readonly (readonly MenuDef[])[]
  /** 套餐功能项（`@taizan/billing-rules` 的注册表可直接传，结构类型兼容）。 */
  features?: readonly FeatureDef[]
  /**
   * `SUB_TREE` 数据范围的组织树解析器。不传就用 {@link SelfOnlySubtreeResolver}
   * （退化成只看自己，方向是少给）。
   */
  subtreeResolver?: SubtreeResolver
  /**
   * 是否把 {@link PermissionsGuard} 注册成 `APP_GUARD`，默认 **`false`**。
   *
   * 默认关掉是因为守卫链的**顺序**应当在 `apps/api/src/bootstrap/app.module.ts`
   * 一处定死（蓝图 §4.3）：`GlobalAuthGuard → PermissionsGuard → BillingGateGuard`，
   * 用 {@link providePermissionsGuard} 显式按顺序装。
   *
   * ## 一个必须知道的顺序陷阱
   *
   * Nest 的全局守卫按「**模块实例化顺序** → 模块内 `providers` 数组顺序」执行，
   * 而**根模块排在它 `imports` 的模块之前**。于是：
   *
   * - 写在**同一个** `providers` 数组里的多个 `APP_GUARD`，数组顺序就是执行顺序 —— 这是想要的形状；
   * - 但 `@taizan/nest-auth` 目前**没有导出 `GlobalAuthGuard` 类**（它在 `AuthModule` 的
   *   `providers` 里，不在 `exports` 里），应用侧拿不到它来 `useExisting`。此时根模块里的
   *   `providePermissionsGuard()` 会跑在 `AuthModule` 内部注册的 `GlobalAuthGuard`
   *   **前面**，表现是 `req.principal` 还没挂、所有带权限声明的路由一律 `1340300`。
   *   本包的集成测试撞过这个，所以记在这里。
   *
   * 在 nest-auth 导出 `GlobalAuthGuard` 之前，可行的装法是让两个模块各自注册、靠
   * `imports` 顺序定序（`AuthModule` 在 `RbacModule` 之前），也就是把这个选项设成 `true`。
   */
  registerGlobalGuard?: boolean
  /**
   * 是否把 {@link DataScopeInterceptor} 注册成 `APP_INTERCEPTOR`，默认 `false`，理由同上。
   */
  registerGlobalInterceptor?: boolean
  /** 时钟。测试里传可推进的假时钟，用来验证 30 秒角色缓存。 */
  clock?: RbacClock
}

/**
 * RBAC 执行层模块（蓝图 T1-2）。
 *
 * ## 一次 `forRoot()` 接好这些
 *
 * - 三张注册表（{@link PermissionRegistry} / {@link MenuRegistry} / {@link FeatureRegistry}），
 *   分别用 `PERMISSION_REGISTRY` / `MENU_REGISTRY` / `FEATURE_REGISTRY` 三个 token 注入；
 * - {@link RolePermissionsService}（角色 → 权限点集合，30 秒进程内缓存 + `invalidateRoles`）；
 * - {@link PermissionsGuard} 与 {@link DataScopeInterceptor}（**默认不自动挂全局**，见选项）；
 * - {@link BootstrapService}（`bootstrap` 响应的组装，不含控制器）；
 * - {@link RbacSyncService}（注册表 → DB 镜像）。
 *
 * ## `@Global()` 的理由
 *
 * `@RequirePermission()` 会出现在几乎每个业务模块的控制器上，而守卫是全局的；
 * 让每个模块 `imports: [RbacModule]` 只是噪音。
 *
 * ## 前置条件
 *
 * 必须在 `CoreModule.forRoot()`、`PrismaModule.forRoot()`、`AuthModule.forRoot()`
 * **之后**导入：角色查询要 `PrismaService`，守卫要读 `GlobalAuthGuard` 挂上的 `req.principal`。
 */
@Global()
@Module({})
export class RbacModule {
  static forRoot(options: RbacModuleOptions): DynamicModule {
    const {
      permissions: permissionTables,
      menus: menuBatches,
      features = [],
      subtreeResolver = new SelfOnlySubtreeResolver(),
      registerGlobalGuard = false,
      registerGlobalInterceptor = false,
      clock = systemRbacClock,
    } = options

    // 注册表在 forRoot() 里**同步构造完**：重复 code、菜单引用未注册权限点这类错误
    // 会在进程启动时炸出来，而不是等第一个请求。
    const permissionRegistry = new PermissionRegistry(permissionTables)
    const menuRegistry = new MenuRegistry(permissionRegistry, menuBatches)
    const featureRegistry = new FeatureRegistry(features)

    const providers: Provider[] = [
      { provide: PERMISSION_REGISTRY, useValue: permissionRegistry },
      { provide: MENU_REGISTRY, useValue: menuRegistry },
      { provide: FEATURE_REGISTRY, useValue: featureRegistry },
      { provide: SUBTREE_RESOLVER, useValue: subtreeResolver },
      { provide: RBAC_CLOCK, useValue: clock },
      RolePermissionsService,
      PermissionsGuard,
      DataScopeInterceptor,
      BootstrapService,
      RbacSyncService,
    ]

    if (registerGlobalGuard) {
      // useExisting 而不是 useClass：守卫里那个「已经就未注册 code 报过错」的 Set
      // 必须是同一份，否则告警要刷两遍。
      providers.push({ provide: APP_GUARD, useExisting: PermissionsGuard })
    }
    if (registerGlobalInterceptor) {
      providers.push({ provide: APP_INTERCEPTOR, useExisting: DataScopeInterceptor })
    }

    return {
      module: RbacModule,
      providers,
      exports: [
        PERMISSION_REGISTRY,
        MENU_REGISTRY,
        FEATURE_REGISTRY,
        SUBTREE_RESOLVER,
        RBAC_CLOCK,
        RolePermissionsService,
        PermissionsGuard,
        DataScopeInterceptor,
        BootstrapService,
        RbacSyncService,
      ],
    }
  }
}

/**
 * 把 {@link PermissionsGuard} 装进 `APP_GUARD` 的助手。
 *
 * 守卫链顺序 = `providers` 数组里 `APP_GUARD` 出现的先后。应用侧照抄这个形状，
 * **顺序写在一个地方，一眼能看全**：
 *
 * ```ts
 * // apps/api/src/bootstrap/app.module.ts
 * providers: [
 *   { provide: APP_GUARD, useExisting: GlobalAuthGuard },  // 1. 认证（默认拒绝）
 *   providePermissionsGuard(),                             // 2. 权限点
 *   provideBillingGateGuard(),                             // 3. 到期闸门
 *   provideDataScopeInterceptor(),                         // 4.（拦截器）数据范围
 * ]
 * ```
 */
export function providePermissionsGuard(): Provider {
  return { provide: APP_GUARD, useExisting: PermissionsGuard }
}

/** 把 {@link DataScopeInterceptor} 装进 `APP_INTERCEPTOR` 的助手，用法同上。 */
export function provideDataScopeInterceptor(): Provider {
  return { provide: APP_INTERCEPTOR, useExisting: DataScopeInterceptor }
}
