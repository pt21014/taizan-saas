import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineEnvSchema } from './define-env'
import { generateEnvExample } from './env-example'
import { BASE_ENV_SCHEMA, BASE_ENV_SHAPE } from './env.schema'

describe('generateEnvExample', () => {
  const text = generateEnvExample(BASE_ENV_SCHEMA)

  // 用例⑪：输出包含全部字段——手写 .env.example 必漏字段，这条就是防漏的哨兵
  it('输出包含 schema 里的全部字段，一个不少', () => {
    const keys = Object.keys(BASE_ENV_SHAPE)
    expect(keys.length).toBeGreaterThan(15)
    for (const key of keys) {
      expect(text, `缺少字段 ${key}`).toMatch(new RegExp(`^${key}=`, 'm'))
    }
  })

  it('每个字段都带上 .describe() 的中文说明', () => {
    for (const [key, field] of Object.entries(BASE_ENV_SHAPE)) {
      const description = (field as z.ZodTypeAny).description
      expect(description, `${key} 没写 .describe()`).toBeTruthy()
      expect(text).toContain(`# ${description}`)
    }
  })

  it('有默认值的字段把默认值写进示例，必填字段留空', () => {
    expect(text).toMatch(/^NODE_ENV=development$/m)
    expect(text).toMatch(/^API_PORT=3000$/m)
    expect(text).toMatch(/^LOG_LEVEL=info$/m)
    expect(text).toMatch(/^BILLING_ENFORCE=false$/m)
    // 必填项留空，让人一眼看出必须自己填
    expect(text).toMatch(/^DATABASE_URL=$/m)
    expect(text).toMatch(/^JWT_SECRET_STAFF=$/m)
  })

  it('标注必填/可选与类型提示', () => {
    expect(text).toContain('# [必填]')
    expect(text).toContain('# [可选] [development | test | production]')
    expect(text).toContain('boolean（1/0、true/false）')
  })

  it('业务扩展字段也会被生成出来', () => {
    const schema = defineEnvSchema(BASE_ENV_SCHEMA, {
      WECHAT_APPID: z.string().describe('公众号 appid'),
      SIGNUP_TRIAL_DAYS: z.coerce.number().default(30).describe('自助注册试用天数'),
    })
    const out = generateEnvExample(schema)
    expect(out).toMatch(/^WECHAT_APPID=$/m)
    expect(out).toMatch(/^SIGNUP_TRIAL_DAYS=30$/m)
    expect(out).toContain('# 公众号 appid')
  })

  it('leaveRequiredBlank=false 时必填项写占位符', () => {
    const out = generateEnvExample(BASE_ENV_SCHEMA, { leaveRequiredBlank: false })
    expect(out).toMatch(/^DATABASE_URL=<必填>$/m)
  })
})
