/**
 * T1-2 验收用例③的「装饰器」那一半：非法表达式在**装饰器执行时**（模块加载期）就抛错。
 */

import 'reflect-metadata'
import { Reflector } from '@nestjs/core'
import { describe, expect, it } from 'vitest'
import { DataScope, DATA_SCOPE_KEY, RequirePermission, REQUIRE_PERMISSION_KEY } from './index'

const reflector = new Reflector()

describe('@RequirePermission', () => {
  it('把表达式原样写进 metadata（守卫读的就是它）', () => {
    class Target {
      @RequirePermission('goods:write')
      method(): void {}
    }
    const value = reflector.get(REQUIRE_PERMISSION_KEY, Target.prototype.method)
    expect(value).toBe('goods:write')
  })

  it('数组（与）形式原样保留', () => {
    class Target {
      @RequirePermission(['goods:write', 'order:list'])
      method(): void {}
    }
    expect(reflector.get(REQUIRE_PERMISSION_KEY, Target.prototype.method)).toEqual([
      'goods:write',
      'order:list',
    ])
  })

  it('metadata key 带 taizan:rbac: 前缀，不和第三方装饰器撞车', () => {
    expect(REQUIRE_PERMISSION_KEY).toBe('taizan:rbac:permission')
  })

  it('用例③：通配 goods:* 在装饰器执行时抛错', () => {
    expect(() => RequirePermission('goods:*')).toThrow(/通配/)
  })

  it('用例③：全局通配 * 也抛错', () => {
    expect(() => RequirePermission('*')).toThrow(/通配/)
  })

  it('用例③：格式非法（缺冒号）抛错', () => {
    expect(() => RequirePermission('goods')).toThrow()
  })

  it('用例③：空表达式抛错', () => {
    expect(() => RequirePermission('')).toThrow()
    expect(() => RequirePermission([])).toThrow()
  })

  it('用例③：数组里某一项非法也抛错', () => {
    expect(() => RequirePermission(['goods:list', 'Bad Code'])).toThrow()
  })

  it('抛错发生在装饰器求值时，也就是模块加载期——不是等到第一个请求', () => {
    // 直接写成 class 里的装饰器时，这个 expect 的执行时机就是 class 定义时。
    expect(() => {
      class Target {
        @RequirePermission('goods:*')
        method(): void {}
      }
      return Target
    }).toThrow()
  })
})

describe('@DataScope', () => {
  it('写进 metadata', () => {
    class Target {
      @DataScope({ ownerField: 'createdBy', groupField: 'deptId' })
      method(): void {}
    }
    expect(reflector.get(DATA_SCOPE_KEY, Target.prototype.method)).toEqual({
      ownerField: 'createdBy',
      groupField: 'deptId',
    })
  })

  it('缺 ownerField 抛错（写错字段名在运行时的表现是「查不到数据」，很难查）', () => {
    expect(() => DataScope({ ownerField: '' })).toThrow(/ownerField/)
  })
})
