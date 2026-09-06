import { describe, expect, it } from 'vitest'

import { definePermissions, FRAMEWORK_PERMISSION_CODES } from './permission'

describe('definePermissions', () => {
  it('合法 code 正常注册并冻结', () => {
    const PERMISSIONS = definePermissions({
      'goods:list': { module: '商品', name: '查看商品', type: 'API' },
      'goods:write': { module: '商品', name: '新增/编辑商品', type: 'API' },
      'goods:export': { module: '商品', name: '导出商品', type: 'BUTTON' },
    })
    expect(PERMISSIONS['goods:list'].name).toBe('查看商品')
    expect(Object.isFrozen(PERMISSIONS)).toBe(true)
    expect(Object.isFrozen(PERMISSIONS['goods:list'])).toBe(true)
  })

  it('拒绝缺少冒号的 code', () => {
    expect(() =>
      definePermissions({ goodslist: { module: '商品', name: '查看商品', type: 'API' } }),
    ).toThrow(/module:action/)
  })

  it('拒绝多段冒号或非法字符的 code', () => {
    expect(() =>
      definePermissions({
        'goods:list:extra': { module: '商品', name: 'x', type: 'API' },
      }),
    ).toThrow()
    expect(() =>
      definePermissions({
        'Goods:List': { module: '商品', name: 'x', type: 'API' },
      }),
    ).toThrow()
  })

  it('返回对象不可变更', () => {
    const PERMISSIONS = definePermissions({
      'goods:list': { module: '商品', name: '查看商品', type: 'API' },
    })
    expect(() => {
      // @ts-expect-error 测试运行时冻结效果
      PERMISSIONS['goods:list'].name = '改一下'
    }).toThrow()
  })
})

describe('FRAMEWORK_PERMISSION_CODES', () => {
  it('非空、无重复、每个 code 都满足 module:action 格式', () => {
    expect(FRAMEWORK_PERMISSION_CODES.length).toBeGreaterThan(0)
    expect(new Set(FRAMEWORK_PERMISSION_CODES).size).toBe(FRAMEWORK_PERMISSION_CODES.length)
    // 复用 definePermissions 的格式校验：不通过就会抛。
    expect(() =>
      definePermissions(
        Object.fromEntries(
          FRAMEWORK_PERMISSION_CODES.map((code) => [
            code,
            { module: 'x', name: 'x', type: 'API' as const },
          ]),
        ),
      ),
    ).not.toThrow()
  })

  it('不含通配符（`*` 是角色层面的特殊值，不是一个权限点）', () => {
    expect(FRAMEWORK_PERMISSION_CODES).not.toContain('*')
  })
})
