import { Button, Input, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useState } from 'react'

import { session } from '../../services/client'

import './index.scss'

/**
 * 登录页：手机号 dev 登录（联调用，对应后端 `POST /api/client/auth/login-dev`，
 * 需要后端 `CLIENT_DEV_LOGIN=1` 且非生产才会真的签发 token）+ 微信一键登录按钮位
 * （`session.loginWechat()`，对应后端 `POST /api/client/auth/login-wechat`——
 * 该接口尚未实现，按钮点击会失败并提示，见 `@taizan/client-core/session.ts` 头部 TODO）。
 *
 * 微信一键登录按钮**只在小程序端展示**：H5 没有 `Taro.login()` 的等价能力
 * （`loginWithPlatform()` 在 H5 下恒返回 `supported: false`，见
 * `@taizan/client-core/adapters/login.ts`）。
 */
export default function Login() {
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submitDevLogin() {
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      setError('请输入正确的手机号')
      return
    }
    setBusy(true)
    setError('')
    try {
      await session.loginDev(phone)
      Taro.showToast({ title: '已登录', icon: 'none' })
      void Taro.navigateBack().catch(() => Taro.reLaunch({ url: '/pages/index/index' }))
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  async function submitWechatLogin() {
    setBusy(true)
    setError('')
    try {
      await session.loginWechat()
      Taro.showToast({ title: '已登录', icon: 'none' })
      void Taro.navigateBack().catch(() => Taro.reLaunch({ url: '/pages/index/index' }))
    } catch (e) {
      setError(e instanceof Error ? e.message : '微信登录暂不可用（后端接口未就绪）')
    } finally {
      setBusy(false)
    }
  }

  return (
    <View className="login">
      <View className="login__title">登录</View>

      <View className="login__field">
        <Input
          className="login__input"
          type="number"
          maxlength={11}
          value={phone}
          placeholder="手机号（联调用，仅非生产环境可用）"
          onInput={(e) => setPhone(e.detail.value)}
        />
      </View>

      {error && <View className="login__error">{error}</View>}

      <Button type="primary" loading={busy} onClick={submitDevLogin}>
        手机号登录
      </Button>

      {process.env.TARO_ENV === 'weapp' && (
        <>
          <View className="login__divider">或</View>
          <Button loading={busy} onClick={submitWechatLogin}>
            微信一键登录
          </Button>
        </>
      )}
    </View>
  )
}
