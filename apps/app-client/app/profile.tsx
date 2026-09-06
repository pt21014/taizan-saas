import { Button, Card, checkUpdate, colors, spacing, textVariants, toast } from '@taizan/app-ui'
import { router } from 'expo-router'
import { useState } from 'react'
import { Text, View } from 'react-native'

import { sessionStore } from '../src/session'

/** 个人页：登录态展示、登出、OTA 更新检查（蓝图 §5.4）。 */
export default function ProfileScreen() {
  const session = sessionStore.useSession()
  const [checking, setChecking] = useState(false)

  async function logout() {
    await sessionStore.clear()
    router.replace('/')
  }

  async function checkForUpdate() {
    setChecking(true)
    try {
      const result = await checkUpdate()
      if (!result.checked) {
        toast.show('当前环境不支持热更新检查（Expo Go / 未接 EAS Update）')
      } else if (result.isAvailable) {
        toast.show('已下载新版本，重启后生效')
      } else {
        toast.show('已是最新版本')
      }
    } finally {
      setChecking(false)
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bgBase, padding: spacing.lg }}>
      <Card padded style={{ marginBottom: spacing.lg }}>
        <Text style={{ fontSize: textVariants.body.fontSize }}>
          {session.data?.nickname ?? '未登录'}
        </Text>
        <Text
          style={{
            fontSize: textVariants.sub.fontSize,
            color: colors.gray[500] ?? '#999',
            marginTop: spacing.xs,
          }}
        >
          会员号 {session.data?.memberId ?? '-'}
        </Text>
      </Card>

      <Button
        kind="plain"
        title={checking ? '检查中…' : '检查更新'}
        loading={checking}
        onPress={() => void checkForUpdate()}
        style={{ marginBottom: spacing.md }}
      />
      <Button kind="ghost" danger title="退出登录" onPress={() => void logout()} />
    </View>
  )
}
