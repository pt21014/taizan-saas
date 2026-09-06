import { EmptyState, colors } from '@taizan/app-ui'
import { useLocalSearchParams } from 'expo-router'
import { View } from 'react-native'

/** 打烊页（错误码 `1440302`）：套餐到期后 C 端整店不可用，这是唯一从「无权限」里单独摘出来的码。 */
export default function ClosedScreen() {
  const { reason } = useLocalSearchParams<{ reason?: string }>()
  return (
    <View style={{ flex: 1, backgroundColor: colors.bgBase, justifyContent: 'center' }}>
      <EmptyState title="店铺已打烊" hint={reason || '这家店暂时无法访问，请稍后再来看看。'} />
    </View>
  )
}
