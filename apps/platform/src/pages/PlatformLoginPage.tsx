import { useLocation } from 'react-router-dom'
import { LoginPage, readReturnTo } from '@taizan/admin-ui'

/**
 * 平台超管登录页（T3-4）：用户名 + 口令，对接 `POST /api/platform/auth/login`。
 *
 * ## 历史：这里曾经是一份本地重写的登录页
 *
 * `@taizan/admin-ui` 的 `<LoginPage>` 曾经把表单字段名、手机号正则校验都写死给
 * "商家账密登录"用，平台侧（用户名登录、没有选店）只能本地重写一份。现在
 * `<LoginPage>` 的 `config` 加了 `identifierField: 'username'`（连带 `useSession().login()`
 * 第一个参数放宽成了「登录标识符」），直接复用即可——`homePath` 的算法照抄
 * `apps/admin/src/App.tsx` 用 `<LoginPage>` 时的写法（`readReturnTo`，深链接登录后跳回原地址）。
 *
 * MFA：登录页目前没有 TOTP 输入框——后端 `platform-auth.service.ts` 的 `login()`
 * 本阶段完全不校验 `totp`（见该文件的 TODO 注释与 `platform-mfa.service.ts` 文件头
 * 的范围说明），加这个输入框之前先接上后端校验没有意义。
 */
export default function PlatformLoginPage() {
  const location = useLocation()

  return (
    <LoginPage
      config={{
        title: '太阶 SaaS · 平台超管后台',
        identifierField: 'username',
        // 平台超管后台历史上一直把这个字段叫「口令」（不是「密码」）——
        // e2e（`e2e/platform.spec.ts`）按这个 label 定位输入框，保留原文案。
        passwordLabel: '口令',
        homePath: readReturnTo(location.search) ?? '/dashboard',
      }}
    />
  )
}
