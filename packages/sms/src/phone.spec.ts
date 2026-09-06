import { describe, expect, it } from 'vitest'
import { assertValidCnPhone, isValidCnPhone, maskPhone } from './phone'

describe('isValidCnPhone', () => {
  it('接受 1[3-9] 开头的 11 位号码', () => {
    expect(isValidCnPhone('13800000000')).toBe(true)
    expect(isValidCnPhone('19900000000')).toBe(true)
  })

  it('拒绝非法号段、位数不对、含非数字', () => {
    expect(isValidCnPhone('12800000000')).toBe(false)
    expect(isValidCnPhone('1380000000')).toBe(false)
    expect(isValidCnPhone('138000000000')).toBe(false)
    expect(isValidCnPhone('1380000000a')).toBe(false)
  })
})

describe('assertValidCnPhone', () => {
  it('合法号码不抛', () => {
    expect(() => assertValidCnPhone('13800000000')).not.toThrow()
  })

  it('非法号码抛错且不泄露完整号码', () => {
    expect(() => assertValidCnPhone('12800000000')).toThrow('128****0000')
  })
})

describe('maskPhone', () => {
  it('保留前三后四，中间四位打星', () => {
    expect(maskPhone('13800001234')).toBe('138****1234')
  })

  it('长度不对时整串打星，不猜测格式', () => {
    expect(maskPhone('123')).toBe('***')
  })
})
