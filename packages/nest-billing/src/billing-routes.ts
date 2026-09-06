/**
 * 蓝图 §8 第 8 条（`billing-routes.spec.ts`）的判定函数那一半。
 *
 * 断言的是同一个死循环的两侧：
 *
 * | 方向 | 函数 | 出事的样子 |
 * |---|---|---|
 * | 白名单 → 控制器 | {@link verifyRenewalPrefixes} | `ALWAYS_WRITABLE_PREFIXES` 里写了 `/api/admin/billing`，而实际控制器叫 `/api/admin/plan-order`。白名单形同虚设，到期后续不了费 |
 * | 功能开关 → 白名单 | `assertFeatureNotShadowingRenewal`（在 `@taizan/billing-rules`） | 某个功能项的 `pathPrefixes` 盖住了续费路径。没买那个功能的商家永远续不了费 |
 *
 * 扫源码取控制器前缀的那一半留给 `apps/api`——它才知道自己的源码目录长什么样。
 * 本包只提供判定与 fixtures 样板（见 `billing-routes.spec.ts`），
 * 免得每个下游项目把「怎么算匹配」重写一遍并且各写错各的。
 *
 * @packageDocumentation
 */

import { ALWAYS_WRITABLE_PREFIXES, normalizePathPrefix, pathHasPrefix } from '@taizan/billing-rules'

/** 一条没被任何控制器兑现的白名单前缀。 */
export interface RenewalPrefixViolation {
  /** 归一化之后的白名单前缀。 */
  prefix: string
  /** 人话理由（直接可以往断言消息里贴）。 */
  reason: string
}

/** {@link verifyRenewalPrefixes} 的结果。 */
export interface RenewalPrefixReport {
  ok: boolean
  violations: RenewalPrefixViolation[]
  /** 每条白名单前缀命中了哪些控制器前缀（调试用，也便于人工核对）。 */
  matched: Record<string, string[]>
}

/**
 * `ALWAYS_WRITABLE_PREFIXES` 的每一条都必须有至少一个真实控制器前缀落在它下面。
 *
 * 「落在它下面」而不是「等于」：白名单是**前缀**，`/api/admin/billing` 这条可以由
 * `/api/admin/billing/order` + `/api/admin/billing/plan` 两个控制器共同兑现，
 * 没有哪个控制器叫得恰好一样也没关系。反过来 `/api/admin/bill` 不算兑现
 * `/api/admin/billing`——前者更短，白名单那条仍然指向空气。
 *
 * @param controllerPrefixes - 应用里所有 `@Controller('…')` 的前缀（带不带前导斜杠都行）
 */
export function verifyRenewalPrefixes(controllerPrefixes: readonly string[]): RenewalPrefixReport {
  const normalized = controllerPrefixes
    .filter((p) => typeof p === 'string' && p.trim() !== '' && p.trim() !== '/')
    .map((p) => normalizePathPrefix(p))

  const matched: Record<string, string[]> = {}
  const violations: RenewalPrefixViolation[] = []

  for (const raw of ALWAYS_WRITABLE_PREFIXES) {
    const prefix = normalizePathPrefix(raw)
    const hits = normalized.filter((c) => pathHasPrefix(c, prefix))
    matched[prefix] = hits
    if (hits.length === 0) {
      violations.push({
        prefix,
        reason:
          `续费白名单 ${prefix} 没有对应的控制器——白名单放行的是一个不存在的路径。` +
          `商家到期后后台转只读，而「去续费」的接口不在白名单下，会被同一道闸门拦住，` +
          `于是「到期 → 只读 → 续不了费 → 永远到期」。` +
          `修法二选一：把续费控制器的前缀改成 ${prefix} 开头，或改 @taizan/billing-rules 里的 ALWAYS_WRITABLE_PREFIXES。`,
      })
    }
  }

  return { ok: violations.length === 0, violations, matched }
}

/** 直接抛的版本，给 spec 里 `expect(() => …).not.toThrow()` 用。 */
export function assertRenewalPrefixes(controllerPrefixes: readonly string[]): void {
  const report = verifyRenewalPrefixes(controllerPrefixes)
  if (report.ok) return
  throw new Error(
    `[@taizan/nest-billing] 续费白名单与控制器对不上：\n${report.violations
      .map((v) => `  - ${v.reason}`)
      .join('\n')}`,
  )
}
