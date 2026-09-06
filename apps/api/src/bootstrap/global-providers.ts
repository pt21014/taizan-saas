/**
 * **守卫链与拦截器链的顺序，全仓只在这一个文件里定死**（蓝图 §4.3）。
 *
 * ## 为什么必须收口在一处
 *
 * Nest 里全局守卫的执行顺序 = **模块实例化顺序 → 同一模块内 provider 数组顺序**。
 * 也就是说，如果 `AuthModule` 自己挂一个 `APP_GUARD`、`RbacModule` 自己挂一个、
 * 应用再挂一个，最终顺序取决于「这三个模块谁先被实例化」——那是 import 图的副产物，
 * 改一行 import 就可能悄悄换掉守卫顺序。而守卫顺序错了的表现是：
 * `PermissionsGuard` 先跑，读 `req.principal` 读到 `undefined`，于是**放行**。
 *
 * 所以框架侧各包一律不自动挂（`AuthModule.forRoot({ registerGlobalGuard: false })`、
 * `RbacModule` / `BillingModule` 的 `registerGlobalGuard` 默认就是 `false`、
 * `@taizan/nest-audit` 只导出 `provideAuditInterceptor()`），由这里用**一个数组**按顺序列全。
 *
 * ## 定死的顺序
 *
 * ```
 * 守卫    RateLimitGuard → GlobalAuthGuard → PermissionsGuard → BillingGateGuard
 *         你打得太快了      认出你是谁         你能不能干这事      这家店还能不能写
 *
 * 拦截器  TransformInterceptor → RetryAfterInterceptor → DataScopeInterceptor → AuditInterceptor
 *         统一信封（CoreModule）  补 429 的 Retry-After     数据范围注入            审计（最后）
 * ```
 *
 * 每一步为什么在那个位置：
 * - `RateLimitGuard`（T2-6）必须**比认证更靠前**：限流要在解析 token
 *   之前就把洪水挡住，否则一台跑字典的机器会让每次尝试都触发一次 JWT 验签 + 一次查库；
 * - `GlobalAuthGuard` 必须在权限之前：后面每一个都要读它写进 `req.principal` 的东西；
 * - `PermissionsGuard` 在计费之前：「你本来就没这个权限」比「店到期了」更该优先告诉用户，
 *   否则一个无权限的员工会看到「请联系店主续费」，然后真的去催老板交钱；
 * - `BillingGateGuard` 最后：它是四道闸门里唯一会查库+缓存的，能被前面拒掉的请求
 *   不该白跑一次租户视图查询；
 * - `RetryAfterInterceptor` 补的是 `RateLimitGuard` 管不到的那一半：业务流程里
 *   （`AuthFlowService.countAttempt`）抛的 429 不经过守卫，只经过拦截器；
 * - `DataScopeInterceptor` 在审计之前：它往 `req.scopeWhere` 写东西，审计要能记到
 *   「这次操作实际用的数据范围」；
 * - `AuditInterceptor` 必须最后：它要记的是「这次操作最终成没成」，
 *   排在别的拦截器前面就会把被后面拦截器改写过的响应记成原始结果。
 *
 * 这个顺序由 `test/arch/guard-order.spec.ts`（静态读本文件的数组）守着：
 * 有人调换两行、或者在别处偷偷再挂一个 `APP_GUARD`，那条 spec 会红。
 *
 * @packageDocumentation
 */

import type { Provider } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core'
import { provideAuditInterceptor } from '@taizan/nest-audit'
import { GlobalAuthGuard, RateLimitGuard, RetryAfterInterceptor } from '@taizan/nest-auth'
import { provideBillingGateGuard } from '@taizan/nest-billing'
import { provideDataScopeInterceptor, providePermissionsGuard } from '@taizan/nest-rbac'

import { TenantScopeExceptionFilter } from './tenant-scope.filter'

/**
 * 全局守卫，**按执行顺序排列**。
 *
 * ## 为什么 `GlobalAuthGuard` 是 `useClass`，其余三个是 `useExisting`
 *
 * `AuthModule` 虽然把 `GlobalAuthGuard` 注册成了自己的 provider，但**没有把它放进
 * `exports`**——所以在 `AppModule` 里 `useExisting: GlobalAuthGuard` 解析不到，
 * 启动时直接 `Nest can't resolve dependencies of the APP_GUARD`。
 *
 * `useClass` 会在 `AppModule` 的上下文里新建一个实例。这在这里是安全的：
 * `AuthModule.forRoot({ registerGlobalGuard: false })` 已经关掉了框架自己那份注册，
 * 所以全进程只有这一个守卫**在跑**（AuthModule 里那个实例根本不会被调用）。
 * 它的依赖（`TokenService` / `SessionService` / `MEMBERSHIP_PROVIDER`）都由
 * `@Global()` 的 `AuthModule` 导出，解析得到。
 *
 * `RateLimitGuard`、`PermissionsGuard`、`BillingGateGuard` 反过来：三个都被各自的
 * `@Global()` 模块放进了 `exports`（`RateLimitGuard` 由 `AuthModule.forRoot()` 导出，
 * 见其 TSDoc），所以直接 `useExisting` 就能解析到——没必要再 `useClass` 造一个新实例。
 * 对 `PermissionsGuard` / `BillingGateGuard` 这**是必须**的（它们身上有实例状态：
 * 未注册 code 的去重告警集合、租户闸门视图的 30 秒缓存，多一个实例就是缓存各记各的）；
 * `RateLimitGuard` 本身无状态（真正的状态——`warnedTiers` 去重集合——在单例的
 * `RateLimitService` 里，跟这里用哪种 provider 无关），用 `useExisting` 只是顺手，
 * 不额外多建一个不必要的实例。
 */
