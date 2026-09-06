import { describe, expect, it } from 'vitest'

import { TenantScopeError, isTenantScopeError } from './errors'
import { planTenantScope } from './plan'
import { createTenantModelRegistry } from './registry'

describe('createTenantModelRegistry', () => {
  it('框架基础表 + 项目业务表合并成一份清单', () => {
    const registry = createTenantModelRegistry(['BaseA', 'BaseB'])
    registry.register(['BizA'])
    expect(registry.snapshot()).toEqual(['BaseA', 'BaseB', 'BizA'])
  })

  it('base 省略时从空清单开始', () => {
    expect(createTenantModelRegistry().snapshot()).toEqual([])
  })

  it('snapshot 按字典序排序，便于 diff 与错误提示', () => {
    const registry = createTenantModelRegistry(['Zeta'])
    registry.register(['Alpha', 'Mu'])
    expect(registry.snapshot()).toEqual(['Alpha', 'Mu', 'Zeta'])
  })

  it('has 的签名与 Set.has 一致，可以直接喂给 planTenantScope', () => {
    const registry = createTenantModelRegistry(['Scoped'])
    expect(registry.has('Scoped')).toBe(true)
    expect(registry.has('Other')).toBe(false)
    const plan = planTenantScope({
      model: 'Scoped',
      operation: 'findMany',
      args: {},
      tenantId: 't1',
      registered: registry,
    })
    expect(plan.action).toBe('execute')
  })

  it('重复登记直接抛错（两处清单打架必须暴露出来）', () => {
    const registry = createTenantModelRegistry(['Dup'])
    expect(() => registry.register(['Dup'])).toThrow(TenantScopeError)
    try {
      registry.register(['Dup'])
    } catch (error) {
      expect(isTenantScopeError(error, 'DUPLICATE_REGISTRATION')).toBe(true)
    }
  })

  it('base 自身有重复项时，创建注册表就失败', () => {
    expect(() => createTenantModelRegistry(['Dup', 'Dup'])).toThrow(TenantScopeError)
  })

  it('同一次 register 里重复也抛错', () => {
    const registry = createTenantModelRegistry()
    expect(() => registry.register(['A', 'A'])).toThrow(TenantScopeError)
  })

  it('freeze 之后再 register 抛 REGISTRY_FROZEN（隔离范围不能在运行期被缩小）', () => {
    const registry = createTenantModelRegistry(['A'])
    registry.freeze()
    expect(() => registry.register(['B'])).toThrow(TenantScopeError)
    try {
      registry.register(['B'])
    } catch (error) {
      expect(isTenantScopeError(error, 'REGISTRY_FROZEN')).toBe(true)
    }
    expect(registry.has('B')).toBe(false)
  })

  it('freeze 后 register 空数组也抛错（不给「反正没加东西」留后门）', () => {
    const registry = createTenantModelRegistry()
    registry.freeze()
    expect(() => registry.register([])).toThrow(/已冻结/)
  })

  it('freeze 幂等：重复调用返回同样的内容', () => {
    const registry = createTenantModelRegistry(['A', 'B'])
    expect([...registry.freeze()].sort()).toEqual(['A', 'B'])
    expect([...registry.freeze()].sort()).toEqual(['A', 'B'])
  })

  it('freeze 返回的是副本：改它不影响注册表', () => {
    const registry = createTenantModelRegistry(['A'])
    const frozen = registry.freeze() as Set<string>
    frozen.add('Sneaky')
    expect(registry.has('Sneaky')).toBe(false)
    expect([...registry.freeze()]).toEqual(['A'])
  })

  it('frozen 标志如实反映状态', () => {
    const registry = createTenantModelRegistry()
    expect(registry.frozen).toBe(false)
    registry.freeze()
    expect(registry.frozen).toBe(true)
  })

  it.each([
    ['', '空串'],
    ['   ', '纯空白'],
  ])('%s（%s）不是合法模型名', (model) => {
    expect(() => createTenantModelRegistry([model])).toThrow(TenantScopeError)
  })

  it('非字符串模型名抛 INVALID_MODEL_NAME', () => {
    const registry = createTenantModelRegistry()
    try {
      registry.register([42 as unknown as string])
      throw new Error('应该抛错')
    } catch (error) {
      expect(isTenantScopeError(error, 'INVALID_MODEL_NAME')).toBe(true)
    }
  })

  it('null 模型名的报错信息说人话', () => {
    expect(() => createTenantModelRegistry([null as unknown as string])).toThrow(/收到 null/)
  })

  it('register 抛错前已经加进去的部分会保留（调用方应视为启动失败）', () => {
    const registry = createTenantModelRegistry()
    expect(() => registry.register(['Ok', 'Ok'])).toThrow(TenantScopeError)
    expect(registry.has('Ok')).toBe(true)
  })
})
