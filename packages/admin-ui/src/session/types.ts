/**
 * 商家后台登录/换店的本地类型（对齐 `apps/api/src/modules/admin/auth/admin-auth.service.ts`
 * 的 `ShopChoice`/`AdminLoginResult`）。
 *
 * 这里不从 `apps/api` import：`apps/api` 不是共享包，四端协议只到 `@taizan/contracts`
 * 那一层（`BootstrapResponse` 等）为止，登录接口的返回形状是 admin 侧自己的实现细节，
 * 所以在 `@taizan/admin-ui` 里镜像一份签名即可，形状变了由后端联调测试兜底发现。
 */

/** 登录/换店结果里，名下可选的一家店。 */
export interface ShopChoice {
  tenantId: string
  name: string
  slug: string
  /** 这个账号在这家店里是不是店主 */
  isOwner: boolean
}

/** `POST /api/admin/auth/login` 与 `POST /api/admin/auth/switch` 共用的结果形状。 */
export type AdminLoginResult =
  | {
      /** 直接登录/换店成功，拿到新 token */
      needChooseShop: false
      access: string
      refresh: string
      expiresIn: number
      staffId: string
      tenantId: string
      shops: ShopChoice[]
    }
  | {
      /** 名下多店，还没有 token，需要带 `tenantId` 再打一次 `/api/admin/auth/login` */
      needChooseShop: true
      shops: ShopChoice[]
    }

/** {@link AdminLoginResult} 的类型收窄辅助函数。 */
export function needsShopChoice(
  result: AdminLoginResult,
): result is AdminLoginResult & { needChooseShop: true } {
  return result.needChooseShop
}
