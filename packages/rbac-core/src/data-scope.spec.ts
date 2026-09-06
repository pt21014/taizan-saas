import { describe, expect, it } from 'vitest'
import { DATA_SCOPES, buildScopeWhere, mergeScopeWhere, type DataScope } from './data-scope'

const FIELDS = { ownerField: 'createdBy', groupField: 'deptId' }

describe('buildScopeWhere - ALL', () => {
  it('返回 null 表示不加任何额外条件', () => {
    expect(buildScopeWhere('ALL', { subjectId: 's1' }, FIELDS)).toBeNull()
  })

  it('即便没有 subjectId 也不抛错（ALL 不需要主体）', () => {
    expect(buildScopeWhere('ALL', { subjectId: '' }, { ownerField: 'createdBy' })).toBeNull()
  })
})

describe('buildScopeWhere - SELF', () => {
  it('按 ownerField 精确匹配当前主体', () => {
    expect(buildScopeWhere('SELF', { subjectId: 's1' }, FIELDS)).toEqual({ createdBy: 's1' })
  })

  it('ownerField 可自定义', () => {
    expect(buildScopeWhere('SELF', { subjectId: 's1' }, { ownerField: 'staffId' })).toEqual({
      staffId: 's1',
    })
  })

  it('缺 subjectId 时抛错（失败关闭，不返回可能放行全表的条件）', () => {
    expect(() => buildScopeWhere('SELF', { subjectId: '' }, FIELDS)).toThrow(/subjectId/)
  })
})

describe('buildScopeWhere - SUB_TREE', () => {
  it('按 groupField in 子树 ID 列表', () => {
    expect(
      buildScopeWhere('SUB_TREE', { subjectId: 's1', subtreeIds: ['d1', 'd2'] }, FIELDS),
    ).toEqual({ deptId: { in: ['d1', 'd2'] } })
  })

  it('子树为空数组时返回永假条件 { in: [] }，而不是查全部', () => {
    expect(buildScopeWhere('SUB_TREE', { subjectId: 's1', subtreeIds: [] }, FIELDS)).toEqual({
      deptId: { in: [] },
    })
  })

  it('子树未提供（undefined）时同样返回永假条件', () => {
    expect(buildScopeWhere('SUB_TREE', { subjectId: 's1' }, FIELDS)).toEqual({ deptId: { in: [] } })
  })

  it('永假条件绝不等于 null（null 会被 mergeScopeWhere 当成不收窄）', () => {
    expect(buildScopeWhere('SUB_TREE', { subjectId: 's1', subtreeIds: [] }, FIELDS)).not.toBeNull()
  })

  it('缺 groupField 时抛错', () => {
    expect(() =>
      buildScopeWhere(
        'SUB_TREE',
        { subjectId: 's1', subtreeIds: ['d1'] },
        { ownerField: 'createdBy' },
      ),
    ).toThrow(/groupField/)
  })

  it('拷贝输入数组，调用方之后改数组不会影响已生成的 where', () => {
    const subtreeIds = ['d1']
    const where = buildScopeWhere('SUB_TREE', { subjectId: 's1', subtreeIds }, FIELDS)
    subtreeIds.push('d2')
    expect(where).toEqual({ deptId: { in: ['d1'] } })
  })
})

describe('buildScopeWhere - CUSTOM', () => {
  it('按 ownerField in 授权对象列表', () => {
    expect(
      buildScopeWhere('CUSTOM', { subjectId: 's1', scopeTargets: ['a', 'b'] }, FIELDS),
    ).toEqual({ createdBy: { in: ['a', 'b'] } })
  })

  it('scopeTargets 为空数组 = 查不到任何数据（不是查全部）', () => {
    expect(buildScopeWhere('CUSTOM', { subjectId: 's1', scopeTargets: [] }, FIELDS)).toEqual({
      createdBy: { in: [] },
    })
  })

  it('scopeTargets 为 null 同样是永假条件', () => {
    expect(buildScopeWhere('CUSTOM', { subjectId: 's1', scopeTargets: null }, FIELDS)).toEqual({
      createdBy: { in: [] },
    })
  })

  it('scopeTargets 缺省同样是永假条件', () => {
    expect(buildScopeWhere('CUSTOM', { subjectId: 's1' }, FIELDS)).toEqual({
      createdBy: { in: [] },
    })
  })

  it('CUSTOM 不会退化成 SELF（授权列表里没有自己就看不到自己的数据）', () => {
    expect(buildScopeWhere('CUSTOM', { subjectId: 's1', scopeTargets: ['other'] }, FIELDS)).toEqual(
      {
        createdBy: { in: ['other'] },
      },
    )
  })
})

describe('buildScopeWhere - 非法输入', () => {
  it('未知 scope 抛错（失败关闭）', () => {
    expect(() => buildScopeWhere('EVERYTHING' as DataScope, { subjectId: 's1' }, FIELDS)).toThrow(
      /未知的数据范围/,
    )
  })

  it('四种 scope 里只有 ALL 返回 null，其余都返回条件对象', () => {
    const results = DATA_SCOPES.map((scope) => buildScopeWhere(scope, { subjectId: 's1' }, FIELDS))
    expect(results.filter((r) => r === null).length).toBe(1)
    expect(results[0]).toBeNull()
  })
})

describe('mergeScopeWhere', () => {
  it('scope 为 null 时原样返回 base 的副本', () => {
    const base = { status: 'ON' }
    const merged = mergeScopeWhere(base, null)
    expect(merged).toEqual({ status: 'ON' })
    expect(merged).not.toBe(base)
  })

  it('base 为空时直接返回 scope 的副本', () => {
    expect(mergeScopeWhere(undefined, { createdBy: 's1' })).toEqual({ createdBy: 's1' })
    expect(mergeScopeWhere({}, { createdBy: 's1' })).toEqual({ createdBy: 's1' })
  })

  it('两边都有时用 AND 包裹', () => {
    expect(mergeScopeWhere({ status: 'ON' }, { createdBy: 's1' })).toEqual({
      AND: [{ status: 'ON' }, { createdBy: 's1' }],
    })
  })

  it('业务侧写了同名字段也覆盖不掉数据范围条件', () => {
    const merged = mergeScopeWhere({ createdBy: 'someone-else' }, { createdBy: 's1' })
    expect(merged).toEqual({ AND: [{ createdBy: 'someone-else' }, { createdBy: 's1' }] })
  })

  it('base 与 scope 都为空时返回空对象', () => {
    expect(mergeScopeWhere(null, null)).toEqual({})
  })

  it('永假条件被 AND 进去后依然是永假条件', () => {
    const scope = buildScopeWhere('CUSTOM', { subjectId: 's1', scopeTargets: [] }, FIELDS)
    expect(mergeScopeWhere({ status: 'ON' }, scope)).toEqual({
      AND: [{ status: 'ON' }, { createdBy: { in: [] } }],
    })
  })
})
