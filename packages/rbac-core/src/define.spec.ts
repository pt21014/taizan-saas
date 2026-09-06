import { describe, expect, it } from 'vitest'
import { ASSIGNABLE_ROLE_RULE, canAssignRole, defineRolePreset } from './define'

const ALL_CODES = [
  'goods:list',
  'goods:write',
  'goods:export',
  'order:list',
  'order:refund',
] as const

describe('defineRolePreset', () => {
  it('返回冻结对象，权限点去重并按字典序排序', () => {
    const preset = defineRolePreset(
      {
        code: 'cashier',
        name: '收银员',
        side: 'ADMIN',
        permissionCodes: ['order:list', 'goods:list', 'order:list'],
      },
      ALL_CODES,
    )
    expect(preset.permissionCodes).toEqual(['goods:list', 'order:list'])
    expect(Object.isFrozen(preset)).toBe(true)
    expect(Object.isFrozen(preset.permissionCodes)).toBe(true)
  })

  it('展开模块通配', () => {
    const preset = defineRolePreset(
      { code: 'goods-admin', name: '商品管理员', side: 'ADMIN', permissionCodes: ['goods:*'] },
      ALL_CODES,
    )
    expect(preset.permissionCodes).toEqual(['goods:export', 'goods:list', 'goods:write'])
  })

  it('展开全局通配', () => {
    const preset = defineRolePreset(
      { code: 'super', name: '超级管理员', side: 'PLATFORM', permissionCodes: ['*'] },
      ALL_CODES,
    )
    expect(preset.permissionCodes.length).toBe(ALL_CODES.length)
  })

  it('引用未注册的权限点时抛错（写入侧严格）', () => {
    expect(() =>
      defineRolePreset(
        { code: 'ghost', name: '幽灵', side: 'ADMIN', permissionCodes: ['ghost:read'] },
        ALL_CODES,
      ),
    ).toThrow(/未注册的权限点/)
  })

  it('通配没匹配到任何权限点时抛错', () => {
    expect(() =>
      defineRolePreset(
        { code: 'ghost', name: '幽灵', side: 'ADMIN', permissionCodes: ['ghost:*'] },
        ALL_CODES,
      ),
    ).toThrow(/没有匹配到/)
  })

  it('code 不是 kebab-case 时抛错', () => {
    expect(() =>
      defineRolePreset(
        { code: 'ShopOwner', name: '店主', side: 'ADMIN', permissionCodes: [] },
        ALL_CODES,
      ),
    ).toThrow(/kebab-case/)
  })

  it('name 为空时抛错', () => {
    expect(() =>
      defineRolePreset({ code: 'x', name: '   ', side: 'ADMIN', permissionCodes: [] }, ALL_CODES),
    ).toThrow(/name 不能为空/)
  })

  it('side 非法时抛错', () => {
    expect(() =>
      defineRolePreset(
        // @ts-expect-error 故意传非法 side，验证运行时也会拦
        { code: 'x', name: 'X', side: 'CLIENT', permissionCodes: [] },
        ALL_CODES,
      ),
    ).toThrow(/ADMIN 或 PLATFORM/)
  })

  it('permissionCodes 里有空 code 时抛错', () => {
    expect(() =>
      defineRolePreset(
        { code: 'x', name: 'X', side: 'ADMIN', permissionCodes: ['goods:list', '  '] },
        ALL_CODES,
      ),
    ).toThrow(/空 code/)
  })

  it('允许空权限的角色（新建后再勾选）', () => {
    const preset = defineRolePreset(
      { code: 'blank', name: '空角色', side: 'ADMIN', permissionCodes: [] },
      ALL_CODES,
    )
    expect(preset.permissionCodes).toEqual([])
  })

  it('同一份定义生成的结果稳定（同步命令幂等的前提）', () => {
    const make = (): readonly string[] =>
      defineRolePreset(
        { code: 'c', name: 'C', side: 'ADMIN', permissionCodes: ['order:*', 'goods:list'] },
        ALL_CODES,
      ).permissionCodes
    expect(make()).toEqual(make())
  })
})

describe('canAssignRole', () => {
  it('店主不能授予店主角色（店主只能通过转让产生）', () => {
    expect(canAssignRole({ isOwner: true }, { isOwnerRole: true })).toBe(false)
  })

  it('非店主更不能授予店主角色', () => {
    expect(canAssignRole({ isOwner: false }, { isOwnerRole: true })).toBe(false)
  })

  it('店主角色也不能被撤销（同一条规则两个方向）', () => {
    expect(
      canAssignRole({ isOwner: true, side: 'ADMIN' }, { isOwnerRole: true, side: 'ADMIN' }),
    ).toBe(false)
  })

  it('普通角色店主可以授予', () => {
    expect(canAssignRole({ isOwner: true }, { isOwnerRole: false })).toBe(true)
  })

  it('普通角色非店主也可以授予（接口权限另由 @RequirePermission 把关）', () => {
    expect(canAssignRole({ isOwner: false }, { isOwnerRole: false })).toBe(true)
  })

  it('跨 side 授予被拒绝', () => {
    expect(
      canAssignRole({ isOwner: true, side: 'ADMIN' }, { isOwnerRole: false, side: 'PLATFORM' }),
    ).toBe(false)
  })

  it('同 side 授予通过', () => {
    expect(
      canAssignRole({ isOwner: false, side: 'ADMIN' }, { isOwnerRole: false, side: 'ADMIN' }),
    ).toBe(true)
  })

  it('任一侧未声明 side 时不做 side 比对', () => {
    expect(canAssignRole({ isOwner: false }, { isOwnerRole: false, side: 'PLATFORM' })).toBe(true)
    expect(canAssignRole({ isOwner: false, side: 'ADMIN' }, { isOwnerRole: false })).toBe(true)
  })

  it('规则常量带可直接回给前端的 message', () => {
    expect(ASSIGNABLE_ROLE_RULE.code).toBe('OWNER_ROLE_NOT_ASSIGNABLE')
    expect(ASSIGNABLE_ROLE_RULE.message).toContain('转让')
  })
})
