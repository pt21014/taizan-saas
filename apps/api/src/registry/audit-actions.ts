/**
 * 五张注册表之四：**审计动作**（蓝图 §4.8、§7 扩展点⑥）。
 *
 * 框架自带的动作在 `@taizan/nest-audit` 的 `AUDIT_ACTIONS`（建租户、冻结、员工变更、
 * 订单标记已付…）；业务自己的动作在这里。**两份分开维护、分开展示**——框架升级新增
 * 内置动作时不该动到业务文件，反之亦然。
 *
 * 动作码格式定死 `module.action`（小写 + 连字符，两段之间恰好一个点），
 * `defineAuditActions()` 在加载期校验。统一格式是为了审计查询页能
 * `action.split('.')[0]` 直接按模块筛选。
 *
 * @packageDocumentation
 */

import { AUDIT_ACTIONS, defineAuditActions } from '@taizan/nest-audit'

/** 本应用的业务审计动作。 */
export const APP_AUDIT_ACTIONS = defineAuditActions({
  /** 新建商品。 */
  GOODS_CREATE: 'goods.create',
  /** 修改商品。 */
  GOODS_UPDATE: 'goods.update',
  /** 删除（软删）商品。 */
  GOODS_DELETE: 'goods.delete',

  // ── T1-7 平台管理面 ─────────────────────────────────────────────────

  /** 新建平台管理员。 */
  PLATFORM_ADMIN_CREATE: 'platform-admin.create',
  /** 修改平台管理员（名字 / 角色）。 */
  PLATFORM_ADMIN_UPDATE: 'platform-admin.update',
  /** 启用平台管理员。 */
  PLATFORM_ADMIN_ENABLE: 'platform-admin.enable',
  /** 停用平台管理员。 */
  PLATFORM_ADMIN_DISABLE: 'platform-admin.disable',
  /** 平台运营重置某个管理员的口令（区别于框架自带的「本人改密」动作）。 */
  PLATFORM_ADMIN_RESET_PASSWORD: 'platform-admin.reset-password',
  /** 平台管理员给自己开一份新的 MFA TOTP 密钥（T3-4，开关位，登录时未强制校验，见 platform-mfa.service.ts）。 */
  PLATFORM_ADMIN_MFA_ENABLE: 'platform-admin.mfa-enable',
  /** 平台管理员校验一枚 MFA 一次性码。 */
  PLATFORM_ADMIN_MFA_VERIFY: 'platform-admin.mfa-verify',

  /** 死信重放（T3-4）：把一条重试耗尽的任务原样重新入队。 */
  JOB_DEAD_LETTER_REPLAY: 'job.dead-letter-replay',

  /** 续期（延长 planExpireAt）。T1-5 之后它已经改走 `PlanOrderService.fulfill()` 单一路径，动作码不变。 */
  TENANT_RENEW: 'tenant.renew',
  /** 更换套餐（不改到期日）。 */
  TENANT_CHANGE_PLAN: 'tenant.change-plan',
  /** 平台运营重置店主登录口令。 */
  TENANT_RESET_OWNER_PASSWORD: 'tenant.reset-owner-password',

  /**
   * 【高危】平台运营开通新店时，**跳过「一号多店必须验原口令」**直接绑定一个已有账号（T1-8）。
   *
   * 与 `tenant.create` 分开记，而不是塞进它的 `after` 里：这一条是本框架唯一一处
   * 「有人可以不验口令就把一家店挂到别人账号下」，它必须能被单独 `where action = ...`
   * 捞出来做定期巡检。合进 `tenant.create` 的话，它会淹没在每天几十条正常开店里。
   *
   * `@taizan/provision` 本身不给 source 开这个口子（开了「一条路」就名存实亡），
   * 它是 apps/api 侧的适配层，安全性全部建立在「事后查得出是谁按的」上面。
   */
  TENANT_CREATE_ATTACH_EXISTING: 'tenant.create-attach-existing',

  /** 新建套餐。 */
  PLAN_CREATE: 'plan.create',
  /** 修改套餐（价格 / 配额 / 功能）。 */
  PLAN_UPDATE: 'plan.update',
  /** 套餐上架（ENABLED）。 */
  PLAN_PUBLISH: 'plan.publish',
  /** 套餐下架（DISABLED，存量租户不受影响）。 */
  PLAN_UNPUBLISH: 'plan.unpublish',
  /** 套餐归档（ARCHIVED，永不再售）。 */
  PLAN_ARCHIVE: 'plan.archive',
  /** 调整套餐展示排序。 */
  PLAN_SORT: 'plan.sort',

  // ── T1-5 平台收费闭环 ───────────────────────────────────────────────

  /**
   * 套餐订单兑现（钱变成权益：延长 planExpireAt）。
   *
   * 框架侧已经有 `plan-order.mark-paid`（线下核销这个**动作**）与 `plan-order.refund`，
   * 但没有「兑现」本身——而在线支付那条路上根本没有「运营点了标记已付」这个动作，
   * 却同样发生了兑现。两者分开记，审计页才回答得了「这家店的到期日是被谁、
   * 通过哪条路径改成今天这个值的」。
   */
  PLAN_ORDER_FULFILL: 'plan-order.fulfill',
  /** 商家自助下单 / 平台运营代下单（只落 PENDING，不动权益）。 */
  PLAN_ORDER_CREATE: 'plan-order.create',
  /**
   * 支付回调对套餐订单的处理结果。
   *
   * 只有**不予兑现**的那两条分支会用到它（订单不存在、金额不符）——两者都是
   * 「钱到账了但系统拒绝发货」，也都是重推不会自愈的永久性错误。成功那条走
   * `PLAN_ORDER_FULFILL`，两者分开才看得出「这笔钱最后到底怎么了」。
   */
  PLAN_ORDER_CALLBACK: 'plan-order.callback',

  /** 新建角色预设。 */
  ROLE_PRESET_CREATE: 'role-preset.create',
  /** 修改角色预设。 */
  ROLE_PRESET_UPDATE: 'role-preset.update',
  /** 删除角色预设（builtin 禁止）。 */
  ROLE_PRESET_DELETE: 'role-preset.delete',

  // ── T1-9 商家侧管理面 ───────────────────────────────────────────────
  //
  // 框架内置的 `AUDIT_ACTIONS` 里已经有 `staff.invite` / `staff.remove` /
  // `staff.role-change` / `staff.owner-transfer` 四条，控制器上直接用那四条。
  // 下面补的是框架没有、而这个应用真的会做的动作。

  /** 停用员工（区别于框架内置的 `staff.remove`「移出店铺」——停用保留成员关系）。 */
  STAFF_DISABLE: 'staff.disable',
  /** 启用员工。 */
  STAFF_ENABLE: 'staff.enable',

  /** 商家新建自定义角色。与平台侧的 `role-preset.*`（角色**模板**）是两回事。 */
  ROLE_CREATE: 'role.create',
  /** 商家修改角色（改名 / 改权限点）。 */
  ROLE_UPDATE: 'role.update',
  /** 商家删除角色（软删；内置角色与仍被引用的角色删不掉）。 */
  ROLE_DELETE: 'role.delete',

  /**
   * 员工标记一条平台公告已读。
   *
   * 记它是因为公告里可能有「X 月 X 日起调价」这类**需要被告知**的内容，
   * 而「他到底看没看到」在事后会被追问。`AnnouncementRead` 那张表本身就存了
   * 首次已读时间，这条审计记的是「这个动作是从哪个 IP、哪条 traceId 上发生的」——
   * 两者不重复：回执是状态，审计是行为。
   */
  ANNOUNCEMENT_READ: 'announcement.read',

  /** 员工改自己的资料（显示名 / 头像）。 */
  PROFILE_UPDATE: 'profile.update',
  /**
   * 员工改自己的密码。
   *
   * 与框架内置的 `platform-admin.change-password`（平台管理员改密）分开，
   * 也与 `tenant.reset-owner-password`（平台运营**替**店主重置）分开：
   * 「本人改的」和「别人替他改的」在事后是完全不同的两件事。
   */
  PROFILE_CHANGE_PASSWORD: 'profile.change-password',

  /** 新建公告（草稿）。 */
  ANNOUNCEMENT_CREATE: 'announcement.create',
  /** 修改公告。 */
  ANNOUNCEMENT_UPDATE: 'announcement.update',
  /** 公告下线（转 ARCHIVED，保留内容与已读回执）。 */
  ANNOUNCEMENT_UNPUBLISH: 'announcement.unpublish',
  /** 删除公告（仅限从未发布过的 DRAFT）。 */
  ANNOUNCEMENT_DELETE: 'announcement.delete',
})

/**
 * 框架 + 业务的合集，给审计查询页做「动作码 → 中文名」下拉用。
 *
 * 两边 key 撞名会被下面的断言抓住：撞名的后果是审计页把两种完全不同的操作显示成同一件事。
 */
export const ALL_AUDIT_ACTIONS = Object.freeze({ ...AUDIT_ACTIONS, ...APP_AUDIT_ACTIONS })

function assertNoActionCollision(): void {
  const framework = new Set<string>(Object.values(AUDIT_ACTIONS))
  const collisions = Object.entries(APP_AUDIT_ACTIONS)
    .filter(([, value]) => framework.has(value))
    .map(([key, value]) => `${key}=${value}`)
  if (collisions.length > 0) {
    throw new Error(
      `[@taizan/api] 业务审计动作与框架内置动作撞码：${collisions.join(', ')}。` +
        '换一个模块段前缀（业务动作建议带自己的模块名）。',
    )
  }
}

assertNoActionCollision()
