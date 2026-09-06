/**
 * 续费白名单：**到期之后仍然永远可写的那三个前缀**。四条不可退让的第 2 条。
 *
 * 这是整个计费闭环里最容易出事的一处：把续费接口也锁掉，商家就掉进
 * 「到期 → 后台只读 → 续不了费 → 永远到期」的死循环，只能打电话找平台人工解，
 * 而平台恰恰是想收钱的那一方。**收款的门必须永远开着。**
 */

import { normalizePathPrefix, pathHasPrefix, type FeatureDef } from './feature'

/**
 * 任何闸门下都必须放行写操作的路径前缀。
 *
 * 三条各有各的理由，缺一条都会把商家关在门外：
 *
 * - **`/api/admin/auth`** —— 一个手机号可以开多家店，而**切店是个 POST**。不放行的话，
 *   A 店一到期他就被锁在这家已经打烊的店里，旁边那家好好的店切不过去——而那家店多半正是
 *   他想去续费的入口。登录、改密码同理，那些事与欠不欠费无关。
 * - **`/api/admin/billing`** —— 下单、支付、查账单本身。锁掉它就是上面那个死循环。
 * - **`/api/admin/bootstrap`** —— 后台首屏拉权限与菜单。它是 POST/GET 混用的初始化接口，
 *   拦掉的话商家连「后台只读中，请续费」这句话都看不到，只会看到一个白屏。
 *
 * `billing-routes.spec.ts`（架构约束 spec 8）拿真实的 `@Controller` 前缀逐条比对这份清单，
 * 并断言没有任何功能开关的 `pathPrefixes` 盖住它们（见 {@link assertFeatureNotShadowingRenewal}）。
 */
export const ALWAYS_WRITABLE_PREFIXES = [
  '/api/admin/auth',
  '/api/admin/billing',
  '/api/admin/bootstrap',
] as const

/** {@link ALWAYS_WRITABLE_PREFIXES} 里任一前缀的类型。 */
export type AlwaysWritablePrefix = (typeof ALWAYS_WRITABLE_PREFIXES)[number]

/**
 * 这个路径是不是续费白名单里的路径（**精确前缀 + 段边界**）。
 *
 * 边界判断不能省：`/api/admin/authx` **不算**白名单。少了这一步，将来某个叫 `authx`、
 * `billing-report` 之类的新模块会被静默地永久放行——一个到期后仍能写数据的接口，
 * 没有任何测试会发现它，直到有人拿它绕过整个计费闸门。
 *
 * @param path - 请求路径（带不带 query 都行）
 *
 * @example
 * ```ts
 * isRenewalPath('/api/admin/billing')            // true
 * isRenewalPath('/api/admin/billing/orders')     // true
 * isRenewalPath('/api/admin/billing/?page=1')    // true
 * isRenewalPath('/api/admin/authx')              // false —— 边界不算命中
 * isRenewalPath('/api/admin/goods')              // false
 * ```
 */
export function isRenewalPath(path: string): boolean {
  return ALWAYS_WRITABLE_PREFIXES.some((prefix) => pathHasPrefix(path, prefix))
}

/** {@link assertFeatureNotShadowingRenewal} 检出的一处遮蔽。 */
export interface RenewalShadowConflict {
  /** 出问题的功能开关 key。 */
  featureKey: string
  /** 该功能里那条越界的前缀。 */
  featurePrefix: string
  /** 被它盖住（或被它钻进去）的续费白名单前缀。 */
  renewalPrefix: string
  /**
   * - `COVERS`：功能前缀是白名单的上级（如 `/api/admin` 盖住 `/api/admin/auth`）；
   * - `NESTED`：功能前缀落在白名单里面（如 `/api/admin/billing/export`）。
   */
  kind: 'COVERS' | 'NESTED'
}

/**
 * 找出所有「功能开关遮蔽续费白名单」的地方，只报不抛。
 *
 * 两个方向都算遮蔽，因为两个方向都能把续费入口关上：
 * - **`COVERS`**：功能前缀写得太宽（`/api/admin`），套餐里没勾这个功能的商家连登录切店都做不了；
 * - **`NESTED`**：功能前缀钻进了白名单内部（`/api/admin/billing/invoice`），
 *   看着只挡了一个子路由，但那个子路由恰恰在收款流程上。
 *
 * @param defs - 功能开关注册表
 * @returns 冲突清单，空数组表示没问题
 */
export function findRenewalShadowConflicts(defs: readonly FeatureDef[]): RenewalShadowConflict[] {
  const conflicts: RenewalShadowConflict[] = []
  for (const def of defs) {
    for (const rawPrefix of def.pathPrefixes) {
      const featurePrefix = normalizePathPrefix(rawPrefix)
      for (const renewalPrefix of ALWAYS_WRITABLE_PREFIXES) {
        if (pathHasPrefix(renewalPrefix, featurePrefix)) {
          conflicts.push({ featureKey: def.key, featurePrefix, renewalPrefix, kind: 'COVERS' })
        } else if (pathHasPrefix(featurePrefix, renewalPrefix)) {
          conflicts.push({ featureKey: def.key, featurePrefix, renewalPrefix, kind: 'NESTED' })
        }
      }
    }
  }
  return conflicts
}

/**
 * 断言没有任何功能开关遮蔽续费白名单，有就抛。给架构约束 spec 8 与应用启动自检用。
 *
 * 刻意做成「启动即失败」而不是「运行时静默跳过」：一条写宽了的 `pathPrefixes`
 * 在功能正常的租户身上完全看不出来，只有恰好套餐里没勾这个功能、又恰好到期的那家店会撞上，
 * 而那家店此刻正想给平台付钱。
 *
 * @param defs - 功能开关注册表
 * @throws Error - 存在遮蔽，错误信息里逐条列出冲突
 */
export function assertFeatureNotShadowingRenewal(defs: readonly FeatureDef[]): void {
  const conflicts = findRenewalShadowConflicts(defs)
  if (conflicts.length === 0) return
  const lines = conflicts.map(
    (c) =>
      `  - 功能 ${c.featureKey} 的前缀 ${c.featurePrefix} ${
        c.kind === 'COVERS' ? '盖住了' : '钻进了'
      }续费白名单 ${c.renewalPrefix}`,
  )
  throw new Error(
    `[@taizan/billing-rules] 功能开关遮蔽了续费白名单，商家到期后将无法续费：\n${lines.join('\n')}`,
  )
}
