import { describe, expect, it } from 'vitest'
import { fromDbNotifyChannel, toDbNotifyChannel } from './channel-map'
import type { NotifyChannelKind } from './types'

describe('toDbNotifyChannel / fromDbNotifyChannel（T1-5 那条真实 bug 的回归用例）', () => {
  it('SMS / APP_PUSH 两边字面量凑巧相同，原样透传', () => {
    expect(toDbNotifyChannel('SMS')).toBe('SMS')
    expect(toDbNotifyChannel('APP_PUSH')).toBe('APP_PUSH')
  })

  it('INBOX 落库必须转成 IN_APP——这正是修复前"一行都落不了库"的那个字面量', () => {
    expect(toDbNotifyChannel('INBOX')).toBe('IN_APP')
  })

  it('MP_TEMPLATE 落库必须转成 WECHAT_MP', () => {
    expect(toDbNotifyChannel('MP_TEMPLATE')).toBe('WECHAT_MP')
  })

  it('四个通道往返一致（toDb 再 fromDb 拿回原值）', () => {
    const kinds: NotifyChannelKind[] = ['SMS', 'INBOX', 'MP_TEMPLATE', 'APP_PUSH']
    for (const kind of kinds) {
      expect(fromDbNotifyChannel(toDbNotifyChannel(kind))).toBe(kind)
    }
  })

  it('fromDbNotifyChannel 认得住四个 DB 字面量', () => {
    expect(fromDbNotifyChannel('SMS')).toBe('SMS')
    expect(fromDbNotifyChannel('IN_APP')).toBe('INBOX')
    expect(fromDbNotifyChannel('WECHAT_MP')).toBe('MP_TEMPLATE')
    expect(fromDbNotifyChannel('APP_PUSH')).toBe('APP_PUSH')
  })

  it('DB 里出现本包还没有驱动的通道（EMAIL/WECHAT_OA）时同步抛错，不悄悄放行', () => {
    expect(() => fromDbNotifyChannel('EMAIL')).toThrow(/没有对应的驱动/)
    expect(() => fromDbNotifyChannel('WECHAT_OA')).toThrow(/没有对应的驱动/)
    expect(() => fromDbNotifyChannel('NOT_A_REAL_CHANNEL')).toThrow(/没有对应的驱动/)
  })
})
