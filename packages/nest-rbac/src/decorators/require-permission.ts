/**
 * `@RequirePermission(expr)`：声明一条路由需要的权限点。
 *
 * @packageDocumentation
 */

import { SetMetadata, type CustomDecorator } from '@nestjs/common'
import { parsePermissionExpr, type PermissionExpr } from '@taizan/rbac-core'

/**
 * metadata key。
 *
 * 前缀 `taizan:rbac:` 与 `@taizan/nest-auth` 的 `taizan:auth:` 同一个约定：
 * 裸字符串 key 会和第三方装饰器撞车，而撞车的表现是「某个路由的权限声明莫名其妙没了」。
 */
export const REQUIRE_PERMISSION_KEY = 'taizan:rbac:permission'

/**
 * 声明访问这条路由（或整个控制器）需要的权限点。
 *
 * - `'goods:write'`：单点；
 * - `'goods:write|goods:list'`：**任一**满足即可（或）；
 * - `['goods:write', 'shop:read']`：**全部**满足（与），数组元素本身也可以是 `'a|b'`。
 *
 * ## 表达式在装饰器执行时就校验
 *
 * 校验交给 `@taizan/rbac-core` 的 `parsePermissionExpr`，在**模块加载期**跑
 * （装饰器是求值即执行的），所以写错格式、写了通配（`'goods:*'`）会让进程起不来，
 * 而不是等到有人访问那条路由时才发现。
 *
 * **通配为什么在这里是错的**：`@RequirePermission('goods:*')` 的语义是「有商品模块
 * 任意一个权限就能进」，它会随着新增权限点**静默放宽**——今天加一个 `goods:export`，
 * 明天所有能导出商品的人就能删商品了。通配只允许出现在角色的 `permissionCodes` 里，
 * 那里的展开时机在鉴权之前，结果可枚举可审计。
 *
 * ## 它不检查「这个 code 注册过没有」
 *
 * 装饰器执行时注册表还没装配（`RbacModule.forRoot()` 在后面），拿不到全集。
 * 这一半由静态扫描补：`arch/require-permission.scan.ts` 的
 * `scanRequirePermissionUsages()` 双向比对源码与注册表（蓝图 §8 spec 6）。
 * 运行时的兜底是「未注册的 code 永远不会在 granted 里 → 一律拒绝」，
 * 方向是安全的那一侧，同时 `PermissionsGuard` 会就每个未注册 code 打一条 error 日志。
 *
 * @param expr - 权限表达式
 * @throws 表达式为空、格式非法、或含通配符时抛出
 */
export function RequirePermission(expr: PermissionExpr): CustomDecorator<string> {
  // 就地校验：抛出的错误会带着装饰器所在的模块一起出现在启动栈里。
  parsePermissionExpr(expr)
  return SetMetadata(REQUIRE_PERMISSION_KEY, expr)
}