export const GLOBAL_GUARDS: Provider[] = [
  // 0. 限流（T2-6）：**位置在认证之前**，理由见文件头。
  { provide: APP_GUARD, useExisting: RateLimitGuard },

  // 1. 认证：默认拒绝。没有 @Public() 的路由，无 token 一律 1140100。
  { provide: APP_GUARD, useClass: GlobalAuthGuard },

  // 2. 权限点：有 @RequirePermission 声明才判定，不满足 1340300。
  providePermissionsGuard(),

  // 3. 计费闸门：到期只读 1440301 / 功能未包含 1540302。必须在权限之后。
  provideBillingGateGuard(),
]

/**
 * 全局拦截器，**按执行顺序排列**。
 *
 * `TransformInterceptor` 不在这个数组里——它由 `CoreModule.forRoot()` 注册，
 * 而 `CoreModule` 是 `AppModule` imports 里的第一个，所以它必然排在这些之前
 * （Nest 的全局拦截器同样按「模块实例化顺序 → 数组顺序」跑）。
 * 把它再列一遍会变成两份实例，响应会被包两层信封。
 * 顺序上它就是链首那一环，`GUARD_ORDER` 之外的 {@link INTERCEPTOR_ORDER} 把它记了下来。
 */
export const GLOBAL_INTERCEPTORS: Provider[] = [
  // 1. 限流补漏：`RateLimitGuard` 只堵得住守卫阶段；`AuthFlowService.countAttempt`
  //    在业务流程（处理器）里抛的 429 不经过守卫，得靠拦截器的 catchError 补上
  //    Retry-After 头。无内部状态，useClass 就够，不需要单例。
  { provide: APP_INTERCEPTOR, useClass: RetryAfterInterceptor },

  // 2. 数据范围：把 @DataScope() 声明翻译成 req.scopeWhere 上的一段 Prisma where。
  provideDataScopeInterceptor(),

  // 3. 审计：必须是最后一个，它记的是「最终结果」。
  provideAuditInterceptor(),
]

/**
 * 全局异常过滤器。
 *
 * `AllExceptionsFilter` 由 `CoreModule.forRoot()` 注册。这里再挂一个专门认
 * `TenantScopeError` 的：**Nest 挑过滤器时是从后注册的往前找第一个匹配的**，
 * 所以这一个会先被问到，认不出来的再落回 core 那个（它是 `TenantScopeExceptionFilter`
 * 的父类，行为完全一致）。详见 `tenant-scope.filter.ts`。
 */
export const GLOBAL_FILTERS: Provider[] = [
  { provide: APP_FILTER, useClass: TenantScopeExceptionFilter },
]

/** 一次性拿到全部全局 provider，`app.module.ts` 里 spread 进 `providers`。 */
export const GLOBAL_PROVIDERS: Provider[] = [
  ...GLOBAL_FILTERS,
  ...GLOBAL_GUARDS,
  ...GLOBAL_INTERCEPTORS,
]

/**
 * 守卫的执行顺序，给 `test/arch/guard-order.spec.ts` 与人读。
 *
 * 这不是「注释」而是**断言的一半**：那条 spec 会把本文件里 `GLOBAL_GUARDS` 数组的
 * 源码文本解析出来，和这个常量逐项比对。改了数组不改这里（或反过来）都会红。
 */
export const GUARD_ORDER = [
  'RateLimitGuard',
  'GlobalAuthGuard',
  'PermissionsGuard',
  'BillingGateGuard',
] as const

/** 拦截器的执行顺序，同上。第一项由 `CoreModule` 注册，不在本文件的数组里。 */
export const INTERCEPTOR_ORDER = [
  'TransformInterceptor',
  'RetryAfterInterceptor',
  'DataScopeInterceptor',
  'AuditInterceptor',
] as const

/**
 * 将来要补进 {@link GLOBAL_GUARDS} 的守卫，按顺序，以及它该插在哪一项**之前**。
 *
 * 留成数据而不是散落的 TODO 注释：`guard-order.spec.ts` 会断言这些名字**还没有**
 * 出现在真实数组里（补上了就该同步从这里删掉），免得占位注释和实际装配各说各的。
 *
 * T2-6 的 `RateLimitGuard` 已经接上（见 {@link GLOBAL_GUARDS} 首项），这里暂时留空。
 */
export const PLANNED_GUARD_ORDER: readonly { name: string; before: string }[] = []
