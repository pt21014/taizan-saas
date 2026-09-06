import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { message } from 'antd'
import type {
  BootstrapIdentity,
  BootstrapQuota,
  BootstrapResponse,
  BootstrapShop,
  BootstrapTenant,
  EnvelopeClient,
  MenuNode,
} from '@taizan/contracts'

import { createRequest } from '../request'
import { createTokenStorage } from './storage'
import { showReadonlyNotice } from './readonly-notice'
import type { AdminLoginResult, ShopChoice } from './types'

export type SessionStatus = 'idle' | 'loading' | 'ready' | 'error'

/**
 * `createSessionStore()` 打的三个接口路径（T3-4 之前写死在函数体内）。
 *
 * 商家后台是 `/api/admin/auth/{login,bootstrap,switch}`，但平台超管后台是用户名登录、
 * 没有选店/换店这一步，接口也在 `/api/platform/auth/*` 之下——写死路径的直接后果是
 * `apps/platform` 只能整份手写一份「形状兼容」的 store（见 `apps/platform/src/session.ts`
 * 的历史版本）。三个字段都可选，缺省沿用原来写死的那三条，因此对 `apps/admin` 零破坏。
 */
export interface SessionEndpoints {
  /** 登录接口，默认 `/api/admin/auth/login` */
  login?: string
  /** bootstrap 接口，默认 `/api/admin/auth/bootstrap` */
  bootstrap?: string
  /** 换店接口，默认 `/api/admin/auth/switch`；没有「换店」概念的场景（如平台后台）不会被调到 */
  switchTenant?: string
}

/** {@link createSessionStore} 的入参。 */
export interface SessionConfig {
  /** 接口前缀，如 `/api` */
  baseURL: string
  /**
   * localStorage 键名前缀；`apps/admin`/`apps/platform` 应各传一个不同的值，避免互相踩键。
   *
   * @deprecated 用 {@link SessionConfig.storageKey}，两者传一个即可、同时传时 `storageKey`
   *   优先——保留这个名字只是不破坏 `apps/admin` 现有调用点。
   */
  storageKeyPrefix?: string
  /** `storageKeyPrefix` 的新名字，语义完全相同。 */
  storageKey?: string
  /** 401 清态后要跳去的登录页路径（前端路由，不是接口），默认 `/login` */
  loginPath?: string
  /** `1440301` 弹「去续费」时要跳的账单页路径，默认 `/billing` */
  billingPath?: string
  /** 覆盖默认的「去续费」提示 UI（默认是 antd notification + 按钮） */
  onReadonly?: (message: string, gotoBilling: () => void) => void
  /** 登录/bootstrap/换店三个接口路径，缺省是商家后台那三条，见 {@link SessionEndpoints} */
  endpoints?: SessionEndpoints
  /**
   * 登录请求体里，登录标识符字段叫什么。默认 `'phone'`（商家账密登录）；
   * 平台超管后台用户名登录，传 `'username'`。只影响 `login()` 发出去的 body 里那一个
   * 字段的 key，不影响其它任何逻辑（选店/换店/bootstrap 都不看这个字段）。
   */
  identifierField?: 'phone' | 'username'
}

/** `useSession` 暴露的完整会话状态。字段与 `BootstrapResponse` 一一对应——它是唯一真源。 */
export interface SessionState {
  identity: BootstrapIdentity | null
  tenant: BootstrapTenant | null
  shops: BootstrapShop[]
  permissions: string[]
  menus: MenuNode[]
  quotas: Record<string, BootstrapQuota>
  token: string | null
  status: SessionStatus
  /** 已配置好错误码分流的信封客户端，供 T3-2 的 CRUD 层直接复用，不必再拼一份 */
  request: EnvelopeClient
  /** 拉取 `/api/admin/auth/bootstrap`，填充身份/租户/店铺/权限/菜单/配额 */
  bootstrap: () => Promise<void>
  /**
   * 账密登录。名下多店且没传 `tenantId` 时，后端只回一张选店列表（不发 token）——
   * 这一支返回非空数组；调用方应展示 `<ShopChooserPage>`，选中后带着 `tenantId`
   * 再调一次 `login()`。单店或已指定 `tenantId` 时直接拿到 token 并自动 `bootstrap()`。
   */
  login: (phone: string, password: string, tenantId?: string) => Promise<ShopChoice[] | null>
  /** 换店：重签 token 后**整页重载**——各页面组件状态里还留着上一家店的数据，软跳转会串店 */
  switchTenant: (tenantId: string) => Promise<void>
  logout: () => void
}

