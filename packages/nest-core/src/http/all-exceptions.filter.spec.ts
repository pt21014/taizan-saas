import { ErrorCode } from '@taizan/contracts'
import { describe, expect, it } from 'vitest'
import { transportErrorCode } from './all-exceptions.filter'
import { BizException } from './biz.exception'

describe('transportErrorCode', () => {
  // 域段 10（通用）+ HTTP 语义 3 位 + 序号 00
  it.each([
    [400, 1040000],
    [401, 1040100],
    [403, 1040300],
    [404, 1040400],
    [429, 1042900],
    [500, 1050000],
  ])('HTTP %i → %i', (status, code) => {
    expect(transportErrorCode(status)).toBe(code)
  })

  it('组装出来的码能被 contracts 的 httpSemantic 还原回状态码', async () => {
    const { httpSemantic } = await import('@taizan/contracts')
    for (const status of [401, 403, 404, 429]) {
      expect(httpSemantic(transportErrorCode(status))).toBe(status)
    }
  })
})

describe('BizException', () => {
  it('传 ErrorCodeDef 且不传 message 时用表里的中文默认文案', () => {
    const e = new BizException(ErrorCode.PLAN_READONLY)
    expect(e.code).toBe(1440301)
    expect(e.message).toBe(ErrorCode.PLAN_READONLY.message)
    expect(e.data).toBeNull()
  })

  it('显式 message 覆盖默认文案', () => {
    expect(new BizException(ErrorCode.PLAN_READONLY, '套餐 3 天后到期').message).toBe(
      '套餐 3 天后到期',
    )
  })

  it('裸数字码 + 附加 data', () => {
    const e = new BizException(2040001, '商品已售罄', { goodsId: 'g1' })
    expect(e.code).toBe(2040001)
    expect(e.data).toEqual({ goodsId: 'g1' })
  })

  it('是 Error 的子类，堆栈与 instanceof 都正常', () => {
    const e = BizException.badRequest('参数不对')
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(BizException)
    expect(e.name).toBe('BizException')
    expect(e.code).toBe(ErrorCode.BAD_REQUEST.code)
  })

  it('forbidden 用的是 11 域段的 FORBIDDEN，不是跨租户越权的 12 域段', () => {
    // 这两个码刻意分开：前端对 1340300 只提示，对 1240300 要按越权上报
    expect(BizException.forbidden().code).toBe(ErrorCode.RBAC_FORBIDDEN.code)
    expect(BizException.forbidden().code).not.toBe(ErrorCode.CROSS_TENANT_FORBIDDEN.code)
  })
})
