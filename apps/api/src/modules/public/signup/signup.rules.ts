/**
 * 自助注册这条路**特有**的纯函数规则（T1-8，蓝图 §9「建租户只有一条路」）。
 *
 * ## 这里只放「这条路特有」的东西
 *
 * slug 形状、保留字、手机号归一化、口令强度**一律从 `@taizan/provision` import**，
 * 一个字都不在这里重写。各写一遍的下场是「注册页能建出后台建不出来的店」——
 * 而 `Tenant.slug` 是不可改的，放出去就收不回来。
 *
 * 留在这里的只有三类：
 *
 * 1. `ProvisionError.reason` → **HTTP 语义与错误码**的映射（provision 是零框架依赖的，
 *    它不认识 7 位错误码，也不该认识）；
 * 2. 试用天数取值（`SIGNUP_TRIAL_DAYS` 这个运营参数怎么落成 `trialDays`）；
 * 3. 注册总开关怎么读。
 *
 * ## 不泄露「这个手机号有没有账号」——以及这条取舍的代价
 *
 * 一号多店时注册接口要验商家**现有**的口令。于是它天然是一个手机号枚举器：
 * 「口令不对」和「这个号还没注册过」如果回不同的东西，任何人都能拿一份手机号表
 * 扫出「哪些号是本平台商家」——那是一份可以直接拿去做定向诈骗的名单。
 *
 * 所以 {@link CREDENTIAL_FAILURE} 把三种失败合并成同一个 `1140100` + 同一句话：
 *
 * | reason | 真实含义 |
 * |---|---|
 * | `OWNER_PASSWORD_REQUIRED` | 这个号已有账号，但没填 `existingPassword` |
 * | `OWNER_PASSWORD_MISMATCH` | 这个号已有账号，`existingPassword` 填错了 |
 * | `OWNER_ACCOUNT_DISABLED` | 这个号的账号被平台停用了 |
 *
 * **代价写在这里，免得下一个人以为是漏了**：
 *
 * - 一个手机号真的已注册、而商家自己忘了口令的时候，他看到的提示是
 *   「手机号或密码不对」，而不是「你已经注册过了，请填原密码」。这会带来客服量。
 *   接受它，是因为另一边是「把商家名单送出去」——两者不是一个量级。
 *   缓解手段在前端：注册页上直接写一句「这个手机号如果已经开过店，请填它的登录密码」。
 * - 枚举**没有被彻底堵死**：不填 `existingPassword` 时，已注册的号回 1140100、
 *   没注册的号会**成功建出一家店**——成功与失败本身仍然可区分。堵死它需要把注册做成
 *   两步（先发短信验证码），那是另一个任务。当下的防线是限流：`signup` 档
 *   同 IP、同手机号一天各 3 次，**成功也计数**，扫一份名单的成本因此不成立。
 * - `OWNER_PASSWORD_WEAK` 之所以**不**在这张表里，是因为服务层在进事务**之前**
 *   已经用同一个 `assertOwnerPasswordPolicy` 校验过 `password` 了。不这么做的话，
 *   「弱口令」这条分支只会在**新账号**那一支出现，于是它本身就成了一个
 *   「这个号有没有账号」的探针（已注册 → 1140100，未注册 → 「密码 8–64 位」）。
 *
 * @packageDocumentation
 */

import { ErrorCode } from '@taizan/contracts'
import { DEFAULT_TRIAL_DAYS, type ProvisionErrorReason } from '@taizan/provision'

/** 一次失败要回给前端的东西。 */
export interface SignupFailure {
  /** 7 位业务错误码。 */
  code: number
  /** 直接显示给商家的话。 */
  message: string
}

/**
 * 「手机号或密码不对」——三种失败合并成的那一个回答。
 *
 * 用 `1140100`（未登录）而不是 `1040000`（参数错）：前端对 401 语义的动作是
 * 「让用户回到填口令那一步」，而这恰好就是商家该做的事。
 */
export const CREDENTIAL_FAILURE: SignupFailure = Object.freeze({
  code: ErrorCode.UNAUTHENTICATED.code,
  message: '手机号或密码不对',
})

/** 归到「凭据类失败」的 reason（合并成同一个回答，见文件头）。 */
// process-local: 写死在代码里的常量分类表，不是缓存也不是计数器——它不随请求变化，
// 多进程各存一份的内容逐字节相同。用 Set 只是为了 O(1) 的归类查询。
const CREDENTIAL_REASONS: ReadonlySet<ProvisionErrorReason> = new Set([
  'OWNER_PASSWORD_REQUIRED',
  'OWNER_PASSWORD_MISMATCH',
  'OWNER_ACCOUNT_DISABLED',
])

