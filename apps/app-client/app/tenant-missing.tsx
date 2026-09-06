import { EmptyState, colors } from '@taizan/app-ui'
import { View } from 'react-native'

/**
 * `/api/client/*` 全部要求能解析出租户（`X-Tenant-Slug`），缺了不是降级而是
 * 直接 1240400——所以留空时不静默连到某家店去，而是在这里明确提示「没配置」，
 * 对应 `app.json` 的 `extra.tenantSlug` 或 `EXPO_PUBLIC_TENANT_SLUG`。
 */
export default function TenantMissingScreen() {
  return (
    <View style={{ flex: 1, backgroundColor: colors.bgBase, justifyContent: 'center' }}>
      <EmptyState
        title="还没有配置要连接的店铺"
        hint="请在 app.json 的 extra.tenantSlug 或环境变量 EXPO_PUBLIC_TENANT_SLUG 里填写店铺 slug 后重启 App。"
      />
    </View>
  )
}
