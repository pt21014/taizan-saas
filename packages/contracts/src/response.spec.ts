import { describe, expect, it } from 'vitest'

import { fail, isOk, ok, SUCCESS_CODE } from './response'

describe('SUCCESS_CODE', () => {
  it('恒为 0', () => {
    expect(SUCCESS_CODE).toBe(0)
  })
})

describe('ok', () => {
  it('返回 code=0 且透传 data', () => {
    expect(ok({ id: '1' })).toEqual({ code: 0, message: 'OK', data: { id: '1' } })
  })

  it('支持自定义 message', () => {
    expect(ok(null, '创建成功')).toEqual({ code: 0, message: '创建成功', data: null })
  })
})

describe('fail', () => {
  it('返回给定 code/message，data 固定为 null', () => {
    expect(fail(1140100, '未登录')).toEqual({ code: 1140100, message: '未登录', data: null })
  })

  it('code=0 时抛出', () => {
    expect(() => fail(0, '不应该')).toThrow()
  })
})

describe('isOk', () => {
  it('code=0 时为 true', () => {
    expect(isOk(ok(1))).toBe(true)
  })

  it('code!=0 时为 false', () => {
    expect(isOk(fail(1140100, '未登录'))).toBe(false)
  })
})
