import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const requestPayment = vi.fn()

vi.mock('@tarojs/taro', () => ({
  default: { requestPayment: (...args: unknown[]) => requestPayment(...args) },
}))

const { pay } = await import('./pay')

const PARAMS = {
  timeStamp: '1',
  nonceStr: 'n',
  package: 'prepay_id=x',
  signType: 'RSA' as const,
  paySign: 'sig',
}

describe('pay：process.env.TARO_ENV 条件编译', () => {
  const originalEnv = process.env.TARO_ENV
  const originalWindow = globalThis.window

  beforeEach(() => {
    requestPayment.mockReset()
  })

  afterEach(() => {
    process.env.TARO_ENV = originalEnv
    if (originalWindow === undefined) {
      // @ts-expect-error 测试环境清理
      delete globalThis.window
    } else {
      globalThis.window = originalWindow
    }
  })

  it('weapp：走 Taro.requestPayment，成功时 ok=true', async () => {
    process.env.TARO_ENV = 'weapp'
    requestPayment.mockResolvedValue({ errMsg: 'requestPayment:ok' })

    const result = await pay(PARAMS)

    expect(requestPayment).toHaveBeenCalledWith(PARAMS)
    expect(result).toEqual({ ok: true })
  })

  it('weapp：requestPayment 被拒绝（用户取消）时 ok=false/reason=cancel', async () => {
    process.env.TARO_ENV = 'weapp'
    requestPayment.mockRejectedValue(new Error('requestPayment:fail cancel'))

    const result = await pay(PARAMS)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('cancel')
  })

  it('h5：没有 WeixinJSBridge 时降级为 unsupported，且不调用小程序 API', async () => {
    process.env.TARO_ENV = 'h5'
    // @ts-expect-error 测试用最小 window mock（无 WeixinJSBridge）
    globalThis.window = {}

    const result = await pay(PARAMS)

    expect(requestPayment).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unsupported')
  })

  it('h5：微信内置浏览器有 WeixinJSBridge 时走 JSAPI 支付', async () => {
    process.env.TARO_ENV = 'h5'
    const invoke = vi.fn((_api: string, _params: unknown, cb: (res: { err_msg: string }) => void) =>
      cb({ err_msg: 'get_brand_wcpay_request:ok' }),
    )
    // @ts-expect-error 测试用最小 window mock
    globalThis.window = { WeixinJSBridge: { invoke } }

    const result = await pay(PARAMS)

    expect(invoke).toHaveBeenCalledWith(
      'getBrandWCPayRequest',
      expect.any(Object),
      expect.any(Function),
    )
    expect(result).toEqual({ ok: true })
  })
})
