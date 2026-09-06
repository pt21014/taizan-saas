/**
 * 蓝图 §4.1 + §5.3：C 端租户由 `X-Tenant-Slug` 头解析（一旦登录，token 里的 tenantId
 * 优先级更高，见后端 `TokenTenantResolver`），这个头的值从哪来是前端的事——
 * H5 从路径 `/s/:slug/...` 或子域名解析，小程序从启动参数（`scene` 二维码场景值 /
 * 直接 `query.slug`）解析。三种来源都解析不出来时，退回上一次持久化在 storage 里的值，
 * 全都没有才是真的「不知道是哪家店」（对应 `1240400` 店铺不可用页）。
 *
 * 纯函数（`parseSlugFrom*`）与副作用（`resolveTenantSlug`/storage 读写）分开：
 * 前者不依赖 `Taro`，单测直接传字符串；后者才碰 `Taro.getCurrentInstance()`/storage。
 *
 * @packageDocumentation
 */

import Taro from '@tarojs/taro'

const TENANT_SLUG_STORAGE_KEY = 'taizan_tenant_slug'

/** H5 路径里 slug 的默认位置：`/s/:slug/...`。 */
const DEFAULT_H5_PATH_PATTERN = /^\/s\/([^/?#]+)/

/** 从 H5 路径解析 slug，如 `/s/demo/pages/index` → `'demo'`。解析不出来返回 `null`。 */
export function parseSlugFromH5Path(
  pathname: string,
  pattern: RegExp = DEFAULT_H5_PATH_PATTERN,
): string | null {
  const matched = pathname.match(pattern)
  return matched?.[1] ? decodeURIComponent(matched[1]) : null
}

/** 从 H5 子域名解析 slug，如 `demo.taizan.vip` + `baseDomain='taizan.vip'` → `'demo'`。 */
export function parseSlugFromSubdomain(
  hostname: string,
  opts: { baseDomain: string; reserved?: readonly string[] },
): string | null {
  const { baseDomain, reserved = ['www', 'api', 'admin', 'platform'] } = opts
  const suffix = `.${baseDomain}`
  if (!hostname.endsWith(suffix)) return null
  const sub = hostname.slice(0, -suffix.length)
  if (!sub || sub.includes('.') || reserved.includes(sub)) return null
  return sub
}

/**
 * 从小程序码的 `scene` 字段解析 slug。`scene` 是扫码进入时携带的场景值，
 * 微信只保留原样字符串（最多 32 个字符），这里按 `slug=xxx` 或纯 slug 两种形状兼容解析。
 */
export function parseSlugFromWeappScene(scene: string | undefined | null): string | null {
  if (!scene) return null
  const decoded = safeDecode(scene)
  const kv = decoded.match(/(?:^|&)slug=([^&]+)/)
  if (kv?.[1]) return safeDecode(kv[1])
  // 没有 `slug=` 前缀时，把整个 scene 当作 slug 本身（配合后端生成二维码时的约定）。
  return /^[a-z0-9-]+$/i.test(decoded) ? decoded : null
}

/** 从小程序启动参数 `query.slug` 直接解析（分享卡片 / 自定义链接常见形态）。 */
export function parseSlugFromWeappQuery(query: Record<string, unknown> | undefined): string | null {
  const value = query?.['slug']
  return typeof value === 'string' && value.length > 0 ? value : null
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** 读取上一次持久化的 tenantSlug；从未解析成功过时返回 `null`。 */
export function getStoredTenantSlug(): string | null {
  try {
    const value = Taro.getStorageSync(TENANT_SLUG_STORAGE_KEY) as string | undefined
    return value || null
  } catch {
    return null
  }
}

/** 把解析出来的 tenantSlug 持久化，供下次启动（或本次其余请求）兜底使用。 */
export function setStoredTenantSlug(slug: string): void {
  Taro.setStorageSync(TENANT_SLUG_STORAGE_KEY, slug)
}

/** {@link resolveTenantSlug} 的可选项：允许业务方覆盖 H5 路径正则与子域名底域。 */
export interface ResolveTenantSlugOptions {
  h5PathPattern?: RegExp
  /** H5 子域名解析所需的底域，如 `'taizan.vip'`；不传则跳过子域名解析 */
  h5BaseDomain?: string
}

/**
 * 解析当前 tenantSlug：H5 按「路径 → 子域名 → 持久化值」顺序，小程序按
 * 「启动参数 query.slug → scene → 持久化值」顺序。命中即持久化，方便下次兜底。
 */
export function resolveTenantSlug(opts: ResolveTenantSlugOptions = {}): string | null {
  const resolved = process.env.TARO_ENV === 'weapp' ? resolveFromWeapp() : resolveFromH5(opts)
  if (resolved) {
    setStoredTenantSlug(resolved)
    return resolved
  }
  return getStoredTenantSlug()
}

function resolveFromH5(opts: ResolveTenantSlugOptions): string | null {
  if (typeof window === 'undefined') return null
  const fromPath = parseSlugFromH5Path(window.location.pathname, opts.h5PathPattern)
  if (fromPath) return fromPath
  if (opts.h5BaseDomain) {
    const fromSubdomain = parseSlugFromSubdomain(window.location.hostname, {
      baseDomain: opts.h5BaseDomain,
    })
    if (fromSubdomain) return fromSubdomain
  }
  return null
}

function resolveFromWeapp(): string | null {
  const instance = Taro.getCurrentInstance()
  const query = instance?.router?.params as Record<string, unknown> | undefined
  const fromQuery = parseSlugFromWeappQuery(query)
  if (fromQuery) return fromQuery
  const scene = query?.['scene'] as string | undefined
  return parseSlugFromWeappScene(scene)
}
