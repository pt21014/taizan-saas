import { describe, expect, it } from 'vitest'

import { TenantScopeError, isTenantScopeError } from './errors'
import {
  CREATE_OPERATIONS,
  SUPPORTED_OPERATIONS,
  UNIQUE_MUTATION_OPERATIONS,
  UNIQUE_READ_OPERATIONS,
  WHERE_OPERATIONS,
  assertResultOwner,
  modelToClientKey,
  planTenantScope,
  type PlanTenantScopeParams,
  type ScopePlan,
} from './plan'

const T = 'tenant-A'
const OTHER = 'tenant-B'
/** 中性的登记清单：框架不认识业务表，测试也不该抄业务表名。 */
const registered = new Set(['Scoped', 'ScopedChild'])

const plan = (
  operation: string,
  args?: unknown,
  overrides: Partial<PlanTenantScopeParams> = {},
): ScopePlan =>
  planTenantScope({ model: 'Scoped', operation, args, tenantId: T, registered, ...overrides })

/** 取出计划里的 args；`passthrough` 没有 args，取到就说明用例本身写错了。 */
const argsOf = (p: ScopePlan): Record<string, unknown> => {
  if (p.action === 'passthrough') throw new Error('passthrough 没有 args')
  return p.args
}

describe('操作清单本身', () => {
  it('覆盖 Prisma 6 的全部 17 个模型操作，一个不落', () => {
    expect([...SUPPORTED_OPERATIONS].sort()).toEqual(
      [
        'aggregate',
        'count',
        'create',
        'createMany',
        'createManyAndReturn',
        'delete',
        'deleteMany',
        'findFirst',
        'findFirstOrThrow',
        'findMany',
        'findUnique',
        'findUniqueOrThrow',
        'groupBy',
        'update',
        'updateMany',
        'updateManyAndReturn',
        'upsert',
      ].sort(),
    )
  })

  it('四类操作互不重叠（一个操作只能有一种隔离方式）', () => {
    const all = [
      ...WHERE_OPERATIONS,
      ...UNIQUE_READ_OPERATIONS,
      ...UNIQUE_MUTATION_OPERATIONS,
      ...CREATE_OPERATIONS,
    ]
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('非租户域模型', () => {
  it('平台域表原样放行', () => {
    expect(plan('findMany', {}, { model: 'PlatformAdmin' })).toEqual({ action: 'passthrough' })
  })

  it('没有租户上下文时，非租户域模型依然放行（平台后台要跨租户查）', () => {
    expect(plan('findMany', {}, { model: 'PlatformAdmin', tenantId: '' })).toEqual({
      action: 'passthrough',
    })
  })

  it('未登记模型上的未知操作也放行（隔离范围之外，不归这里管）', () => {
    expect(plan('someFutureOp', {}, { model: 'PlatformAdmin' })).toEqual({ action: 'passthrough' })
  })

  it('onUnregistered: throw 时把「新表忘了登记」变成响亮失败', () => {
    expect(() => plan('findMany', {}, { model: 'Forgotten', onUnregistered: 'throw' })).toThrow(
      TenantScopeError,
    )
    try {
      plan('findMany', {}, { model: 'Forgotten', onUnregistered: 'throw' })
    } catch (error) {
      expect(isTenantScopeError(error, 'MODEL_NOT_REGISTERED')).toBe(true)
    }
  })
})

describe('反面教材 ①：无上下文即放行', () => {
  // xiaodian 那版是 `if (!ctx?.tenantId || !MODELS.has(model)) return query(args)`，
  // 没解析出租户 = 查全表。这里必须抛错。
  it('租户域模型上没有 tenantId 时抛 NO_CONTEXT，而不是查全表', () => {
    expect(() => plan('findMany', {}, { tenantId: '' })).toThrow(TenantScopeError)
    try {
      plan('findMany', {}, { tenantId: '' })
    } catch (error) {
      expect(isTenantScopeError(error, 'NO_CONTEXT')).toBe(true)
    }
  })

  it.each(SUPPORTED_OPERATIONS)('%s 在无上下文时一律抛错，没有例外', (operation) => {
    expect(() => plan(operation, {}, { tenantId: '' })).toThrow(TenantScopeError)
  })

  it('tenantId 不是字符串时同样抛 NO_CONTEXT（失败关闭）', () => {
    expect(() => plan('findMany', {}, { tenantId: undefined as unknown as string })).toThrowError(
      TenantScopeError,
    )
  })

  it('NO_CONTEXT 的提示要指明逃生口只有 prisma.raw 三处', () => {
    expect(() => plan('findMany', {}, { tenantId: '' })).toThrow(/prisma\.raw/)
  })
})

describe('反面教材 ③：where 用 AND 包裹，调用方覆盖不了', () => {
  it.each(WHERE_OPERATIONS)('%s 会把 tenantId 条件 AND 上去', (operation) => {
    const p = plan(operation, { where: { status: 'ON' } })
    expect(p.action).toBe('execute')
    expect(argsOf(p).where).toEqual({ AND: [{ tenantId: T }, { status: 'ON' }] })
  })

  it('没写 where 时也会补上', () => {
    expect(argsOf(plan('findMany')).where).toEqual({ AND: [{ tenantId: T }, {}] })
  })

  it('findMany({ where: { tenantId: other } }) 的计划里当前租户条件仍在，且是 AND 不是覆盖', () => {
    const p = plan('findMany', { where: { tenantId: OTHER } })
    // 不是 { ...where, tenantId } —— 那样会被调用方覆盖成 OTHER。
    expect(argsOf(p).where).toEqual({ AND: [{ tenantId: T }, { tenantId: OTHER }] })
    expect(argsOf(p).where).not.toEqual({ tenantId: OTHER })
    const and = (argsOf(p).where as { AND: { tenantId?: string }[] }).AND
    expect(and[0]?.tenantId).toBe(T)
  })

  it('调用方自己套一层 OR 也盖不掉：整个 OR 只是 AND 的第二项', () => {
    const p = plan('findMany', { where: { OR: [{ tenantId: OTHER }, { id: 'x' }] } })
    expect(argsOf(p).where).toEqual({
      AND: [{ tenantId: T }, { OR: [{ tenantId: OTHER }, { id: 'x' }] }],
    })
  })

  it('不会篡改调用方传入的原始对象', () => {
    const original = { where: { status: 'ON' } }
    plan('findMany', original)
    expect(original).toEqual({ where: { status: 'ON' } })
  })

  it('其余 args（select / orderBy / take）原样保留', () => {
    const p = plan('findMany', { take: 10, orderBy: { id: 'asc' }, select: { id: true } })
    expect(argsOf(p).take).toBe(10)
    expect(argsOf(p).orderBy).toEqual({ id: 'asc' })
    expect(argsOf(p).select).toEqual({ id: true })
  })

  it('updateMany 不允许把记录改到别的租户名下', () => {
    expect(() => plan('updateMany', { where: {}, data: { tenantId: OTHER } })).toThrow(/tenantId/)
  })

  it('updateManyAndReturn 同样看住 data.tenantId', () => {
    expect(() => plan('updateManyAndReturn', { where: {}, data: { tenantId: OTHER } })).toThrow(
      TenantScopeError,
    )
  })

  it('updateMany 写 data: { tenantId: { set: other } } 也拦得住', () => {
    expect(() => plan('updateMany', { data: { tenantId: { set: OTHER } } })).toThrow(
      TenantScopeError,
    )
  })

  it('updateMany 写自己的 tenantId（无意义但无害）放行', () => {
    expect(plan('updateMany', { data: { tenantId: T, name: 'x' } }).action).toBe('execute')
  })
})

describe('创建类操作：注入 data.tenantId', () => {
  it('create 补上 tenantId', () => {
    expect(argsOf(plan('create', { data: { title: 'x' } })).data).toEqual({
      title: 'x',
      tenantId: T,
    })
  })

  it('create 时调用方伪造别的 tenantId 直接抛错（knowledge 原实现是静默覆盖）', () => {
    expect(() => plan('create', { data: { title: 'x', tenantId: OTHER } })).toThrow(
      TenantScopeError,
    )
  })

  it('create 时用关系写 tenant: { connect } 绕过标量注入也抛错', () => {
    // xiaodian 那版遇到 `tenant` 字段就跳过注入，等于把归属交给调用方。
    expect(() => plan('create', { data: { tenant: { connect: { id: OTHER } } } })).toThrow(/关系写/)
  })

  it('create 传了自己的 tenantId 时放行（幂等，不算越权）', () => {
    expect(argsOf(plan('create', { data: { tenantId: T } })).data).toEqual({ tenantId: T })
  })

  it('create 完全没给 data 时也造出带 tenantId 的 data', () => {
    expect(argsOf(plan('create', {})).data).toEqual({ tenantId: T })
  })

  it('createMany 数组里每一行都补', () => {
    expect(argsOf(plan('createMany', { data: [{ a: 1 }, { b: 2 }] })).data).toEqual([
      { a: 1, tenantId: T },
      { b: 2, tenantId: T },
    ])
  })

  it('createMany 传单个对象也能处理', () => {
    expect(argsOf(plan('createMany', { data: { a: 1 } })).data).toEqual([{ a: 1, tenantId: T }])
  })

  it('createManyAndReturn 与 createMany 同处理', () => {
    expect(argsOf(plan('createManyAndReturn', { data: [{ a: 1 }] })).data).toEqual([
      { a: 1, tenantId: T },
    ])
  })

  it('createMany 里只要有一行写了别的租户，整批都拒绝', () => {
    expect(() => plan('createMany', { data: [{ a: 1 }, { tenantId: OTHER }] })).toThrow(
      TenantScopeError,
    )
  })

  it('data 不是对象时抛 INVALID_ARGUMENT，而不是把字符串展开成一堆字符键', () => {
    expect(() => plan('create', { data: 'oops' })).toThrow(TenantScopeError)
    try {
      plan('create', { data: null })
    } catch (error) {
      expect(isTenantScopeError(error, 'INVALID_ARGUMENT')).toBe(true)
    }
  })
})

describe('反面教材 ②：upsert 三分支', () => {
  it('upsert 走「先验归属再执行」，不是简单 execute', () => {
    const p = plan('upsert', { where: { id: 'x' }, create: {}, update: {} })
    expect(p.action).toBe('verifyOwnerThenExecute')
  })

  it('create 分支注入 tenantId（否则新建出来的记录无归属）', () => {
    const p = plan('upsert', { where: { id: 'x' }, create: { title: 'a' }, update: {} })
    expect(argsOf(p).create).toEqual({ title: 'a', tenantId: T })
  })

  it('update 分支不允许改 tenantId（否则一次 upsert 就能把记录送人）', () => {
    expect(() =>
      plan('upsert', { where: { id: 'x' }, create: {}, update: { tenantId: OTHER } }),
    ).toThrow(TenantScopeError)
  })

  it('create 分支里写别的 tenantId 同样拒绝', () => {
    expect(() =>
      plan('upsert', { where: { id: 'x' }, create: { tenantId: OTHER }, update: {} }),
    ).toThrow(TenantScopeError)
  })

  it('where 分支原样保留，交给执行层先查归属', () => {
    const p = plan('upsert', { where: { id: 'x' }, create: {}, update: {} })
    expect(argsOf(p).where).toEqual({ id: 'x' })
  })

  it('upsert 没给 create 时也造出带 tenantId 的 create', () => {
    expect(argsOf(plan('upsert', { where: { id: 'x' } })).create).toEqual({ tenantId: T })
  })
})

describe('唯一键读操作：查完校验归属', () => {
  it('findUnique 越权时返回 null（不抛错，避免泄露记录是否存在）', () => {
    expect(plan('findUnique', { where: { id: 'x' } })).toMatchObject({
      action: 'checkResultOwner',
      throwWhenForeign: false,
    })
  })

  it('findUniqueOrThrow 越权时抛错，与记录不存在的表现一致', () => {
    expect(plan('findUniqueOrThrow', { where: { id: 'x' } })).toMatchObject({
      action: 'checkResultOwner',
      throwWhenForeign: true,
    })
  })
})

describe('不可退让 ③：findUnique 自动补 select.tenantId', () => {
  it('select 里没有 tenantId 时补上', () => {
    const p = plan('findUnique', { where: { id: 'x' }, select: { id: true, title: true } })
    expect(argsOf(p).select).toEqual({ id: true, title: true, tenantId: true })
  })

  it('已经选了 tenantId 时不重复也不破坏', () => {
    const p = plan('findUnique', { where: { id: 'x' }, select: { id: true, tenantId: true } })
    expect(argsOf(p).select).toEqual({ id: true, tenantId: true })
  })

  it('没写 select（取全字段）时不动 args', () => {
    expect(argsOf(plan('findUnique', { where: { id: 'x' } })).select).toBeUndefined()
  })

  it('findUniqueOrThrow / update / delete 同样补', () => {
    for (const operation of ['findUniqueOrThrow', 'update', 'delete']) {
      const p = plan(operation, { where: { id: 'x' }, select: { id: true } })
      expect(argsOf(p).select).toEqual({ id: true, tenantId: true })
    }
  })

  it('omit: { tenantId: true } 会被剔除，否则校验依据被抹掉（Prisma 5.16+ 的新坑）', () => {
    const p = plan('findUnique', { where: { id: 'x' }, omit: { tenantId: true, memo: true } })
    expect(argsOf(p).omit).toEqual({ memo: true })
  })

  it('omit 里只有 tenantId 时整个 omit 都删掉', () => {
    const p = plan('findUnique', { where: { id: 'x' }, omit: { tenantId: true } })
    expect('omit' in argsOf(p)).toBe(false)
  })

  it('只写 include 时不往里塞 tenantId（Prisma 的 include 只接受关系字段）', () => {
    const p = plan('findUnique', { where: { id: 'x' }, include: { children: true } })
    expect(argsOf(p).include).toEqual({ children: true })
    expect(argsOf(p).select).toBeUndefined()
  })

  it('补 select 时不篡改调用方原始对象', () => {
    const original = { where: { id: 'x' }, select: { id: true } }
    plan('findUnique', original)
    expect(original.select).toEqual({ id: true })
  })
})

describe('唯一键写操作：先验归属再执行', () => {
  it.each(UNIQUE_MUTATION_OPERATIONS)('%s 需要先校验归属', (operation) => {
    expect(plan(operation, { where: { id: 'x' } }).action).toBe('verifyOwnerThenExecute')
  })

  it('update 的 data 不允许改 tenantId', () => {
    expect(() => plan('update', { where: { id: 'x' }, data: { tenantId: OTHER } })).toThrow(
      TenantScopeError,
    )
  })

  it('update 的 data 用关系写换归属也拒绝', () => {
    expect(() =>
      plan('update', { where: { id: 'x' }, data: { tenant: { connect: { id: OTHER } } } }),
    ).toThrow(TenantScopeError)
  })

  it('delete 不改写 where（唯一键定位），归属交给执行层先查', () => {
    expect(argsOf(plan('delete', { where: { id: 'x' } })).where).toEqual({ id: 'x' })
  })
})

describe('一层嵌套 create 注入', () => {
  const nestedModels = { children: 'ScopedChild', plan: 'Plan' }

  it('默认 mapped 策略：映射到已登记模型的关系才注入', () => {
    const p = plan(
      'create',
      { data: { title: 'x', children: { create: [{ name: 'a' }, { name: 'b' }] } } },
      { nestedModels },
    )
    expect((argsOf(p).data as { children: { create: unknown[] } }).children.create).toEqual([
      { name: 'a', tenantId: T },
      { name: 'b', tenantId: T },
    ])
  })

  it('映射到未登记模型（平台域表）的关系不注入，否则 Prisma 会报未知字段', () => {
    const p = plan('create', { data: { plan: { create: { code: 'p' } } } }, { nestedModels })
    expect((argsOf(p).data as { plan: { create: unknown } }).plan.create).toEqual({ code: 'p' })
  })

  it('没给映射时默认不猜（mapped 策略下原样保留）', () => {
    const p = plan('create', { data: { others: { create: { a: 1 } } } })
    expect((argsOf(p).data as { others: { create: unknown } }).others.create).toEqual({ a: 1 })
  })

  it("nestedCreate: 'all' 时对所有未明确排除的关系注入", () => {
    const p = plan(
      'create',
      { data: { others: { create: { a: 1 } }, plan: { create: { code: 'p' } } } },
      { nestedModels, nestedCreate: 'all' },
    )
    const data = argsOf(p).data as {
      others: { create: Record<string, unknown> }
      plan: { create: Record<string, unknown> }
    }
    expect(data.others.create).toEqual({ a: 1, tenantId: T })
    expect(data.plan.create).toEqual({ code: 'p' })
  })

  it("nestedCreate: 'off' 时完全不碰嵌套写", () => {
    const p = plan(
      'create',
      { data: { children: { create: { a: 1 } } } },
      { nestedModels, nestedCreate: 'off' },
    )
    expect((argsOf(p).data as { children: { create: unknown } }).children.create).toEqual({ a: 1 })
  })

  it('嵌套 createMany.data 与 connectOrCreate.create 也注入', () => {
    const p = plan(
      'create',
      {
        data: {
          children: {
            createMany: { data: [{ a: 1 }], skipDuplicates: true },
            connectOrCreate: [{ where: { id: 'c1' }, create: { a: 2 } }],
          },
        },
      },
      { nestedModels },
    )
    const children = (argsOf(p).data as { children: Record<string, unknown> }).children
    expect(children.createMany).toEqual({ data: [{ a: 1, tenantId: T }], skipDuplicates: true })
    expect(children.connectOrCreate).toEqual([
      { where: { id: 'c1' }, create: { a: 2, tenantId: T } },
    ])
  })

  it('嵌套 createMany.data 传单个对象也处理', () => {
    const p = plan(
      'create',
      { data: { children: { createMany: { data: { a: 1 } } } } },
      { nestedModels },
    )
    const children = (argsOf(p).data as { children: Record<string, unknown> }).children
    expect(children.createMany).toEqual({ data: { a: 1, tenantId: T } })
  })

  it('嵌套 connectOrCreate 传单个对象也处理', () => {
    const p = plan(
      'create',
      { data: { children: { connectOrCreate: { where: { id: 'c1' }, create: { a: 2 } } } } },
      { nestedModels },
    )
    const children = (argsOf(p).data as { children: Record<string, unknown> }).children
    expect(children.connectOrCreate).toEqual({ where: { id: 'c1' }, create: { a: 2, tenantId: T } })
  })

  it('嵌套 create 里写别的 tenantId 也拒绝', () => {
    expect(() =>
      plan('create', { data: { children: { create: { tenantId: OTHER } } } }, { nestedModels }),
    ).toThrow(TenantScopeError)
  })

  it('嵌套 connect 明确不处理（跨租户 connect 由执行层校验，这是已知边界）', () => {
    const p = plan(
      'create',
      { data: { children: { connect: { id: 'other-tenant-child' } } } },
      { nestedModels },
    )
    expect((argsOf(p).data as { children: unknown }).children).toEqual({
      connect: { id: 'other-tenant-child' },
    })
  })

  it('第二层嵌套不注入（已知边界，TSDoc 里写明了）', () => {
    const p = plan(
      'create',
      { data: { children: { create: { grand: { create: { a: 1 } } } } } },
      { nestedModels: { children: 'ScopedChild', grand: 'ScopedChild' } },
    )
    const child = (argsOf(p).data as { children: { create: Record<string, unknown> } }).children
      .create
    expect(child.tenantId).toBe(T)
    expect(child.grand).toEqual({ create: { a: 1 } })
  })

  it('update / upsert 的嵌套 create 同样注入', () => {
    const forUpdate = plan(
      'update',
      { where: { id: 'x' }, data: { children: { create: { a: 1 } } } },
      { nestedModels },
    )
    expect((argsOf(forUpdate).data as { children: { create: unknown } }).children.create).toEqual({
      a: 1,
      tenantId: T,
    })

    const forUpsert = plan(
      'upsert',
      { where: { id: 'x' }, create: {}, update: { children: { create: { a: 1 } } } },
      { nestedModels },
    )
    expect((argsOf(forUpsert).update as { children: { create: unknown } }).children.create).toEqual(
      { a: 1, tenantId: T },
    )
  })

  it('嵌套注入不篡改调用方原始对象', () => {
    const original = { data: { children: { create: { a: 1 } } } }
    plan('create', original, { nestedModels })
    expect(original.data.children.create).toEqual({ a: 1 })
  })
})

describe('不可退让 ④：失败关闭', () => {
  it('Prisma 将来新增未知操作名时抛 UNKNOWN_OPERATION，而不是静默放行', () => {
    expect(() => plan('someFutureBulkWrite')).toThrow(TenantScopeError)
    try {
      plan('someFutureBulkWrite')
    } catch (error) {
      expect(isTenantScopeError(error, 'UNKNOWN_OPERATION')).toBe(true)
    }
  })

  it.each(['findRaw', 'aggregateRaw', 'runCommandRaw', 'updateManyAndCount'])(
    '%s 也一律抛错',
    (operation) => {
      expect(() => plan(operation)).toThrow(TenantScopeError)
    },
  )

  it('抛错信息要指明去哪里补，方便后来人处理', () => {
    expect(() => plan('someFutureBulkWrite')).toThrow(/plan\.ts/)
  })

  it('args 不是对象时抛 INVALID_ARGUMENT', () => {
    expect(() => plan('findMany', 'oops')).toThrow(TenantScopeError)
    expect(() => plan('findMany', [1, 2])).toThrow(TenantScopeError)
  })

  it('args 为 undefined / null 时按空对象处理', () => {
    expect(argsOf(plan('findMany', undefined)).where).toEqual({ AND: [{ tenantId: T }, {}] })
    expect(argsOf(plan('findMany', null)).where).toEqual({ AND: [{ tenantId: T }, {}] })
  })
})

describe('assertResultOwner', () => {
  const base = { model: 'Scoped', operation: 'findUnique', tenantId: T }

  it('归属相符时原样返回', () => {
    const record = { id: 'x', tenantId: T }
    expect(assertResultOwner({ ...base, record, throwWhenForeign: false })).toBe(record)
  })

  it('归属不符且不抛错时返回 null', () => {
    expect(
      assertResultOwner({ ...base, record: { id: 'x', tenantId: OTHER }, throwWhenForeign: false }),
    ).toBeNull()
  })

  it('归属不符且要求抛错时抛 FOREIGN_RESULT', () => {
    try {
      assertResultOwner({ ...base, record: { tenantId: OTHER }, throwWhenForeign: true })
      throw new Error('应该抛错')
    } catch (error) {
      expect(isTenantScopeError(error, 'FOREIGN_RESULT')).toBe(true)
    }
  })

  it('记录为 null / undefined 时返回 null，不抛错', () => {
    expect(assertResultOwner({ ...base, record: null, throwWhenForeign: true })).toBeNull()
    expect(assertResultOwner({ ...base, record: undefined, throwWhenForeign: true })).toBeNull()
  })

  it('读不到 tenantId 时失败关闭：判为不属于本租户', () => {
    expect(assertResultOwner({ ...base, record: { id: 'x' }, throwWhenForeign: false })).toBeNull()
    expect(() =>
      assertResultOwner({ ...base, record: { id: 'x' }, throwWhenForeign: true }),
    ).toThrow(/读不到 tenantId/)
  })
})

describe('modelToClientKey', () => {
  it('PascalCase 转 camelCase', () => {
    expect(modelToClientKey('ScopedChild')).toBe('scopedChild')
    expect(modelToClientKey('Scoped')).toBe('scoped')
  })

  it('空串不炸', () => {
    expect(modelToClientKey('')).toBe('')
  })
})
