/**
 * 蓝图 §7 扩展点③：角色模块的权限点（T1-9）。
 *
 * 读 / 写 / 删分三档，理由同 `example-goods/goods.permissions.ts`：
 * 「能看角色配置」和「能给自己加一个全量角色」不是一件事，而后者等价于提权。
 *
 * @packageDocumentation
 */

import { definePermissions } from '@taizan/contracts'

/** 角色模块的权限点。 */
export const ROLE_PERMISSIONS = definePermissions({
  'role:list': { module: '角色', name: '查看角色与权限点目录', type: 'API' },
  'role:write': { module: '角色', name: '新建 / 编辑角色', type: 'API' },
  'role:delete': { module: '角色', name: '删除角色', type: 'API' },
})