export type SessionStore = UseBoundStore<StoreApi<SessionState>>

const EMPTY_SESSION = {
  identity: null,
  tenant: null,
  shops: [] as BootstrapShop[],
  permissions: [] as string[],
  menus: [] as MenuNode[],
  quotas: {} as Record<string, BootstrapQuota>,
  token: null,
} satisfies Partial<SessionState>

/**
 * 创建一份会话 store（蓝图 §5.2/T3-1）。`apps/admin`/`apps/platform` 各自调一次，
 * 传各自的 `baseURL`/`storageKeyPrefix`，再用 `<SessionProvider store={...}>` 套住
 * 页面树——admin-ui 内置的 `<AppShell>`/`<LoginPage>`/`<ShopSwitcher>` 等组件都通过
 * `useSession()` 从 context 里取这份 store，不关心它是哪个 app 创建的。
 */
export function createSessionStore(config: SessionConfig): SessionStore {
  const storage = createTokenStorage(config.storageKey ?? config.storageKeyPrefix)
  const loginPath = config.loginPath ?? '/login'
  const billingPath = config.billingPath ?? '/billing'
  const notifyReadonly = config.onReadonly ?? showReadonlyNotice
  const identifierField = config.identifierField ?? 'phone'
  const endpoints = {
    login: config.endpoints?.login ?? '/api/admin/auth/login',
    bootstrap: config.endpoints?.bootstrap ?? '/api/admin/auth/bootstrap',
    switchTenant: config.endpoints?.switchTenant ?? '/api/admin/auth/switch',
  }

  return create<SessionState>((set, get) => {
    const request = createRequest({
      baseURL: config.baseURL,
      getToken: () => storage.get(),
      getTenantSlug: () => get().tenant?.slug ?? null,
      onUnauthorized: () => {
        storage.clear()
        set({ ...EMPTY_SESSION, status: 'idle' })
        if (typeof window !== 'undefined') {
          window.location.href = loginPath
        }
      },
      onForbidden: (error) => {
        message.error(error.message)
      },
      onBizError: (error) => {
        message.error(error.message)
      },
      onReadonly: (error) => {
        notifyReadonly(error.message, () => {
          if (typeof window !== 'undefined') {
            window.location.href = billingPath
          }
        })
      },
    })

    const applyBootstrap = (data: BootstrapResponse): void => {
      set({
        identity: data.identity,
        tenant: data.tenant,
        shops: data.shops,
        permissions: data.permissions,
        menus: data.menus,
        quotas: data.quotas,
        status: 'ready',
      })
    }

    return {
      ...EMPTY_SESSION,
      // 初值从 localStorage 里读，而不是恒为 null：整页刷新后 store 是全新的，
      // 恒为 null 意味着 <RequireAuth> 会把已登录用户弹回登录页，
      // 明明 token 还在（T3-2 接入权限路由时暴露出来的）。
      token: storage.get(),
      status: 'idle',
      request,

      bootstrap: async () => {
        set({ status: 'loading' })
        try {
          const data = await request.get<BootstrapResponse>(endpoints.bootstrap)
          applyBootstrap(data)
        } catch (err) {
          set({ status: 'error' })
          throw err
        }
      },

      login: async (phone, password, tenantId) => {
        const result = await request.post<AdminLoginResult>(endpoints.login, {
          [identifierField]: phone,
          password,
          tenantId,
        })
        if (result.needChooseShop) {
          return result.shops
        }
        storage.set(result.access)
        set({ token: result.access })
        await get().bootstrap()
        return null
      },

      switchTenant: async (tenantId) => {
        const result = await request.post<AdminLoginResult>(endpoints.switchTenant, { tenantId })
        if (result.needChooseShop) {
          // 理论上不会发生：换店是已登录态操作，服务端只会直接重签或拒绝（不在你名下）
          return
        }
        storage.set(result.access)
        if (typeof window !== 'undefined') {
          window.location.reload()
        }
      },

      logout: () => {
        storage.clear()
        set({ ...EMPTY_SESSION, status: 'idle' })
      },
    }
  })
}
