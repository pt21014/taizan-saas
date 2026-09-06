import { createSessionStore } from '@taizan/admin-ui'

/**
 * 平台超管的会话 store（T3-4）。
 *
 * ## 历史：这里曾经是一份手写的「形状兼容」store
 *
 * 在 `GET /api/platform/auth/bootstrap` 落地之前，`@taizan/admin-ui` 的
 * `createSessionStore()` 把 `/api/admin/auth/{login,switch,bootstrap}` 三个路径与
 * 「手机号登录」写死在函数体内，平台侧（用户名登录、没有选店、接口在 `/api/platform/*`
 * 之下）只能另起一份手写实现（借 `createRequest`/`createTokenStorage` 两个通用积木）。
 *
 * 现在 `createSessionStore()` 已经把这些做成了可配置项（`endpoints`/`identifierField`/
 * `storageKey`），加上后端真的下发了 `GET /api/platform/auth/bootstrap`（身份/权限/
 * 已裁剪菜单一次拿全，见 `apps/api/src/modules/platform/auth/platform-auth.service.ts`），
 * 这里就只是一份配置，不用再手写任何请求/状态逻辑。
 *
 * ## 三处仍然值得记录的「平台侧特殊之处」
 *
 * 1. **`identity`/`tenant`/`shops`/`quotas` 对平台超管没有语义**：`PlatformBootstrapResponse`
 *    为了结构上兼容 `@taizan/contracts` 的通用 `BootstrapResponse`（从而能复用这份
 *    generic store），给 `tenant`/`shops`/`quotas` 填了占位值（`tenant.slug` 特意是
 *    空字符串——`EnvelopeClient` 对空字符串不加 `X-Tenant-Slug` 头）。`identity` 在标准
 *    字段之外多带了 `adminId`/`username` 两个平台专属字段，类型见后端
 *    `PlatformBootstrapIdentity`（这里不重复 import 那个类型，多店/组件里目前都只用到
 *    标准的 `identity.name`）。
 * 2. **权限本阶段全权**：`permissions` 恒为字面量 `['*']`（后端 `platform.permissions.ts`
 *    与 `platform-auth.service.ts` 的注释都写了同一件事——`PlatformAdmin.roleIds` 完全
 *    没有参与鉴权判定）。因为没有任何页面/按钮会拿具体 code 去 `usePerm().has(...)`
 *    判定，这不会导致任何按钮被误藏；等平台侧角色/权限体系定下来，这里不用改一行，
 *    后端换成真实展开结果即可。
 * 3. **没有「换店」**：`endpoints` 里不传 `switchTenant`——`shops` 恒为 `[]`，
 *    `<AppShell showShopSwitcher={false}>`（见 `App.tsx`）已经不会渲染 `<ShopSwitcher>`，
 *    也就不存在会调用它的路径。
 */
export const useSession = createSessionStore({
  // 空字符串：本机开发走 vite.config.ts 的 /api 代理，生产构建时同源部署。
  // （不用 `import.meta.env.VITE_API_BASE`：apps/platform 的 tsconfig 没有引入
  // `vite/client` 类型，且历史上这里就一直是同源部署，不需要单独可配的后端地址。）
  baseURL: '',
  // `taizan_platform`（不是 `platform`）：localStorage 键沿用历史上一直用的前缀
  // （`taizan_platform_token`），`e2e/platform.spec.ts` 会直接从 localStorage 读它
  // 核对已登录态，改名字会让那条 e2e 读不到 token。
  storageKey: 'taizan_platform',
  identifierField: 'username',
  endpoints: {
    login: '/api/platform/auth/login',
    bootstrap: '/api/platform/auth/bootstrap',
  },
})
