/**
 * 审计动作常量（蓝图 §4.8）。
 *
 * 动作码格式定死 `module.action`：模块段与动作段各自小写字母/数字，可用连字符分隔
 * 单词，两段之间恰好一个点。统一格式是为了审计查询页能直接 `action.split('.')[0]`
 * 按模块一级筛选——混进大写、下划线或多个点，筛选就得写一堆特判。
 *
 * @packageDocumentation
 */

const ACTION_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*\.[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * 定义一批审计动作常量，并在定义时就校验每个值的格式。
 *
 * @param actions - 键是常量名（随意），值是 `module.action` 格式的动作码
 * @returns 冻结后的对象，运行时改不了值
 * @throws 任意值不满足格式时抛——启动期直接炸，好过审计查询页某天发现一条动作码
 *   长得和别的不一样才回头查是谁手滑打错了
 *
 * @example
 * ```ts
 * // apps/api/src/registry/audit-actions.ts —— 业务项目补充自己的动作
 * export const APP_AUDIT_ACTIONS = defineAuditActions({
 *   GOODS_REORDER: 'goods.reorder',
 * })
 * ```
 */
export function defineAuditActions<T extends Record<string, string>>(actions: T): Readonly<T> {
  for (const [key, value] of Object.entries(actions)) {
    if (!ACTION_PATTERN.test(value)) {
      throw new Error(
        `[@taizan/nest-audit] 审计动作 "${key}" 的值 "${value}" 不是合法的 module.action 格式` +
          '（模块段与动作段各自为小写字母/数字，可用连字符分隔单词，两段间恰好一个点）',
      )
    }
  }
  return Object.freeze({ ...actions })
}

/**
 * 框架内置的审计动作常量，覆盖蓝图 §4.8 点名的平台高危操作。
 *
 * 业务项目在自己的 `apps/api/src/registry/audit-actions.ts` 里用
 * {@link defineAuditActions} 定义自己的动作，两份分开维护、分开展示——框架升级新增
 * 内置动作时不该动到业务文件，反之亦然。
 */
export const AUDIT_ACTIONS = defineAuditActions({
  /** 平台后台人工开通租户。 */
  TENANT_CREATE: 'tenant.create',
  /** 冻结（暂停）租户。 */
  TENANT_SUSPEND: 'tenant.suspend',
  /** 解冻（恢复）租户。 */
  TENANT_RESUME: 'tenant.resume',
  /** 注销租户（只置状态位 + 保留期，不做物理删除）。 */
  TENANT_DEREGISTER: 'tenant.deregister',

  /** 邀请员工加入租户。 */
  STAFF_INVITE: 'staff.invite',
  /** 移除员工。 */
  STAFF_REMOVE: 'staff.remove',
  /** 变更员工角色。 */
  STAFF_ROLE_CHANGE: 'staff.role-change',
  /** 店主转让。 */
  STAFF_OWNER_TRANSFER: 'staff.owner-transfer',

  /** 线下标记套餐订单已支付。 */
  PLAN_ORDER_MARK_PAID: 'plan-order.mark-paid',
  /** 套餐订单退款。 */
  PLAN_ORDER_REFUND: 'plan-order.refund',

  /** 平台管理员登录。 */
  PLATFORM_ADMIN_LOGIN: 'platform-admin.login',
  /** 平台管理员改密。 */
  PLATFORM_ADMIN_CHANGE_PASSWORD: 'platform-admin.change-password',

  /** 更新三方密钥凭据（`TenantCredential` / `PlatformSetting` 的加密列）。 */
  CREDENTIAL_UPDATE: 'credential.update',
  /** 发布平台公告。 */
  ANNOUNCEMENT_PUBLISH: 'announcement.publish',
})
