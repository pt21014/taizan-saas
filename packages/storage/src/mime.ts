/**
 * 扩展名白名单，不用黑名单。
 *
 * 放行任意后缀等于让用户往你的域名下挂 `.html`——点开就是在你域上执行他写的
 * 脚本。存储只服务图片、音频、视频、少量文档这几类已知内容，没有理由放行
 * 别的后缀。
 */
const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
}

/** 允许的扩展名（含前导 `.`，小写）。 */
export const ALLOWED_EXTENSIONS = Object.keys(CONTENT_TYPES)

/** 是否在白名单内。 */
export function isAllowedExtension(ext: string): boolean {
  return Object.hasOwn(CONTENT_TYPES, ext.toLowerCase())
}

/**
 * 校验扩展名，不在白名单里就抛。
 *
 * @throws 扩展名不在白名单时抛
 */
export function assertAllowedExtension(ext: string): void {
  if (!isAllowedExtension(ext)) {
    throw new Error(
      `[@taizan/storage] 不支持的扩展名 "${ext}"；只允许：${ALLOWED_EXTENSIONS.join(', ')}`,
    )
  }
}

/** 按扩展名取 Content-Type，取不到时用通用二进制类型（不猜测、不放行任意类型）。 */
export function contentTypeOf(ext: string): string {
  return CONTENT_TYPES[ext.toLowerCase()] ?? 'application/octet-stream'
}
