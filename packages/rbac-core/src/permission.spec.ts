import { describe, expect, it } from 'vitest'
import { definePermissions } from '@taizan/contracts'
import {
  collectExprCodes,
  evaluatePermission,
  expandRoles,
  isWildcardCode,
  normalizeCode,
  parsePermissionExpr,
  permissionCodesOf,
} from './permission'

const PERMISSIONS = definePermissions({
  'goods:list': { module: '商品', name: '查看商品', type: 'API' },
  'goods:write': { module: '商品', name: '新增/编辑商品', type: 'API' },
  'goods:export': { module: '商品', name: '导出商品', type: 'BUTTON' },
  'order:list': { module: '订单', name: '查看订单', type: 'API' },
  'order:refund': { module: '订单', name: '订单退款', type: 'API' },
})

const ALL_CODES = permissionCodesOf(PERMISSIONS)

describe('normalizeCode', () => {
  it('接受合法的 module:action 并 trim 首尾空白', () => {
    expect(normalizeCode('  goods:list  ')).toBe('goods:list')
  })

  it('接受 kebab-case 的两段式 code', () => {
    expect(normalizeCode('plan-order:refund-apply')).toBe('plan-order:refund-apply')
  })

  it('拒绝缺少冒号的 code', () => {
    expect(() => normalizeCode('goods')).toThrow(/module:action/)
  })

  it('拒绝大写与下划线', () => {
    expect(() => normalizeCode('Goods:List')).toThrow(/module:action/)
    expect(() => normalizeCode('goods:new_item')).toThrow(/module:action/)
  })

  it('拒绝空串与纯空白', () => {
    expect(() => normalizeCode('')).toThrow(/不能为空/)
    expect(() => normalizeCode('   ')).toThrow(/不能为空/)
  })

  it('拒绝通配 code（通配只能出现在角色定义里）', () => {
    expect(() => normalizeCode('goods:*')).toThrow(/通配/)
    expect(() => normalizeCode('*')).toThrow(/通配/)
  })
})

describe('isWildcardCode', () => {
  it('识别模块通配与全局通配，普通 code 不算通配', () => {
    expect(isWildcardCode('goods:*')).toBe(true)
    expect(isWildcardCode('*')).toBe(true)
    expect(isWildcardCode('goods:list')).toBe(false)
    expect(isWildcardCode('*:list')).toBe(false)
  })
})

describe('parsePermissionExpr', () => {
  it("把 'a|b' 解析成一个「或」子句", () => {
    expect(parsePermissionExpr('goods:list|goods:write')).toEqual([['goods:list', 'goods:write']])
  })

  it("把 ['a','b'] 解析成两个「与」子句", () => {
    expect(parsePermissionExpr(['goods:list', 'goods:write'])).toEqual([
      ['goods:list'],
      ['goods:write'],
    ])
  })

  it("支持与或混写：['a|b', 'c'] = (a 或 b) 且 c", () => {
    expect(parsePermissionExpr(['goods:list|goods:write', 'order:list'])).toEqual([
      ['goods:list', 'goods:write'],
      ['order:list'],
    ])
  })

  it('拒绝空数组（空表达式不等于「不需要权限」）', () => {
    expect(() => parsePermissionExpr([])).toThrow(/不能是空数组/)
  })

  it('拒绝带空分片的 "a|"', () => {
    expect(() => parsePermissionExpr('goods:list|')).toThrow(/空的 "\|" 分片/)
  })
})

describe('evaluatePermission', () => {
  const granted = new Set(['goods:list', 'order:list'])

  it("'a|b' 命中任一即通过", () => {
    expect(evaluatePermission('goods:list|goods:write', granted)).toBe(true)
    expect(evaluatePermission('goods:write|goods:export', granted)).toBe(false)
  })

  it("['a','b'] 必须全部命中", () => {
    expect(evaluatePermission(['goods:list', 'order:list'], granted)).toBe(true)
    expect(evaluatePermission(['goods:list', 'goods:write'], granted)).toBe(false)
  })

  it('单点表达式等价于集合包含判断', () => {
    expect(evaluatePermission('goods:list', granted)).toBe(true)
    expect(evaluatePermission('goods:write', granted)).toBe(false)
  })

  it('与或混写按 (a 或 b) 且 c 求值', () => {
    expect(evaluatePermission(['goods:write|goods:list', 'order:list'], granted)).toBe(true)
    expect(evaluatePermission(['goods:write|goods:export', 'order:list'], granted)).toBe(false)
  })

  it('空集合下任何表达式都不通过', () => {
    expect(evaluatePermission('goods:list', new Set<string>())).toBe(false)
  })

  it('表达式里出现通配时抛错，而不是返回 true（禁止用通配放宽接口）', () => {
    expect(() => evaluatePermission('goods:*', new Set(['goods:list']))).toThrow(/通配/)
    expect(() => evaluatePermission(['goods:*'], new Set(['goods:list']))).toThrow(/通配/)
    expect(() => evaluatePermission('goods:list|goods:*', new Set(['goods:list']))).toThrow(/通配/)
  })

  it('表达式里出现全局通配 "*" 同样抛错', () => {
    expect(() => evaluatePermission('*', new Set(ALL_CODES))).toThrow(/通配/)
  })

  it('非法格式的表达式抛错而不是静默放行', () => {
    expect(() => evaluatePermission('GOODS', new Set<string>())).toThrow(/module:action/)
  })

  it('granted 里的通配字面量不会命中普通表达式（求值不做前缀匹配）', () => {
    expect(evaluatePermission('goods:write', new Set(['goods:*']))).toBe(false)
  })
})

