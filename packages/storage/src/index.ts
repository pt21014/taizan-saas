/**
 * `@taizan/storage`：对象存储 Provider 接口 + 腾讯云 COS 实现 + VOD 签名 +
 * **强制租户前缀**的 key builder。
 *
 * 零框架依赖，只用 `node:crypto`；`putObject`/`deleteObject` 走调用方注入的
 * {@link HttpClient}，`presignGet`/`presignPut` 是纯 URL 拼装，不发请求。
 *
 * 最小用法：
 *
 * ```ts
 * import { buildTenantKey, CosStorageProvider } from '@taizan/storage'
 *
 * const key = buildTenantKey(tenantId, 'goods-image', '.jpg')
 * const provider = new CosStorageProvider(httpClient)
 * const { url, headers } = provider.presignPut(key, { expireSeconds: 600 }, cosConfig)
 * // 把 { url, headers } 交给前端，前端直接 PUT 文件内容，不经过业务后端
 * ```
 *
 * @packageDocumentation
 */
export type { HttpClient, HttpResponse } from './http-client'
export type {
  PresignGetOptions,
  PresignPutOptions,
  PresignPutResult,
  PutObjectRequest,
  PutObjectResult,
  StorageProvider,
} from './provider'
export {
  buildPlatformKey,
  buildTenantKey,
  isPlatformKey,
  isTenantKey,
  tenantIdOfKey,
} from './key-builder'
export {
  ALLOWED_EXTENSIONS,
  assertAllowedExtension,
  contentTypeOf,
  isAllowedExtension,
} from './mime'
export { assertValidExpireSeconds, MAX_EXPIRE_SECONDS, MIN_EXPIRE_SECONDS } from './presign'
export {
  cosAuthorization,
  cosPercentEncode,
  CosStorageProvider,
  type CosConfig,
  type CosSignInput,
  type CosSignResult,
} from './cos'
export { buildVodUploadSignature, signVodPlayUrl, type PlayUrlOptions } from './vod-sign'
