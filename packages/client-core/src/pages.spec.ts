import { beforeEach, describe, expect, it, vi } from 'vitest'

const reLaunch = vi.fn()

vi.mock('@tarojs/taro', () => ({
  default: { reLaunch: (...args: unknown[]) => reLaunch(...args) },
}))

const { CLOSED_PAGE_PATH, TENANT_MISSING_PAGE_PATH, gotoClosedPage, gotoTenantMissingPage } =
  await import('./pages')

describe('打烊页 / 店铺不可用页跳转', () => {
  beforeEach(() => {
    reLaunch.mockReset()
  })

  it('gotoClosedPage 用 reLaunch 清空页面栈跳打烊页', () => {
    gotoClosedPage()
    expect(reLaunch).toHaveBeenCalledWith({ url: CLOSED_PAGE_PATH })
  })

  it('gotoTenantMissingPage 用 reLaunch 清空页面栈跳店铺不可用页', () => {
    gotoTenantMissingPage()
    expect(reLaunch).toHaveBeenCalledWith({ url: TENANT_MISSING_PAGE_PATH })
  })
})
