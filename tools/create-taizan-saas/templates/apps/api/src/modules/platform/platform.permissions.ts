/**
 * 蓝图 §7 扩展点③ **注册权限点**：`/api/platform` 侧的权限点定义（T1-7）。
 *
 * 与 `platform.menus.ts` 同因：本文件本身不接线——汇总在 `src/registry/permissions.ts`
 * （T1-8 起那里是 `...PLATFORM_PERMISSIONS` 一行 import，不再有第二份内联定义；
 * 两份定义并存过一阵，module 名一个叫「租户管理」一个叫「平台租户」，
 * 后台角色配置页显示哪一个取决于对象展开的先后——这正是「两个真源」的典型症状）。
 * `platform.menus.ts` 里的 `permission` 字段就是照着这里的 code 写的，
 * `RbacModule.forRoot()` 的 `MenuRegistry` 会拒绝引用了未注册权限点的菜单，
 * `test/arch/permission-registry.spec.ts`（spec 6）再做一次双向对账。
 *
 * `@RequirePermission` 目前**没有**挂在任何 T1-7 控制器方法上：权限点先注册好形状，
 * 真正拦截哪个接口是执行层的事，等平台侧的角色/权限体系定下来（哪些操作该分给
 * "平台运营" vs "平台超管"）再按需加装饰器，不是这里空手猜。
 *
 * @packageDocumentation
 */

import { definePermissions } from '@taizan/contracts'

/** 平台管理面的权限点。 */
export const PLATFORM_PERMISSIONS = definePermissions({
  'platform-admin:list': { module: '平台管理员', name: '查看管理员', type: 'API' },
  'platform-tenant:list': { module: '平台租户', name: '查看租户', type: 'API' },
  'platform-plan:list': { module: '平台套餐', name: '查看套餐', type: 'API' },
  'platform-order:list': { module: '平台订单', name: '查看订单', type: 'API' },
  'platform-role-preset:list': { module: '平台角色预设', name: '查看角色预设', type: 'API' },
  'platform-announcement:list': { module: '平台公告', name: '查看公告', type: 'API' },
  'platform-audit:list': { module: '平台审计', name: '查看审计日志', type: 'API' },
  'platform-dashboard:view': { module: '平台看板', name: '查看数据看板', type: 'API' },
})
