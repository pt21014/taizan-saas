/**
 * 五张注册表的统一出口（蓝图 §1 `src/registry/`）。
 *
 * 「五张」是刻意数得清的：权限点、菜单、套餐功能项、审计动作、队列任务。
 * 新加一个业务模块要动的就是这五处 + `tenancy/tenant-models.ts` + schema 片段，
 * 共七处（蓝图 §7 的七件事）。多出第六张表的时候，先想清楚它是不是这五张里某一张。
 *
 * @packageDocumentation
 */

export { ALL_PERMISSION_CODES, PERMISSIONS } from './permissions'
export { ADMIN_MENUS, ALL_MENUS, PLATFORM_MENUS } from './menus'
export { ALWAYS_WRITABLE_PREFIXES, FEATURES } from './features'
export { ALL_AUDIT_ACTIONS, APP_AUDIT_ACTIONS } from './audit-actions'
export { JOBS, type JobDef } from './jobs'
