/**
 * `@taizan/client-core`：Taro（H5 + 微信小程序）C 端基座。
 *
 * @packageDocumentation
 */

export { createTaroTransport, createClientRequest, type ClientRequestOptions } from './request'

export {
  parseSlugFromH5Path,
  parseSlugFromSubdomain,
  parseSlugFromWeappScene,
  parseSlugFromWeappQuery,
  getStoredTenantSlug,
  setStoredTenantSlug,
  resolveTenantSlug,
  type ResolveTenantSlugOptions,
} from './tenant'

export {
  getMemberToken,
  setMemberToken,
  clearMemberToken,
  useMemberSession,
  createSession,
  type Session,
  type LoginResult,
} from './session'

export {
  CLOSED_PAGE_PATH,
  TENANT_MISSING_PAGE_PATH,
  gotoClosedPage,
  gotoTenantMissingPage,
} from './pages'

export { pay, type WechatPayParams, type PayResult } from './adapters/pay'
export { share, buildShareConfig, type ShareParams, type ShareResult } from './adapters/share'
export { loginWithPlatform, type PlatformLoginResult } from './adapters/login'
export { chooseImage, type ChooseImageParams, type ChooseImageResult } from './adapters/media'

// 四端统一响应包协议层的核心导出，方便 apps/client 直接从 client-core 引用，
// 不必再单独依赖 @taizan/contracts。`ApiError` 是类（需要 instanceof），
// `EnvelopeClient` 只是类型。
export { ApiError } from '@taizan/contracts'
export type { EnvelopeClient } from '@taizan/contracts'
