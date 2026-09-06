import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { fetchSiteConfig, type SiteConfig } from '../api'

export interface SiteConfigState {
  /** `null` = 还没拿到（首次加载中，或者接口失败）。 */
  cfg: SiteConfig | null
  loading: boolean
  /** 请求失败过一次。价格页等强依赖它的页面据此显示「换个说法」的兜底文案。 */
  failed: boolean
}

const SiteConfigContext = createContext<SiteConfigState>({
  cfg: null,
  loading: true,
  failed: false,
})

/**
 * 全站只拉一次 `/api/public/site-config`，`App.tsx` 装配一次，所有页面共享。
 *
 * **拿不到就用兜底渲染，不显示错误页**（蓝图要求）：官网打不开这一个接口
 * 也不能连着首页一起白屏——`cfg` 留 `null`，`failed` 置 `true`，页面自己决定怎么兜底。
 */
export function SiteConfigProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SiteConfigState>({ cfg: null, loading: true, failed: false })

  useEffect(() => {
    let alive = true
    fetchSiteConfig()
      .then((cfg) => {
        if (alive) setState({ cfg, loading: false, failed: false })
      })
      .catch(() => {
        if (alive) setState({ cfg: null, loading: false, failed: true })
      })
    return () => {
      alive = false
    }
  }, [])

  return <SiteConfigContext.Provider value={state}>{children}</SiteConfigContext.Provider>
}

export function useSiteConfig(): SiteConfigState {
  return useContext(SiteConfigContext)
}
