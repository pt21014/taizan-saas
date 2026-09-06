import { describe, expect, it } from 'vitest'
import { createAppPushChannel } from './app-push.channel'
import { createMpTemplateChannel } from './mp-template.channel'
import { createNoopChannel } from './noop.channel'
import type { NotifyMessage } from '../types'

const message: NotifyMessage = {
  templateKey: 'k',
  title: 't',
  content: 'c',
  vars: {},
  to: { openId: 'o1', deviceToken: 'd1' },
}

describe('createNoopChannel', () => {
  it('总是失败，error 说明是没接驱动，不是网络失败', async () => {
    const channel = createNoopChannel('MP_TEMPLATE')
    const result = await channel.send(message)
    expect(result.ok).toBe(false)
    expect(result.channel).toBe('MP_TEMPLATE')
    expect(result.error).toContain('还没有接入真实驱动')
  })
})

describe('createMpTemplateChannel / createAppPushChannel', () => {
  it('kind 各自对应正确，都是 NoopChannel', async () => {
    expect((await createMpTemplateChannel().send(message)).channel).toBe('MP_TEMPLATE')
    expect((await createAppPushChannel().send(message)).channel).toBe('APP_PUSH')
    expect(createMpTemplateChannel().kind).toBe('MP_TEMPLATE')
    expect(createAppPushChannel().kind).toBe('APP_PUSH')
  })
})