describe('collectExprCodes / permissionCodesOf', () => {
  it('收集表达式引用到的全部 code 并去重', () => {
    expect(collectExprCodes(['goods:list|goods:write', 'goods:list'])).toEqual([
      'goods:list',
      'goods:write',
    ])
  })

  it('从注册表里取出全部 code', () => {
    expect(permissionCodesOf(PERMISSIONS)).toEqual([
      'goods:list',
      'goods:write',
      'goods:export',
      'order:list',
      'order:refund',
    ])
  })
})

describe('expandRoles', () => {
  it('多角色取并集', () => {
    const granted = expandRoles(
      [{ permissionCodes: ['goods:list'] }, { permissionCodes: ['order:list', 'goods:list'] }],
      { allCodes: ALL_CODES },
    )
    expect([...granted].sort()).toEqual(['goods:list', 'order:list'])
  })

  it('没有角色时得到空集合', () => {
    expect(expandRoles([], { allCodes: ALL_CODES }).size).toBe(0)
  })

  it('角色里的模块通配按注册表展开', () => {
    const granted = expandRoles([{ permissionCodes: ['goods:*'] }], { allCodes: ALL_CODES })
    expect([...granted].sort()).toEqual(['goods:export', 'goods:list', 'goods:write'])
  })

  it('角色里的全局通配展开成全部权限点', () => {
    const granted = expandRoles([{ permissionCodes: ['*'] }], { allCodes: ALL_CODES })
    expect(granted.size).toBe(ALL_CODES.length)
  })

  it('ownerAll 时忽略角色配置，等于全部已注册权限点', () => {
    const granted = expandRoles([{ permissionCodes: ['goods:list'] }], {
      ownerAll: true,
      allCodes: ALL_CODES,
    })
    expect([...granted].sort()).toEqual([...ALL_CODES].sort())
  })

  it('ownerAll 缺 allCodes 时抛错（宁可炸也不要给出空的店主权限集）', () => {
    expect(() => expandRoles([], { ownerAll: true })).toThrow(/allCodes/)
  })

  it('通配缺 allCodes 时抛错（调用方忘传注册表属于代码 bug）', () => {
    expect(() => expandRoles([{ permissionCodes: ['goods:*'] }])).toThrow(/allCodes/)
  })

  it('宽松模式下丢弃未注册的历史脏 code（方向是少给权限）', () => {
    const granted = expandRoles([{ permissionCodes: ['goods:list', 'legacy:gone'] }], {
      allCodes: ALL_CODES,
    })
    expect([...granted]).toEqual(['goods:list'])
  })

  it('宽松模式下丢弃格式非法的 code', () => {
    const granted = expandRoles([{ permissionCodes: ['goods:list', 'BROKEN', '  '] }], {
      allCodes: ALL_CODES,
    })
    expect([...granted]).toEqual(['goods:list'])
  })

  it('严格模式下未注册的 code 抛错', () => {
    expect(() =>
      expandRoles([{ permissionCodes: ['legacy:gone'] }], { allCodes: ALL_CODES, strict: true }),
    ).toThrow(/不在已注册权限点里/)
  })

  it('严格模式下没匹配到任何权限点的通配抛错', () => {
    expect(() =>
      expandRoles([{ permissionCodes: ['ghost:*'] }], { allCodes: ALL_CODES, strict: true }),
    ).toThrow(/没有匹配到/)
  })

  it('不传 allCodes 且没有通配时按格式校验后原样合并', () => {
    const granted = expandRoles([{ permissionCodes: ['goods:list'] }])
    expect([...granted]).toEqual(['goods:list'])
  })

  it('展开结果可直接喂给 evaluatePermission', () => {
    const granted = expandRoles([{ permissionCodes: ['order:*'] }], { allCodes: ALL_CODES })
    expect(evaluatePermission('order:refund', granted)).toBe(true)
    expect(evaluatePermission('goods:write', granted)).toBe(false)
  })

  it('通配不会跨模块误伤（goods:* 不含 order:*）', () => {
    const granted = expandRoles([{ permissionCodes: ['goods:*'] }], { allCodes: ALL_CODES })
    expect(granted.has('order:list')).toBe(false)
  })
})
