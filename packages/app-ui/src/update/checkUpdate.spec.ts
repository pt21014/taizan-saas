import { describe, expect, it } from 'vitest'

import { checkUpdate, shouldReloadNow } from './checkUpdate'

describe('checkUpdate：expo-updates 是可选 peer', () => {
  it('未安装 expo-updates 时静默返回 checked=false，而不是抛异常', async () => {
    // app-ui 本身不依赖 expo-updates 运行时，这里就是在验证「没装」这条真实分支。
    const result = await checkUpdate()
    expect(result.checked).toBe(false)
    expect(result.isAvailable).toBe(false)
    expect(result.error).toBeTruthy()
  })
})

describe('shouldReloadNow：纯逻辑，和 expo-updates 运行时解耦', () => {
  it('没有可用更新时永远不重启', () => {
    expect(shouldReloadNow({ checked: true, isAvailable: false }, 'background')).toBe(false)
  })

  it('有可用更新且 App 在前台使用中：不打断用户，先不重启', () => {
    expect(shouldReloadNow({ checked: true, isAvailable: true }, 'active')).toBe(false)
  })

  it('有可用更新且 App 退到后台/未激活：可以直接重启', () => {
    expect(shouldReloadNow({ checked: true, isAvailable: true }, 'background')).toBe(true)
    expect(shouldReloadNow({ checked: true, isAvailable: true }, 'inactive')).toBe(true)
  })
})
