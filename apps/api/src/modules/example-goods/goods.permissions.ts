/**
 * 蓝图 §7 扩展点③ **注册权限点**：模块内定义，`src/registry/permissions.ts` 汇总。
 *
 * 权限点定义在模块目录里而不是集中在注册表文件里，是为了「删掉一个模块 = 删一个目录」。
 * 集中定义的话，删模块时总会留下几个没人再引用的死权限，而死权限在角色配置页上
 * 看起来和活的一模一样。
 *
 * @packageDocumentation
 */

import { definePermissions } from '@taizan/contracts'

/** 商品模块的权限点。 */
export const GOODS_PERMISSIONS = definePermissions({
  'goods:list': { module: '商品', name: '查看商品', type: 'API' },
  'goods:write': { module: '商品', name: '新增/编辑商品', type: 'API' },
  'goods:delete': { module: '商品', name: '删除商品', type: 'API' },
  'goods:export': { module: '商品', name: '导出商品', type: 'BUTTON' },
})
