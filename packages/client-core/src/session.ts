/**
 * 蓝图 §5.3：member 登录态。token 存 `Taro.setStorage`（同步接口，跨端一致），
 * 提供一个登录态 hook（`useMemberSession`）给页面订阅，`loginDev(phone)`（联调用，
 * 对应后端 `POST /api/client/auth/login-dev`，非生产开关见后端 `CLIENT_DEV_LOGIN`）
 * 与 `loginWechat()`（`Taro.login()` → 后端换 token）。
 *
 * `loginWechat` 对应的后端接口（`POST /api/client/auth/login-wechat`）在写这份代码时
 * 尚未实现（T2-4 微信开放能力 / C 端微信登录属于后续任务），这里先把请求形状定死：
 * 传 `{ code }`，期望拿回 `LoginResult`。TODO(T3-6 之后)：后端接口就绪后如无形状变化
 * 不需要改这个文件。
 *
 * @packageDocumentation
 */

import type { EnvelopeClient } from '@taizan/contracts'
import Taro from '@tarojs/taro'
import { useEffect, useState } from 'react'

const TOKEN_STORAGE_KEY = 'taizan_member_token'

/** 登录/换取 token 接口的通用返回形状。 */
export interface LoginResult {
  access: string
  refresh?: string
  expiresIn?: number
  member?: { id: string; phone: string | null; nickname: string | null }
  tenantId?: string
}

type Listener = (token: string | null) => void
const listeners = new Set<Listener>()

function notify(token: string | null): void {
  for (const listener of listeners) listener(token)
}

/** 读取当前 member token；未登录返回 `null`。 */
export function getMemberToken(): string | null {
  try {
    const value = Taro.getStorageSync(TOKEN_STORAGE_KEY) as string | undefined
    return value || null
  } catch {
    return null
  }
}

/** 持久化 member token 并广播给所有 `useMemberSession()` 订阅者。 */
export function setMemberToken(token: string): void {
  Taro.setStorageSync(TOKEN_STORAGE_KEY, token)
  notify(token)
}

/** 清空 member token（退出登录 / 收到 401）。 */
export function clearMemberToken(): void {
  Taro.removeStorageSync(TOKEN_STORAGE_KEY)
  notify(null)
}

/** 登录态 React hook：返回当前 token，storage 变化（本模块内触发的）会驱动重渲染。 */
export function useMemberSession(): { token: string | null; isLoggedIn: boolean } {
  const [token, setToken] = useState<string | null>(() => getMemberToken())

  useEffect(() => {
    const listener: Listener = (next) => setToken(next)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  return { token, isLoggedIn: token != null }
}

/** {@link createSession} 返回的会话操作集合。 */
export interface Session {
  getToken(): string | null
  isLoggedIn(): boolean
  /** 【联调用】手机号一键登录，对应后端 `POST /api/client/auth/login-dev` */
  loginDev(phone: string): Promise<LoginResult>
  /** 微信一键登录：`Taro.login()` 换 code → 后端换 token（后端接口未就绪，见文件头 TODO） */
  loginWechat(): Promise<LoginResult>
  logout(): void
}

/** 基于一个 {@link EnvelopeClient} 组装会话操作（登录写 token，登出清 token）。 */
export function createSession(request: EnvelopeClient): Session {
  return {
    getToken: getMemberToken,
    isLoggedIn: () => getMemberToken() != null,

    async loginDev(phone: string): Promise<LoginResult> {
      const result = await request.post<LoginResult>('/api/client/auth/login-dev', { phone })
      setMemberToken(result.access)
      return result
    },

    async loginWechat(): Promise<LoginResult> {
      const { code } = await Taro.login()
      if (!code) {
        throw new Error('Taro.login() 未返回 code，无法完成微信登录')
      }
      // TODO(T3-6 之后)：后端 /api/client/auth/login-wechat 尚未实现，接口就绪前此调用会 404。
      const result = await request.post<LoginResult>('/api/client/auth/login-wechat', { code })
      setMemberToken(result.access)
      return result
    },

    logout(): void {
      clearMemberToken()
    },
  }
}
