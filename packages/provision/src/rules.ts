/**
 * 开通租户的**纯函数**规则：slug、手机号、口令强度、初始状态。
 *
 * 单拎出来是因为它们有**两个以上的调用点**：注册页要边打字边查 slug 形状（那一步没有数据库），
 * 平台后台的表单要在提交前给同样的提示，而 {@link provisionTenant} 落库前还要再判一次。
 * 三处各写一遍的下场是**某一条路能建出另一条路建不出来的租户**——
 * 比如后台允许 2 位 slug、注册页不允许，于是同一张表里出现了两种规格的路径。
 *
 * 纯函数只回结果不抛错（除了 `assert*` 那几个）：查重接口要把「为什么不行」原样显示给商家。
 *
 * @packageDocumentation
 */

import { ProvisionError } from './types'
import type { ProvisionErrorReason } from './types'
import { SLUG_MAX_LENGTH, SLUG_MIN_LENGTH, SLUG_PATTERN, isReservedSlug } from './reserved-slugs'

/** 校验类纯函数的统一返回形状。`ok=false` 时 `reason` 与 `message` 都给。 */
export type CheckResult<T> =
  { ok: true; value: T } | { ok: false; reason: ProvisionErrorReason; message: string }

/** 没给 `trialDays`、也没给 `planId` 时的默认试用天数。 */
export const DEFAULT_TRIAL_DAYS = 14

/** 到期后的宽限天数：到期当晚不锁店，留三天挂催费横幅。 */
export const DEFAULT_GRACE_DAYS = 3

/** 注销后的数据保留天数。 */
export const DEFAULT_RETENTION_DAYS = 7

/** 口令最短长度。 */
export const PASSWORD_MIN_LENGTH = 8

/** 口令最长长度。挡的是「把一整段文本粘进来」把 scrypt 拖慢成 DoS。 */
export const PASSWORD_MAX_LENGTH = 64

/** 店名长度下限。 */
export const NAME_MIN_LENGTH = 2

/** 店名长度上限。 */
export const NAME_MAX_LENGTH = 30

/** 大陆手机号。`1[3-9]` 开头共 11 位。 */
export const PHONE_PATTERN = /^1[3-9]\d{9}$/

/**
 * 校验并归一化 slug。
 *
 * 归一化（`trim` + 转小写）在校验**之前**做，且返回归一化后的值——
 * 调用方必须用返回的这个值落库。否则 `Shop` 与 `shop` 会变成两行，
 * 而 `Tenant.slug` 上的唯一索引对大小写敏感与否取决于数据库排序规则，
 * 那是一个换个环境就变的行为。
 *
 * @param raw - 用户输入
 * @returns `ok` 时 `value` 是可以直接落库的 slug
 */
export function validateSlug(raw: unknown): CheckResult<string> {
  const slug = String(raw ?? '')
    .trim()
    .toLowerCase()

  if (slug.length === 0) {
    return { ok: false, reason: 'SLUG_INVALID', message: '请填写店铺路径' }
  }
  if (!SLUG_PATTERN.test(slug)) {
    return {
      ok: false,
      reason: 'SLUG_INVALID',
      message:
        `店铺路径只能用小写字母、数字和连字符，` +
        `${String(SLUG_MIN_LENGTH)}–${String(SLUG_MAX_LENGTH)} 位，且不能以连字符开头或结尾`,
    }
  }
  if (isReservedSlug(slug)) {
    return { ok: false, reason: 'SLUG_RESERVED', message: '这个路径是系统保留的，换一个' }
  }
  return { ok: true, value: slug }
}

/**
 * 归一化手机号：去掉空格、连字符、括号，脱掉 `+86` / `0086` 前缀。
 *
 * **不做校验**（形状判定用 {@link PHONE_PATTERN}）：这个函数也用在「查这个号有没有账号」
 * 那种只读路径上，那里对一个明显填错的号回「没有账号」比抛错更合适。
 *
 * 归一化必须在**查账号之前**做：`138 0000 0000` 与 `13800000000` 查不到同一行的话，
 * 一号多店会悄悄退化成「同一个人有两个账号」。
 */
export function normalizePhone(raw: unknown): string {
  const digits = String(raw ?? '').replace(/[^\d+]/g, '')
  return digits.replace(/^\+?(?:86|0086)/, '')
}

