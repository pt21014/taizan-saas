/**
 * 蓝图 §7 扩展点③：个人设置的权限点（T1-9）。
 *
 * ## 「改自己的资料」为什么也要权限点
 *
 * 因为菜单要有一个裁剪依据，而**菜单与接口必须用同一个依据**。
 * 不给这两条路由挂 `@RequirePermission`、菜单也不写 `permission`，那是另一种自洽的
 * 选择（人人可见、人人可改）；但一旦菜单挂了权限点而接口没挂（或反过来），
 * 就会出现本仓库反复警惕的那种症状：菜单里看得到、点进去 403，或者菜单里没有、
 * 但接口照样能调。
 *
 * 这里选「都挂」。代价写在 README 的「已知取舍」里：框架内置角色模板
 * （`@taizan/prisma-base` 的 `BASE_ROLE_PRESETS`）里 `manager` / `staff` 两档的
 * `permissionCodes` 目前是空数组，所以一个只被授予了 `staff` 角色的员工
 * **看不到也改不了自己的资料**，需要业务项目在自己的角色模板里补上 `profile:*`。
 *
 * @packageDocumentation
 */

import { definePermissions } from '@taizan/contracts'

/** 个人设置的权限点。 */
export const PROFILE_PERMISSIONS = definePermissions({
  'profile:read': { module: '个人设置', name: '查看个人资料', type: 'API' },
  'profile:write': { module: '个人设置', name: '修改个人资料 / 修改密码', type: 'API' },
})
