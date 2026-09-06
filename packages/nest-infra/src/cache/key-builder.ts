/**
 * 缓存 key 规则：`t:{tenantId}:{ns}:{k}`（蓝图 §4.7）。
 *
 * ## 为什么租户前缀是强制的
 *
 * 缓存是**跨租户脏读最容易发生的地方**：数据库那边有隔离扩展兜着，而缓存只是一个
 * 字符串 key 到值的映射，谁都能写、谁都能读。只要有人写出
 * `cache.get('goods', goodsId)`，A 店的商品就会被 B 店读到——而且因为命中缓存，
 * 这条数据不会经过任何数据库查询，隔离层根本没有机会介入。
 *
 * 所以这里的规则是**失败关闭**：没有租户上下文，又没有显式声明这是平台级命名空间，
 * 直接抛。宁可 500，也不要一次静默的跨租户脏读。
 *
 * ## `platform:` 前缀
 *
 * 平台级缓存（套餐定义、平台公告、开放平台 token）本来就跨租户，命名空间以
 * `platform:` 开头即可放行，落在 `t:platform:{ns}:{k}` 下。
 * 租户 id 是 26 位大写 Crockford Base32 的 ULID，永远不可能等于小写的 `platform`，
 * 所以这个槽位不会和任何真实租户撞上。
 *
 * @packageDocumentation
 */

/** 平台级命名空间前缀。 */
export const PLATFORM_NS_PREFIX = 'platform:'

/** 平台级缓存占用的「租户」槽位。 */
export const PLATFORM_TENANT_SLOT = 'platform'

/** 缺租户上下文又不是平台命名空间时抛。 */
export class CacheTenantContextError extends Error {
  override readonly name = 'CacheTenantContextError'
  constructor(readonly namespace: string) {
    super(
      `[@taizan/nest-infra] 缓存命名空间 "${namespace}" 需要租户上下文，但当前没有。` +
        `如果这确实是平台级缓存（跨租户共享），请把命名空间改成 "${PLATFORM_NS_PREFIX}${namespace}"；` +
        '否则请检查是不是在没有租户上下文的地方（cron / 队列 / 公共路由）读写了租户缓存。',
    )
  }
}

/** 命名空间是不是平台级。 */
export function isPlatformNamespace(ns: string): boolean {
  return ns.startsWith(PLATFORM_NS_PREFIX)
}

/**
 * 组 key。
 *
 * @param ns - 命名空间，例如 `goods` 或 `platform:plan`
 * @param key - 业务 key
 * @param tenantId - 当前租户；平台命名空间时忽略
 * @throws {CacheTenantContextError} 非平台命名空间且没有租户
 */
export function buildCacheKey(ns: string, key: string, tenantId: string | undefined): string {
  assertNamespace(ns)
  // 平台命名空间**无论有没有租户上下文都走 platform 槽位**：
  // 跟着上下文走的话，同一份平台数据会在每个租户下各存一份，改了之后清不干净。
  if (isPlatformNamespace(ns)) {
    return `t:${PLATFORM_TENANT_SLOT}:${ns}:${key}`
  }
  if (!tenantId) {
    throw new CacheTenantContextError(ns)
  }
  return `t:${tenantId}:${ns}:${key}`
}

/** 组命名空间通配式，给 `delNs` 用。 */
export function buildNamespacePattern(ns: string, tenantId: string | undefined): string {
  return buildCacheKey(ns, '*', tenantId)
}

function assertNamespace(ns: string): void {
  if (!ns || ns.trim().length === 0) {
    throw new Error('[@taizan/nest-infra] 缓存命名空间不能为空')
  }
  if (ns.includes('*') || ns.includes('?')) {
    // 命名空间里带通配符会让 delNs 的 SCAN 匹配面失控（`delNs('a*')` 能删掉别人的东西）。
    throw new Error(`[@taizan/nest-infra] 缓存命名空间不允许含通配符：${ns}`)
  }
}
