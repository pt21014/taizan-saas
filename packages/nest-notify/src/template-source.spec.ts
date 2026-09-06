import { createFakePrisma } from '@taizan/nest-prisma/testing'
import { describe, expect, it } from 'vitest'
import { InMemoryTemplateSource, PrismaTemplateSource } from './template-source'

describe('InMemoryTemplateSource', () => {
  it('按 key 取模板', async () => {
    const source = new InMemoryTemplateSource({
      'sms.login-code': {
        title: '登录验证码',
        content: '您的验证码是 {{code}}',
        channel: 'SMS',
        enabled: true,
      },
    })
    const def = await source.get('sms.login-code')
    expect(def?.content).toBe('您的验证码是 {{code}}')
  })

  it('未登记的 key 返回 null', async () => {
    const source = new InMemoryTemplateSource({})
    expect(await source.get('unknown')).toBeNull()
  })
})

describe('PrismaTemplateSource', () => {
  it('走 raw 句柄查 NotifyTemplate 表', async () => {
    const fake = createFakePrisma()
    fake.controls.on('NotifyTemplate', 'findUnique', {
      title: '套餐到期提醒',
      content: '您的套餐将于 {{date}} 到期',
      channel: 'SMS',
      providerTemplateId: 'T123',
      enabled: true,
    })

    const source = new PrismaTemplateSource(fake.client)
    const def = await source.get('tenant.plan.expiring')
    expect(def?.title).toBe('套餐到期提醒')
    expect(def?.providerTemplateId).toBe('T123')

    const calls = fake.controls.callsOf('NotifyTemplate', 'findUnique')
    expect(calls).toHaveLength(1)
    expect((calls[0]?.args as { where: { key: string } }).where.key).toBe('tenant.plan.expiring')
  })

  it('查不到时返回 null', async () => {
    const fake = createFakePrisma()
    fake.controls.on('NotifyTemplate', 'findUnique', null)
    const source = new PrismaTemplateSource(fake.client)
    expect(await source.get('unknown')).toBeNull()
  })

  // 读路径同样要转换：DB 存的是 `IN_APP`/`WECHAT_MP` 这两个枚举字面量，
  // 直接原样传给 NotifyService 的话，`byKind.get('IN_APP')` 会找不到驱动
  // （驱动是按本包的 NotifyChannelKind 登记的），见 `channel-map.ts`。
  it('DB 的 IN_APP 读出来要转成本包的 INBOX', async () => {
    const fake = createFakePrisma()
    fake.controls.on('NotifyTemplate', 'findUnique', {
      title: '套餐已开通',
      content: '您的套餐已开通',
      channel: 'IN_APP',
      providerTemplateId: null,
      enabled: true,
    })

    const source = new PrismaTemplateSource(fake.client)
    const def = await source.get('plan.fulfilled')
    expect(def?.channel).toBe('INBOX')
  })

  it('DB 的 WECHAT_MP 读出来要转成本包的 MP_TEMPLATE', async () => {
    const fake = createFakePrisma()
    fake.controls.on('NotifyTemplate', 'findUnique', {
      title: '订阅消息',
      content: '内容',
      channel: 'WECHAT_MP',
      providerTemplateId: null,
      enabled: true,
    })

    const source = new PrismaTemplateSource(fake.client)
    const def = await source.get('some.mp.template')
    expect(def?.channel).toBe('MP_TEMPLATE')
  })
})
