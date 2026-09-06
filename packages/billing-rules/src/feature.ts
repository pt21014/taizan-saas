/**
 * 功能开关（套餐插件）三态判定与路径匹配。
 *
 * ## 两条最容易搞错的（从 knowledge `plan-feature.ts` 原样继承）
 *
 * **① `null` = 全部可用，`[]` = 一个都不给。** 与配额那条 `null`/`0` 同一个道理。
 * 存量套餐和还没配过 features 的套餐都落在 `null` 上——上线那一刻谁的能力都不变。
 * 混成一个的话，加这个字段的当天所有商家会集体失去所有插件。
 *
 * **② 默认只拦写，读照常。** 商家可能已经发出去一批优惠券，学员手里还拿着。
 * 读也拦掉的话，他在后台查不到自己发过什么，客服就没法回答学员——而那些券并不会因为
 * 套餐降级就失效。同「套餐到期后台转只读」那条取舍。需要连读都拦的功能，
 * 显式把 {@link FeatureDef.writeOnly} 设成 `false`。
 *
 * ## 不做「无套餐 = 全部可用」
 *
 * xiaodian 的 `entitlement.ts` 里，租户没套餐或套餐失效一律放行全部应用（向下兼容）。
 * 本框架**不采用**：那条规则让「没套餐」和「买了顶配套餐」权限一样，平台想收钱的动力全没了，
 * 而且它是隐式的——读代码的人看不出来一个空 `package_id` 意味着全开。
 * 这里改成三态显式：要全开就存 `null`，要全关就存 `[]`，两者在库里长得不一样。
 */

import { ErrorCode } from '@taizan/contracts'

/**
 * 功能可用性三态判定。
 *
 * @param features - 套餐的 features 白名单。`null` = 全部可用，`[]` = 一个都不给
 * @param key - 功能 key
 * @returns 是否可用
 *
 * @example
 * ```ts
 * hasFeature(null, 'COUPON')        // true —— 全部可用
 * hasFeature([], 'COUPON')          // false —— 一个都不给
 * hasFeature(['COUPON'], 'COUPON')  // true
 * hasFeature(['EXAM'], 'COUPON')    // false
 * ```
 */
export function hasFeature(features: string[] | null, key: string): boolean {
  if (features === null) return true
  return features.includes(key)
}

/**
 * 一个功能开关的定义。注册表由业务侧提供，`billing-routes.spec.ts`（架构约束 spec 8）
 * 拿真实的 `@Controller` 前缀逐条比对，并断言它不遮蔽续费白名单。
 */
export interface FeatureDef {
  /** 功能 key，与 `Plan.features` 里存的字符串一致。 */
  key: string
  /** 给平台运营看的名字：勾掉之后商家少了什么。 */
  name: string
  /**
   * `true`（默认取值应当是它）= **只拦写操作**，读照常放行；
   * `false` = 连读一起拦（只在「这个功能的数据本身就不该被看到」时才用）。
   */
  writeOnly: boolean
  /**
   * 这个功能对应的接口路径前缀，**带 `/api` 全局前缀的完整形式**，如 `/api/admin/coupons`。
   *
   * 写错等于闸门静默失效：接口照常通，而平台以为自己锁住了。
   */
  pathPrefixes: string[]
}

/** 视为「写操作」的 HTTP 方法。其余（GET/HEAD/OPTIONS 等）一律当读。 */
export const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * 归一化一个路径前缀：补前导 `/`、削掉 query/hash、合并重复斜杠、去掉结尾斜杠。
 *
 * 归一化之后才能做「前缀 + 边界」匹配，否则 `/api/admin/coupons/` 与 `/api/admin/coupons`
 * 会被当成两个不同的前缀，而它们在路由表里是同一个。
 *
 * @param prefix - 原始前缀
 * @throws TypeError - 传了空串或只有斜杠（那会匹配到全站，是最危险的一种写错）
 */
