import { View } from '@tarojs/components'

import './index.scss'

/**
 * 打烊页（`1440302` `ErrorCode.SHOP_CLOSED`）：套餐到期，服务端把 C 端所有业务接口
 * 挡在了闸门后面。整页只显示这一句话，**不提供任何重试按钮**——重试只会拿到同一个
 * 错误，商家续费之后用户下一次自然进店就会恢复，不需要用户自己判断「是不是好了」。
 */
export default function Closed() {
  return (
    <View className="status-page">
      <View className="status-page__title">店铺已打烊</View>
      <View className="status-page__desc">商家正在休息，请稍后再来看看</View>
    </View>
  )
}
