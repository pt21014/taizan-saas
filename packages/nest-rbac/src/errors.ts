/**
 * 本包用到的错误码。
 *
 * **定义不在这里**：真源是 `@taizan/contracts` 的 `ErrorCode` 内置表（蓝图 §4.9）。
 * 本文件只留一张别名表，让包内代码继续写 `RBAC_ERRORS.FORBIDDEN` 而不必到处改 import。
 *
 * 历史背景：contracts 曾经在 **AUTH 域段（11）** 也登记过一条 `ErrorCode.FORBIDDEN = 1140301`，
 * 于是「无权限」有两个码，而实际抛出的只有 13 段这个。11 段那条已删除，
 * 现在全仓只有 `1340300` 一个「无权限」。域段选 13 不选 11 的理由没变：
 * `11` 段让前端以为是登录态问题（可能触发静默刷新 token 后重试），
 * `13` 段才是「你登录得好好的，只是这个按钮不该你点」。
 *
 * @packageDocumentation
 */

import { ErrorCode } from '@taizan/contracts'

/**
 * RBAC 域段（`13`）错误码 —— `@taizan/contracts` 内置表的别名。
 */
export const RBAC_ERRORS = {
  /** 权限点判定不通过（`1340300`）。 */
  FORBIDDEN: ErrorCode.RBAC_FORBIDDEN,
  /**
   * 数据范围配置错误（`1340301`）。
   *
   * `@DataScope({ ownerField })` 写错字段名、`SUB_TREE` 忘了给 `groupField` 之类，
   * 都会让 `buildScopeWhere` 抛错。失败关闭：宁可 403 也不能退化成「不加条件」。
   */
  DATA_SCOPE_MISCONFIGURED: ErrorCode.RBAC_DATA_SCOPE_MISCONFIGURED,
} as const
