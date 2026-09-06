import { useLaunch } from '@tarojs/taro'
import type { PropsWithChildren } from 'react'

import { gotoTenantMissingPage } from '@taizan/client-core'

import { initTenantSlug } from './services/client'

import './app.scss'

/**
 * 应用入口：`useLaunch` 里做一次 tenantSlug 解析（`initTenantSlug`，见
 * `services/client.ts`）。解析不出来（H5 没有 `/s/:slug` 也没有可识别的子域名，
 * 小程序既没有 `query.slug` 也没有 `scene`，本地也没有上一次持久化的值）就是真的
 * 「不知道是哪家店」——直接跳店铺不可用页，而不是让首页带着空 slug 发一堆注定失败的请求。
 *
 * 请求层的 `session`/`request`（见 `services/client.ts`）在装配时已经把 401/1440302/1240400
 * 三种情况接到了对应的清态/跳转钩子上，其余页面不需要再关心这些分流逻辑。
 */
function App({ children }: PropsWithChildren) {
  useLaunch(() => {
    const slug = initTenantSlug()
    if (!slug) {
      gotoTenantMissingPage()
    }
  })

  return children
}

export default App
