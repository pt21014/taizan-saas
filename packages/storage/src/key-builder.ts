/**
 * 对象 key 构造：**强制租户前缀**。
 *
 * 这是本包存在的核心不变量之一——存储桶是共享的，租户之间唯一的隔离手段就是
 * key 前缀。忘了加前缀 = 商家 A 能通过猜/枚举 key 拿到商家 B 的私有文件。
 * 所以租户 key **不接受可选的 tenantId**：拿不到 tenantId 直接抛错，
 * 调用方没有"忘记传"这条退路。
 *
 * 平台域内容（没有归属租户的素材，例如平台公告配图）走单独的
 * {@link buildPlatformKey}，前缀是 `p/`，与 `t/` 在字面上就分得开——
 * 审计脚本可以直接按前缀扫描，不必解析业务语义。
 */
import { ulid } from '@taizan/contracts'
import { assertAllowedExtension } from './mime'

const NS_PATTERN = /^[a-z][a-z0-9-]*$/

function assertValidNs(ns: string): void {
  if (!NS_PATTERN.test(ns)) {
    throw new Error(
      `[@taizan/storage] 非法的命名空间 "${ns}"：只允许小写字母开头的字母/数字/短横线，` +
        '不允许斜杠或路径穿越片段（这是防止 key 越出租户前缀目录的最后一道闸）。',
    )
  }
}

function normalizeExt(ext: string): string {
  const withDot = ext.startsWith('.') ? ext : `.${ext}`
  assertAllowedExtension(withDot)
  return withDot.toLowerCase()
}

/**
 * 租户域对象 key：`t/{tenantId}/{ns}/{ulid}.{ext}`。
 *
 * @throws `tenantId` 为空字符串/`undefined`/`null` 时抛——**没有"用平台默认值
 *   顶上"这回事**，调用方必须显式知道自己在给哪个租户建 key。
 * @throws `ns` 不合法或 `ext` 不在白名单时抛
 */
export function buildTenantKey(
  tenantId: string | null | undefined,
  ns: string,
  ext: string,
): string {
  if (!tenantId) {
    throw new Error(
      '[@taizan/storage] buildTenantKey 缺少 tenantId：租户对象 key 必须带租户前缀，' +
        '没有 tenantId 就不知道这份文件该隔离进哪个租户目录。平台域内容请显式调用 buildPlatformKey()。',
    )
  }
  assertValidNs(ns)
  const safeExt = normalizeExt(ext)
  return `t/${tenantId}/${ns}/${ulid()}${safeExt}`
}

/**
 * 平台域对象 key：`p/{ns}/{ulid}.{ext}`。
 *
 * 显式 API、不是 `buildTenantKey(undefined, ...)` 的兜底分支——调用点必须
 * 自己写出"这是平台域"这句话，才不会有人把"忘了传 tenantId"和"确实是平台内容"
 * 搞混。
 */
export function buildPlatformKey(ns: string, ext: string): string {
  assertValidNs(ns)
  const safeExt = normalizeExt(ext)
  return `p/${ns}/${ulid()}${safeExt}`
}

/** 一个 key 是否属于租户域（`t/` 前缀）。 */
export function isTenantKey(key: string): boolean {
  return key.startsWith('t/')
}

/** 一个 key 是否属于平台域（`p/` 前缀）。 */
export function isPlatformKey(key: string): boolean {
  return key.startsWith('p/')
}

/**
 * 从租户域 key 里取出 tenantId；不是租户域 key 或格式不对时返回 `null`。
 *
 * 供审计/排障用：**不要**反过来拿它当"信任 key 里的 tenantId"的依据——
 * 业务代码判断一份文件归哪个租户，永远以数据库里存的那份记录为准。
 */
export function tenantIdOfKey(key: string): string | null {
  if (!isTenantKey(key)) return null
  const parts = key.split('/')
  return parts.length >= 4 ? (parts[1] ?? null) : null
}
