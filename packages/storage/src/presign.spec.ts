import { describe, expect, it } from 'vitest'
import { assertValidExpireSeconds, MAX_EXPIRE_SECONDS, MIN_EXPIRE_SECONDS } from './presign'

describe('assertValidExpireSeconds 边界', () => {
  it('下限本身合法', () => {
    expect(() => assertValidExpireSeconds(MIN_EXPIRE_SECONDS)).not.toThrow()
  })

  it('比下限小 1 秒即抛错', () => {
    expect(() => assertValidExpireSeconds(MIN_EXPIRE_SECONDS - 1)).toThrow('太短')
  })

  it('上限本身合法', () => {
    expect(() => assertValidExpireSeconds(MAX_EXPIRE_SECONDS)).not.toThrow()
  })

  it('比上限大 1 秒即抛错', () => {
    expect(() => assertValidExpireSeconds(MAX_EXPIRE_SECONDS + 1)).toThrow('太长')
  })

  it('非正数或非整数抛错', () => {
    expect(() => assertValidExpireSeconds(0)).toThrow()
    expect(() => assertValidExpireSeconds(-1)).toThrow()
    expect(() => assertValidExpireSeconds(1.5)).toThrow()
  })
})
