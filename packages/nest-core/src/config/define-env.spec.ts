import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { checkJwtSecretsDistinct, defineEnvSchema, EnvValidationError, loadEnv } from './define-env'
import { BASE_ENV_SCHEMA } from './env.schema'

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)

/** 一份合法的最小 env，测试里按需删字段/改字段。 */
function validEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/taizan',
    REDIS_URL: 'redis://127.0.0.1:6379/0',
    JWT_SECRET_PLATFORM: 'p'.repeat(40),
    JWT_SECRET_STAFF: 's'.repeat(40),
    JWT_SECRET_MEMBER: 'm'.repeat(40),
    CRYPTO_KEYS: JSON.stringify({ k1: KEY_A, k2: KEY_B }),
    CRYPTO_KEY_CURRENT: 'k2',
  }
}

describe('loadEnv', () => {
  it('合法 env 能解析出默认值与转换后的类型', () => {
    const env = loadEnv(BASE_ENV_SCHEMA, {
      ...validEnv(),
      CORS_ORIGINS: 'https://a.example.com, https://*.b.example.com',
      BILLING_ENFORCE: '1',
      API_PORT: '4000',
    })
    expect(env.API_PORT).toBe(4000)
    expect(env.LOG_LEVEL).toBe('info')
    expect(env.TRUSTED_PROXY_HOPS).toBe(1)
    expect(env.BILLING_ENFORCE).toBe(true)
    expect(env.SMS_RETURN_DEV_CODE).toBe(false)
    expect(env.CORS_ORIGINS).toEqual(['https://a.example.com', 'https://*.b.example.com'])
    expect(env.CRYPTO_KEYS.k1).toBe(KEY_A)
  })

  // 用例①：缺 JWT_SECRET_STAFF 时抛错，且报错文本含字段名与中文
  it('缺 JWT_SECRET_STAFF 时抛错，报错文本含字段名且是中文', () => {
    const source = validEnv()
    delete source.JWT_SECRET_STAFF

    let caught: unknown
    try {
      loadEnv(BASE_ENV_SCHEMA, source)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(EnvValidationError)
    const err = caught as EnvValidationError
    expect(err.fields).toHaveLength(1)
    expect(err.fields[0]).toContain('JWT_SECRET_STAFF')
    expect(err.message).toContain('环境变量校验失败')
    expect(err.message).toContain('JWT_SECRET_STAFF')
    expect(err.message).toContain('缺少必填项')
    // 不能是 zod 的英文默认文案
    expect(err.message).not.toContain('Required')
    expect(err.message).not.toMatch(/Invalid|expected/i)
  })

  it('一次性列出所有问题，而不是修一个报一个', () => {
    const source = validEnv()
    delete source.JWT_SECRET_STAFF
    delete source.DATABASE_URL
    source.JWT_SECRET_MEMBER = 'too-short'

    const err = grabEnvError(() => loadEnv(BASE_ENV_SCHEMA, source))
    expect(err.fields).toHaveLength(3)
    expect(err.fields.join('\n')).toContain('DATABASE_URL')
    expect(err.fields.join('\n')).toContain('至少 32 位')
  })

  it('CRYPTO_KEYS 不是 64 hex 时报中文错', () => {
    const err = grabEnvError(() =>
      loadEnv(BASE_ENV_SCHEMA, { ...validEnv(), CRYPTO_KEYS: JSON.stringify({ k1: 'short' }) }),
    )
    expect(err.fields[0]).toContain('CRYPTO_KEYS.k1')
    expect(err.fields[0]).toContain('64 位 hex')
  })

  it('CRYPTO_KEY_CURRENT 指向不存在的 keyId 时拒启（跨字段校验）', () => {
    const err = grabEnvError(() =>
      loadEnv(BASE_ENV_SCHEMA, { ...validEnv(), CRYPTO_KEY_CURRENT: 'k9' }),
    )
    expect(err.fields[0]).toContain('CRYPTO_KEY_CURRENT')
    expect(err.fields[0]).toContain('k1, k2')
  })

  it('三套 JWT 密钥共用一把时拒启', () => {
    const same = 'x'.repeat(40)
    const err = grabEnvError(() =>
      loadEnv(BASE_ENV_SCHEMA, {
        ...validEnv(),
        JWT_SECRET_STAFF: same,
        JWT_SECRET_MEMBER: same,
      }),
    )
    expect(err.fields[0]).toContain('必须互相独立')
  })

  it('布尔开关拼错时报错而不是静默当作 false', () => {
    const err = grabEnvError(() =>
      loadEnv(BASE_ENV_SCHEMA, { ...validEnv(), BILLING_ENFORCE: 'ture' }),
    )
    expect(err.fields[0]).toContain('BILLING_ENFORCE')
  })

  it('crossChecks 可以关掉', () => {
    const env = loadEnv(
      BASE_ENV_SCHEMA,
      { ...validEnv(), CRYPTO_KEY_CURRENT: 'k9' },
      {
        crossChecks: [],
      },
    )
    expect(env.CRYPTO_KEY_CURRENT).toBe('k9')
  })
})

describe('checkJwtSecretsDistinct', () => {
  it('字段缺失时不误报', () => {
    expect(checkJwtSecretsDistinct({})).toEqual([])
  })
})

describe('defineEnvSchema', () => {
  it('合并扩展字段后基础字段与扩展字段都生效', () => {
    const schema = defineEnvSchema(BASE_ENV_SCHEMA, {
      WECHAT_APPID: z.string().min(1).describe('公众号 appid'),
    })
    const env = loadEnv(schema, { ...validEnv(), WECHAT_APPID: 'wx123' })
    expect(env.WECHAT_APPID).toBe('wx123')
    expect(env.NODE_ENV).toBe('test')

    const err = grabEnvError(() => loadEnv(schema, validEnv()))
    expect(err.fields[0]).toContain('WECHAT_APPID')
    // 扩展字段没写 message 也应该拿到中文兜底
    expect(err.fields[0]).toContain('缺少必填项')
  })
})

function grabEnvError(fn: () => unknown): EnvValidationError {
  try {
    fn()
  } catch (error) {
    if (error instanceof EnvValidationError) {
      return error
    }
    throw error
  }
  throw new Error('期望抛出 EnvValidationError，但没有抛')
}
