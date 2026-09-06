import { Card } from 'antd'

/**
 * 只有 `goods:export` 权限的人才进得来。
 * 换到「分店」（没有这个权限点）后直接敲 `/goods/export`，看到的是 `<RequirePermission>`
 * 渲染的 403 页，而不是一张白屏——这正是 `buildRoutes()` 给每条路由包一层的理由。
 */
export default function GoodsExportPage() {
  return <Card title="导出商品">这里是导出页，需要 goods:export 权限。</Card>
}
