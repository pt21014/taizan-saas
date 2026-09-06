import { describe, expect, it } from 'vitest'
import { createInboxChannel } from './inbox.channel'
import type { NotifyMessage } from '../types'

const message: NotifyMessage = {
  templateKey: 'tenant.plan.expiring',
  title: '套餐到期提醒',
  content: '您的套餐即将到期',
  vars: {},
  to: { userId: 'staff-1' },
}

describe('createInboxChannel', () => {
  it('有接收用户时总是成功——真正的落库发生在 NotifyService 那次共用写入里', async () => {
    const channel = createInboxChannel()
    const result = await channel.send(message)
    expect(result.ok).toBe(true)
    expect(result.channel).toBe('INBOX')
  })

  it('缺接收用户时失败', async () => {
    const channel = createInboxChannel()
    const result = await channel.send({ ...message, to: {} })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('缺少接收用户')
  })
})
