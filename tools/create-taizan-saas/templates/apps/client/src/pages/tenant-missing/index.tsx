import { View } from '@tarojs/components'

import './status-page.scss'

/**
 * 店铺不可用页（`1240400` `ErrorCode.TENANT_NOT_FOUND`）：tenantSlug 三种来源
 * （H5 路径/子域名，小程序启动参数）都解析不出来，或者解析出来的店铺确实不存在。
 * 这与「打烊」（`closed`）是两个不同的错误页——一个是「这家店从来没开过/链接错了」，
 * 一个是「这家店本来在，暂时没交钱」，文案与用户该做的事完全不同。
 */
export default function TenantMissing() {
  return (
    <View className="status-page">
      <View className="status-page__title">店铺不可用</View>
      <View className="status-page__desc">请通过正确的店铺链接或二维码进入</View>
    </View>
  )
}