export function normalizePathPrefix(prefix: string): string {
  if (typeof prefix !== 'string') {
    throw new TypeError(`[@taizan/billing-rules] 路径前缀必须是字符串，收到 ${String(prefix)}`)
  }
  const noQuery = prefix.split('?')[0]?.split('#')[0] ?? ''
  const collapsed = noQuery.replace(/\/{2,}/g, '/')
  const withLead = collapsed.startsWith('/') ? collapsed : `/${collapsed}`
  const trimmed = withLead.replace(/\/+$/, '')
  if (trimmed === '') {
    throw new TypeError(
      `[@taizan/billing-rules] 路径前缀不能为空或仅有斜杠（会匹配全站）：${JSON.stringify(prefix)}`,
    )
  }
  return trimmed
}

/**
 * 路径是否落在某个前缀之下，**按段边界比**。
 *
 * `/api/admin/auth` 命中 `/api/admin/auth` 与 `/api/admin/auth/switch-tenant`，
 * 但**不命中** `/api/admin/authx`——少了这个边界判断，一个叫 `authx` 的新模块会被白名单误放行，
 * 或者反过来被某个功能开关误拦，两个方向都难查。
 */
export function pathHasPrefix(path: string, prefix: string): boolean {
  const p = normalizePathPrefix(path)
  const q = normalizePathPrefix(prefix)
  return p === q || p.startsWith(`${q}/`)
}

/**
 * 按请求路径与方法找出「访问它需要哪个功能开关」。
 *
 * 规则：
 * - 写方法（{@link WRITE_METHODS}）命中任一前缀 → 需要那个 feature；
 * - 读方法命中前缀，只有该 def 的 `writeOnly === false` 时才需要（默认读不拦，见文件头 ②）；
 * - 都不命中 → 返回 `null`，这个接口不受功能开关管。
 *
 * 多个 def 命中同一路径时返回**第一个**（注册表顺序即优先级）。真出现这种重叠说明注册表写重了，
 * 由 spec 8 去盯，本函数不替它做仲裁。
 *
 * @param defs - 功能开关注册表
 * @param path - 请求路径（带不带 query 都行）
 * @param method - HTTP 方法，大小写不敏感
 * @returns 命中的 {@link FeatureDef}，或 `null`
 */
export function matchFeatureByPath(
  defs: readonly FeatureDef[],
  path: string,
  method: string,
): FeatureDef | null {
  const isWrite = WRITE_METHODS.has(String(method).toUpperCase())
  for (const def of defs) {
    if (!isWrite && def.writeOnly) continue
    for (const prefix of def.pathPrefixes) {
      if (pathHasPrefix(path, prefix)) return def
    }
  }
  return null
}

/**
 * 一次算完「这个请求要不要拦」：找出所需功能，再拿套餐 features 判三态。
 *
 * @param defs - 功能开关注册表
 * @param features - 套餐 features，`null` = 全部可用，`[]` = 一个都不给
 * @param path - 请求路径
 * @param method - HTTP 方法
 * @returns `allowed=false` 时 `required` 一定非空，直接拿去拼「当前套餐不包含 XX」的提示
 */
export function checkFeatureAccess(
  defs: readonly FeatureDef[],
  features: string[] | null,
  path: string,
  method: string,
): { allowed: boolean; required: FeatureDef | null } {
  const required = matchFeatureByPath(defs, path, method)
  if (required === null) return { allowed: true, required: null }
  return { allowed: hasFeature(features, required.key), required }
}

/**
 * 套餐未包含该功能对应的 7 位错误码 `1540302`。
 *
 * 与配额 `1540301` 分开：一个要升套餐买插件，一个要清理或加量，商家的下一步动作不同。
 */
export const FEATURE_NOT_INCLUDED_CODE: number = ErrorCode.FEATURE_NOT_INCLUDED.code

/** 把 {@link checkFeatureAccess} 的结果映射成错误码：被拦返回 `1540302`，放行返回 `null`。 */
export function featureToErrorCode(result: { allowed: boolean }): number | null {
  return result.allowed ? null : FEATURE_NOT_INCLUDED_CODE
}