/**
 * 归到「系统内部错误」的 reason：不是商家填错了什么，是该叫人来看的。
 *
 * `ROLE_PRESET_*` = 角色模板坏了或没 seed；`PLAN_EXPIRE_REQUIRED` / `OPERATOR_REQUIRED`
 * 在自助注册这条路上根本走不到（不挂套餐、没有 operator），走到了就是接线 bug。
 */
// process-local: 同上，常量分类表。
const SERVER_FAULT_REASONS: ReadonlySet<ProvisionErrorReason> = new Set([
  'ROLE_PRESET_EMPTY',
  'ROLE_PRESET_MISSING_OWNER',
  'PLAN_EXPIRE_REQUIRED',
  'OPERATOR_REQUIRED',
])

/**
 * `ProvisionError.reason` → 错误码与文案。
 *
 * 按 `reason` 映射而不是比对 `message`：比对文案的代码改一个字就静默失效，
 * 而「静默失效」在这里意味着一个本该 401 的失败变成了 500，或者更糟——
 * 一句本该被合并掉的话被原样回了出去。
 *
 * @param reason - 稳定原因码
 * @param message - provision 给的原始文案；只有**参数类**失败才会用到它
 */
export function mapProvisionFailure(reason: ProvisionErrorReason, message: string): SignupFailure {
  if (CREDENTIAL_REASONS.has(reason)) return CREDENTIAL_FAILURE
  if (SERVER_FAULT_REASONS.has(reason)) {
    return { code: ErrorCode.INTERNAL_ERROR.code, message: ErrorCode.INTERNAL_ERROR.message }
  }
  // 余下的全是「商家填错了什么」：slug 形状/保留字/被占用、手机号形状、店名长度、
  // 口令太弱、试用天数非法。provision 的文案本来就是写给商家看的，原样回。
  return { code: ErrorCode.BAD_REQUEST.code, message }
}

/** 注册关闭时的回答。用 `1040000` 而不是 404：路由确实存在，只是这会儿不开放。 */
export const SIGNUP_DISABLED: SignupFailure = Object.freeze({
  code: ErrorCode.BAD_REQUEST.code,
  message: '暂未开放自助注册，请联系平台开通',
})

/**
 * 注册总开关。
 *
 * 单拎成一个函数是因为它有**两个**调用点：`POST /signup` 要据此拒绝，
 * `GET /site-config` 要据此告诉官网「注册按钮显不显示」。两处各判一遍，
 * 迟早出现「按钮还在、点了报错」。
 *
 * @param enabled - `SIGNUP_ENABLED` 的值（env schema 已经把它解析成 boolean 了）
 */
export function isSignupOpen(enabled: unknown): boolean {
  return enabled === true
}

/**
 * 落到 `provisionTenant({ trialDays })` 的试用天数。
 *
 * **一定显式给一个值**（哪怕它等于 provision 的默认值）：`decideInitialStatus`
 * 的规则是「显式给了 `trialDays` 就一定是 `TRIAL`」，不给且没有 `planId` 才回落到
 * 默认 14 天。自助注册开出来的店必须恒为 `TRIAL`，不能让它取决于「有没有传 planId」——
 * 哪天注册页加了「注册时选套餐」，不显式传的话那家店会静默变成 `ACTIVE`，
 * 而 `ACTIVE` 没有 `planExpireAt` 在闸门里算出来是「未开通」：一家刚注册的店直接打烊。
 *
 * 非法值（负数、小数、NaN）回落到 provision 的默认值而**不是抛错**：这是一个
 * 运维填错的 env，代价不该由正在注册的商家承担。env schema 那一层已经拦过一道，
 * 这里是第二道（`0` 是合法值——「注册即到期，先注册后付费」是一个真实的运营选择）。
 *
 * @param configured - `SIGNUP_TRIAL_DAYS` 的值
 */
export function resolveSignupTrialDays(configured: unknown): number {
  // 先按类型分流再 Number()，不是无脑 `Number(configured)`：`Number(null)` 与
  // `Number('')` 都是 **0**，而 0 在这里是一个**合法且有后果**的值
  // （「注册即到期」）。无脑转的话，一个没配 / 配成空串的 env 会静默变成
  // 「所有自助注册的店一开出来就到期」——而那看起来完全不像配置问题。
  const raw =
    typeof configured === 'number'
      ? configured
      : typeof configured === 'string' && configured.trim() !== ''
        ? Number(configured)
        : Number.NaN
  if (!Number.isInteger(raw) || raw < 0) return DEFAULT_TRIAL_DAYS
  return raw
}
