import { describe, expect, it } from 'vitest'
import { isSwaggerEnabledByEnv } from './setup'

describe('isSwaggerEnabledByEnv', () => {
  // 生产默认关：Swagger 会把全部路由、DTO 字段、校验规则完整暴露出去，
  // 那是一份免费的攻击面清单
  it('production 默认关', () => {
    expect(isSwaggerEnabledByEnv({ NODE_ENV: 'production' })).toBe(false)
  })

  it('production 下显式 SWAGGER_ENABLED=true 才开', () => {
    expect(isSwaggerEnabledByEnv({ NODE_ENV: 'production', SWAGGER_ENABLED: true })).toBe(true)
  })

  it('development / test 默认开', () => {
    expect(isSwaggerEnabledByEnv({ NODE_ENV: 'development' })).toBe(true)
    expect(isSwaggerEnabledByEnv({ NODE_ENV: 'test' })).toBe(true)
    expect(isSwaggerEnabledByEnv({})).toBe(true)
  })
})
