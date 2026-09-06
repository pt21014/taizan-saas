import { Button, Card, colors, spacing, textVariants, toast } from '@taizan/app-ui'
import { Redirect } from 'expo-router'
import { useState } from 'react'
import { Text, TextInput, View } from 'react-native'

import { api, DEFAULT_TENANT_SLUG } from '../src/api'
import { sessionStore } from '../src/session'
import type { ClientLoginResult } from '../src/types'

/**
 * 入口/登录页。**联调用的 dev 登录**（对应后端 `login-dev`，需要
 * `CLIENT_DEV_LOGIN=1`，生产环境会拒启）——真实短信/微信登录是后续任务，
 * 这里先把「拿到 token → 存 SecureStore → 进商品列表」这条骨架跑通。
 */
export default function EntryScreen() {
  const session = sessionStore.useSession()
  const [phone, setPhone] = useState('')
  const [loading, setLoading] = useState(false)

  if (!DEFAULT_TENANT_SLUG) {
    return <Redirect href="/tenant-missing" />
  }
  if (session.token) {
    return <Redirect href="/goods" />
  }

  async function login() {
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      toast.show('请输入正确的手机号', 'error')
      return
    }
    setLoading(true)
    try {
      const result = await api.post<ClientLoginResult>('/client/auth/login-dev', { phone })
      await sessionStore.save(result.access, {
        memberId: result.member.id,
        nickname: result.member.nickname,
        tenantId: result.tenantId,
      })
    } catch {
      // createApiClient 已经把提示 toast 出来了，这里不用重复处理。
    } finally {
      setLoading(false)
    }
  }

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.bgBase,
        padding: spacing.xl,
        justifyContent: 'center',
      }}
    >
      <Text
        style={{
          fontSize: textVariants.title.fontSize,
          fontWeight: '700',
          marginBottom: spacing.xl,
        }}
      >
        登录
      </Text>
      <Card padded>
        <Text
          style={{
            fontSize: textVariants.sub.fontSize,
            color: colors.gray[500] ?? '#999',
            marginBottom: spacing.sm,
          }}
        >
          手机号
        </Text>
        <TextInput
          value={phone}
          onChangeText={setPhone}
          placeholder="请输入手机号"
          keyboardType="phone-pad"
          maxLength={11}
          style={{
            borderWidth: 1,
            borderColor: colors.gray[300] ?? '#ccc',
            borderRadius: 8,
            paddingHorizontal: spacing.md,
            paddingVertical: 10,
            fontSize: textVariants.body.fontSize,
          }}
        />
        <Button
          title="登录"
          onPress={() => void login()}
          loading={loading}
          style={{ marginTop: spacing.lg }}
        />
      </Card>
    </View>
  )
}
