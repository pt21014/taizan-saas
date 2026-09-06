/**
 * 店铺路径（`Tenant.slug`）的形状与保留字。
 *
 * slug 会出现在**子域名**、小程序启动参数、支付回调 URL、商家印在物料上的链接里，
 * 而且 `Tenant.slug` 是**不可改**的。所以这两条规则都是「放出去就收不回来」的那种：
 *
 * - **形状**：小写字母、数字、连字符，3–32 位，不以连字符开头结尾。
 *   大小写混着落库会变成两家看起来一样的店；下划线在子域名里非法；
 *   一位两位的路径要留给将来的短链。
 * - **保留字**：两类。① 将来可能变成我们自己的二级路径（`api` / `admin` / `www` / `help`…）——
 *   放出去，哪天要用就得跟商家要回来，而他的链接已经印在物料上了；
 *   ② 看起来像官方（`official` / `platform` / `kefu`…）——放出去，
 *   顾客会以为那家店是平台开的，出了纠纷是平台的名声。
 *
 * 两个都是**纯数据**，不读 DB：注册页要边打字边校验形状，那一步没有数据库。
 *
 * @packageDocumentation
 */

/**
 * slug 的形状。
 *
 * 拆成「首字符 + 中间 1–30 位 + 末字符」正好卡出 3–32 位，且天然排除了首尾连字符。
 * 连续连字符（`a--b`）**允许**：punycode 的 `xx--` 前缀是我们不生成的，
 * 而为了它多加一条规则，只会让商家在注册页上撞见一个说不清理由的报错。
 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/

/** slug 最短长度。 */
export const SLUG_MIN_LENGTH = 3

/** slug 最长长度。 */
export const SLUG_MAX_LENGTH = 32

/**
 * 不许被占用的店铺路径。
 *
 * 加词只进不出：删一个词等于把它放给下一个注册的人，而它可能已经是某条内部路径了。
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // 一、我们自己的路径与子域名（将来要用的也先占住）
  'about',
  'account',
  'admin',
  'administrator',
  'api',
  'app',
  'apps',
  'assets',
  'auth',
  'billing',
  'blog',
  'cdn',
  'checkout',
  'client',
  'console',
  'dashboard',
  'dev',
  'doc',
  'docs',
  'download',
  'file',
  'files',
  'ftp',
  'help',
  'home',
  'image',
  'images',
  'index',
  'invite',
  'login',
  'logout',
  'mail',
  'manage',
  'media',
  'mini',
  // 'mp' 这类两位的词不用写：{@link SLUG_MIN_LENGTH} 已经把三位以下全挡了，
  // 写进来只会让「保留字清单里每一条都得是合法形状」那条自检永远红。
  'new',
  'news',
  'notify',
  'open',
  'order',
  'pay',
  'plan',
  'preview',
  'public',
  'register',
  'root',
  'signup',
  'sso',
  'staging',
  'static',
  'status',
  'store',
  'shop',
  'support',
  'system',
  'test',
  'upload',
  'uploads',
  'user',
  'users',
  'weapp',
  'webhook',
  'wechat',
  'weixin',
  'www',
  // 二、看起来像官方
  'kefu',
  'office',
  'official',
  'platform',
  'service',
  'taizan',
])

/** 这个（已归一化的）slug 是不是保留字。 */
export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug)
}
