/**
 * 蓝图 §7 扩展点③：商家侧审计查询的权限点（T1-9）。
 *
 * 只有一个 `audit:list`，因为审计**只读**：本表在应用层没有任何写入口
 * （只有 `AuditInterceptor` 会写），也永远不该有删除入口——能删审计的审计不是审计。
 *
 * @packageDocumentation
 */

import { definePermissions } from '@taizan/contracts'

/** 审计模块的权限点。 */
export const AUDIT_PERMISSIONS = definePermissions({
  'audit:list': { module: '审计', name: '查看操作日志', type: 'API' },
})
