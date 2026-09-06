import { useEffect } from 'react'
import { BRAND } from '../config/BRAND'

/**
 * 每页都要设置 `<title>`，也顺带兜底更新 `<meta name="description">`。
 *
 * 不设的话，分享出去、收藏起来、浏览器历史里全叫同一个名字（`index.html` 里那个
 * 首页专用的默认标题）——SPA 客户端路由不会自动帮你换掉它。
 *
 * @param title - 页面标题，会拼成 `{title}｜{BRAND.productName}`
 * @param description - 可选，覆盖 `index.html` 里的默认 description；不传则保留原样
 */
export function usePageTitle(title: string, description?: string): void {
  useEffect(() => {
    document.title = `${title}｜${BRAND.productName}`
    if (description) {
      let meta = document.querySelector('meta[name="description"]')
      if (!meta) {
        meta = document.createElement('meta')
        meta.setAttribute('name', 'description')
        document.head.appendChild(meta)
      }
      meta.setAttribute('content', description)
    }
  }, [title, description])
}