/** 校验店名。 */
export function validateTenantName(raw: unknown): CheckResult<string> {
  const name = String(raw ?? '').trim()
  if (name.length < NAME_MIN_LENGTH || name.length > NAME_MAX_LENGTH) {
    return {
      ok: false,
      reason: 'NAME_INVALID',
      message: `店铺名称 ${String(NAME_MIN_LENGTH)}–${String(NAME_MAX_LENGTH)} 个字`,
    }
  }
  return { ok: true, value: name }
}

/**
 * 口令强度。
 *
 * **只卡长度与「至少两类字符」**，不强制大小写数字符号混排：强制复杂度的结果多半是
 * `Aa123456!` 这种到处都在用的口令，并不更安全，却会在注册这一步劝退一批人——
 * 而注册是整个漏斗最窄的地方。同理不查字典：那需要一份词表，还会把
 * 「密码里有个常见词」变成一个商家改十次也过不了的谜题。
 *
 * 两类是最小的有效约束：它挡掉的是 `12345678` 和 `password` 这两种真正批量出现的口令。
 *
 * @throws {@link ProvisionError} `OWNER_PASSWORD_WEAK`
 */
export function assertOwnerPasswordPolicy(plain: unknown): void {
  const password = typeof plain === 'string' ? plain : ''

  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new ProvisionError(
      'OWNER_PASSWORD_WEAK',
      `密码 ${String(PASSWORD_MIN_LENGTH)}–${String(PASSWORD_MAX_LENGTH)} 位`,
    )
  }
  if (/^(.)\1+$/.test(password)) {
    throw new ProvisionError('OWNER_PASSWORD_WEAK', '密码不能是同一个字符重复')
  }

  const classes =
    (/[a-zA-Z]/.test(password) ? 1 : 0) +
    (/\d/.test(password) ? 1 : 0) +
    (/[^a-zA-Z\d]/.test(password) ? 1 : 0)
  if (classes < 2) {
    throw new ProvisionError(
      'OWNER_PASSWORD_WEAK',
      '密码至少要包含字母、数字、符号里的两类（不要求大小写混排）',
    )
  }
}

/** {@link decideInitialStatus} 的入参。 */
export interface InitialStatusInput {
  /** 套餐 id；`null`/`undefined` = 没挂套餐。 */
  planId?: string | null
  /** 试用天数；`undefined` = 没显式给。 */
  trialDays?: number | null
}

/**
 * 初始状态判定。
 *
 * | `trialDays` | `planId` | 结果 | 场景 |
 * |---|---|---|---|
 * | 显式给了（含 `0`） | 任意 | `TRIAL` | 自助注册；平台开通的试用店（挂着套餐试用也是试用） |
 * | 没给 | 给了 | `ACTIVE` | 平台按套餐直接开通（线下已收钱）、批量导入存量商家 |
 * | 没给 | 没给 | `TRIAL` | 兜底：{@link DEFAULT_TRIAL_DAYS} 天试用 |
 *
 * **`trialDays` 显式给了就一定是 `TRIAL`**，哪怕同时给了 `planId`：套餐决定「能用哪些功能」，
 * 状态决定「按试用还是按付费到期」，两件事。把它们绑在一起的话，
 * 「先挂套餐再试用」这个最常见的销售动作就没法表达了。
 *
 * 判定里**永远不会出现 `EXPIRED`**：`TenantStatus` 刻意没有这一位，到期现算（蓝图 §4.5）。
 */
export function decideInitialStatus(input: InitialStatusInput): 'TRIAL' | 'ACTIVE' {
  if (input.trialDays !== undefined && input.trialDays !== null) return 'TRIAL'
  return input.planId !== undefined && input.planId !== null && input.planId !== ''
    ? 'ACTIVE'
    : 'TRIAL'
}

/**
 * 落库要用的试用天数：显式给了就用它，否则 {@link DEFAULT_TRIAL_DAYS}。
 *
 * @throws {@link ProvisionError} `TRIAL_DAYS_INVALID` 不是非负整数时
 */
export function resolveTrialDays(trialDays: number | null | undefined): number {
  if (trialDays === undefined || trialDays === null) return DEFAULT_TRIAL_DAYS
  if (!Number.isInteger(trialDays) || trialDays < 0) {
    throw new ProvisionError(
      'TRIAL_DAYS_INVALID',
      `试用天数必须是非负整数，收到 ${String(trialDays)}`,
    )
  }
  return trialDays
}
