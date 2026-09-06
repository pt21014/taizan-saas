import { describe, expect, it } from 'vitest'
import { AUDIT_ACTIONS, defineAuditActions } from './actions'

describe('defineAuditActions', () => {
  // 用例⑧
  it('合法的 module.action 格式全部通过并被冻结', () => {
    const actions = defineAuditActions({
      GOODS_CREATE: 'goods.create',
      GOODS_SET_COMBO: 'goods.set-combo',
    })
    expect(actions.GOODS_CREATE).toBe('goods.create')
    expect(Object.isFrozen(actions)).toBe(true)
    expect(() => {
      ;(actions as { GOODS_CREATE: string }).GOODS_CREATE = 'x'
    }).toThrow()
  })

  it('模块段/动作段允许连字符分隔的多个单词', () => {
    expect(() =>
      defineAuditActions({ A: 'plan-order.mark-paid', B: 'platform-admin.change-password' }),
    ).not.toThrow()
  })

  it('缺少点号时抛错', () => {
    expect(() => defineAuditActions({ BAD: 'goodscreate' })).toThrow(/module\.action/)
  })

  it('含大写字母时抛错', () => {
    expect(() => defineAuditActions({ BAD: 'Goods.Create' })).toThrow(/module\.action/)
  })

  it('含下划线时抛错', () => {
    expect(() => defineAuditActions({ BAD: 'goods_sku.update' })).toThrow(/module\.action/)
  })

  it('含多个点时抛错', () => {
    expect(() => defineAuditActions({ BAD: 'goods.sku.update' })).toThrow(/module\.action/)
  })

  it('段首/段尾是连字符时抛错', () => {
    expect(() => defineAuditActions({ BAD: '-goods.create' })).toThrow(/module\.action/)
    expect(() => defineAuditActions({ BAD: 'goods.create-' })).toThrow(/module\.action/)
  })

  it('错误信息带上是哪个 key 出的问题，方便定位', () => {
    expect(() => defineAuditActions({ MY_BAD_ACTION: 'Nope' })).toThrow(/MY_BAD_ACTION/)
  })

  it('框架内置 AUDIT_ACTIONS 本身全部满足格式（构造时不抛就是通过）', () => {
    expect(Object.isFrozen(AUDIT_ACTIONS)).toBe(true)
    expect(AUDIT_ACTIONS.TENANT_CREATE).toBe('tenant.create')
    expect(AUDIT_ACTIONS.STAFF_ROLE_CHANGE).toBe('staff.role-change')
    expect(AUDIT_ACTIONS.PLAN_ORDER_MARK_PAID).toBe('plan-order.mark-paid')
    expect(AUDIT_ACTIONS.PLATFORM_ADMIN_LOGIN).toBe('platform-admin.login')
    expect(AUDIT_ACTIONS.CREDENTIAL_UPDATE).toBe('credential.update')
    expect(AUDIT_ACTIONS.ANNOUNCEMENT_PUBLISH).toBe('announcement.publish')
  })
})
