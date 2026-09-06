/**
 * `@taizan/provision` 规则的官网适配层。
 *
 * 曾经这里不敢直接 `import from '@taizan/provision'`：那个包的单一入口把浏览器安全的
 * 纯规则与只给测试用的 node-only 源码扫描器（顶层 `import ... from 'node:fs'`）打包进
 * 了同一个 `dist/index.js`，`vite dev` 原生 ESM 加载会无条件求值整个模块，浏览器里
 * 直接崩页。`@taizan/provision` 现在拆成了两个入口
 * （`.`：浏览器可用的纯规则；`./arch`：node-only 的扫描器，`dist/index.js` 里
 * 已经不含任何 `node:fs`/`node:path`，见该包 README「两个入口」），这里可以放心
 * 直接从主入口 import 真实实现，不再手抄一份。
 *
 * 这个文件只剩一件事**不是**单纯的 re-export：`assertOwnerPasswordPolicy` 是
 * `throw`-based（落库前的最后一道判断，符合 provisionTenant 内部的用法），
 * 但注册页要的是「不抛错、能直接渲染的强度提示」，所以包一层 {@link checkPasswordPolicy}。
 */
export {
  NAME_MAX_LENGTH,
  NAME_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PHONE_PATTERN,
  RESERVED_SLUGS,
  SLUG_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  SLUG_PATTERN,
  isReservedSlug,
  validateSlug,
  validateTenantName,
  type CheckResult,
} from '@taizan/provision'

import { assertOwnerPasswordPolicy, isProvisionError } from '@taizan/provision'

/** 口令强度判定结果（不用 provision 的 `throw`，前端要的是能直接渲染的提示）。 */
export interface PasswordCheck {
  ok: boolean
  message: string
}

/**
 * 口令强度提示：把 {@link assertOwnerPasswordPolicy}（`provisionTenant()` 落库前调用的
 * 那一个）的 `throw` 语义转成不抛错的判定，供输入过程中实时渲染提示用。
 * 文案直接取 `ProvisionError.message`——前端不另写一套长度/字符类正则，
 * 各写一遍的下场是「前端说能用，提交被后端拒」。
 */
export function checkPasswordPolicy(plain: unknown): PasswordCheck {
  try {
    assertOwnerPasswordPolicy(plain)
    return { ok: true, message: '密码强度可以' }
  } catch (error) {
    if (isProvisionError(error)) {
      return { ok: false, message: error.message }
    }
    return { ok: false, message: '密码不符合要求' }
  }
}
