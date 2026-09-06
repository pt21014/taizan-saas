import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createFakePrisma, modelOf, type FakePrismaClient } from '../testing/fake-prisma-client'
import { createSoftDeleteExtension, hardDelete, hardDeleteMany } from './soft-delete'

const NOW = new Date('2026-01-02T03:04:05.000Z')
const MODELS = new Set(['Goods'])

function setup(): {
  base: FakePrismaClient
  client: FakePrismaClient
  controls: ReturnType<typeof createFakePrisma>['controls']
} {
  const { client: base, controls } = createFakePrisma()
  const client = base.$extends(createSoftDeleteExtension(MODELS, { now: () => NOW }))
  return { base, client, controls }
}

describe('createSoftDeleteExtension', () => {
  it('⑤ delete 被改写成 update{ deletedAt }，物理 delete 一次都没发出去', async () => {
    const { client, controls } = setup()

    await modelOf(client, 'goods').delete({ where: { id: 'g1' } })

    expect(controls.callsOf('Goods', 'delete')).toHaveLength(0)
    expect(controls.callsOf('Goods', 'update')[0]?.args).toEqual({
      where: { id: 'g1' },
      data: { deletedAt: NOW },
    })
  })

  it('⑤ deleteMany 被改写成 updateMany，且不重复盖已软删记录的时间戳', async () => {
    const { client, controls } = setup()

    await modelOf(client, 'goods').deleteMany({ where: { categoryId: 'c1' } })

    expect(controls.callsOf('Goods', 'deleteMany')).toHaveLength(0)
    expect(controls.callsOf('Goods', 'updateMany')[0]?.args).toEqual({
      where: { AND: [{ deletedAt: null }, { categoryId: 'c1' }] },
      data: { deletedAt: NOW },
    })
  })

  it('⑤ 不在软删名单里的模型，delete 原样物理删除', async () => {
    const { client, controls } = setup()

    await modelOf(client, 'jobLog').delete({ where: { id: 'j1' } })

    expect(controls.callsOf('JobLog', 'delete')).toHaveLength(1)
    expect(controls.callsOf('JobLog', 'update')).toHaveLength(0)
  })

  it('⑥ findMany 自动补 deletedAt: null（AND 包裹，不改调用方的 where 对象）', async () => {
    const { client, controls } = setup()
    const callerWhere = { name: 'x' }

    await modelOf(client, 'goods').findMany({ where: callerWhere })

    expect(controls.callsOf('Goods', 'findMany')[0]?.args).toEqual({
      where: { AND: [{ deletedAt: null }, { name: 'x' }] },
    })
    // 反面教材是就地改 args.where；这里必须证明调用方的对象没被动过。
    expect(callerWhere).toEqual({ name: 'x' })
  })

  it('⑥ count / aggregate / groupBy / findFirst 都会被过滤', async () => {
    const { client, controls } = setup()

    await modelOf(client, 'goods').count()
    await modelOf(client, 'goods').aggregate({ _count: true })
    await modelOf(client, 'goods').groupBy({ by: ['categoryId'] })
    await modelOf(client, 'goods').findFirst()

    for (const operation of ['count', 'aggregate', 'groupBy', 'findFirst']) {
      const args = controls.callsOf('Goods', operation)[0]?.args as { where?: unknown }
      expect(args.where).toEqual({ AND: [{ deletedAt: null }, {}] })
    }
  })

  it('⑥ findUnique 用平铺合并而不是 AND（唯一键 where 不接受顶层 AND）', async () => {
    const { client, controls } = setup()

    await modelOf(client, 'goods').findUnique({ where: { id: 'g1' } })

    expect(controls.callsOf('Goods', 'findUnique')[0]?.args).toEqual({
      where: { id: 'g1', deletedAt: null },
    })
  })

  it('⑥ withDeleted: true 时不加过滤，而且这个非 Prisma 参数不会透传下去', async () => {
    const { client, controls } = setup()

    await modelOf(client, 'goods').findMany({ where: { name: 'x' }, withDeleted: true })

    const args = controls.callsOf('Goods', 'findMany')[0]?.args
    expect(args).toEqual({ where: { name: 'x' } })
    expect(Object.keys(args as object)).not.toContain('withDeleted')
  })

  it('⑥ withDeleted 即使落在不受软删管的模型上，也一样被剥掉', async () => {
    const { client, controls } = setup()

    await modelOf(client, 'jobLog').findMany({ withDeleted: true })

    expect(controls.callsOf('JobLog', 'findMany')[0]?.args).toEqual({})
  })

  it('⑥ 写操作（create / update）不受读过滤影响', async () => {
    const { client, controls } = setup()

    await modelOf(client, 'goods').create({ data: { name: 'x' } })
    await modelOf(client, 'goods').update({ where: { id: 'g1' }, data: { name: 'y' } })

    expect(controls.callsOf('Goods', 'create')[0]?.args).toEqual({ data: { name: 'x' } })
    expect(controls.callsOf('Goods', 'update')[0]?.args).toEqual({
      where: { id: 'g1' },
      data: { name: 'y' },
    })
  })

  it('hardDelete 走原始客户端，绕过软删改写', async () => {
    const { base, controls } = setup()

    await hardDelete(base, 'Goods', { where: { id: 'g1' } })
    await hardDeleteMany(base, 'Goods', { where: { id: { in: ['g2'] } } })

    expect(controls.callsOf('Goods', 'delete')).toHaveLength(1)
    expect(controls.callsOf('Goods', 'deleteMany')).toHaveLength(1)
  })
})

describe('写路径必须是 model 组件（事务安全的回归守卫）', () => {
  /**
   * T0-8 的隔离 e2e 用例⑪在真库上抓到过这个 bug：`delete` 曾经用
   * `defineClientBoundQueryExtension` 实现——在 `$extends` 那一刻捕获客户端引用，
   * 之后回头往它发 `update`。而 `$transaction()` 会另建一个绑在事务连接上的客户端，
   * **不会重新调用那个工厂**，于是改写出来的 `update` 发到了事务之外：
   * 事务回滚了，软删却留下了。
   *
   * 单测环境里的替身客户端没有真事务，证明不了这件事（它的 `$transaction` 就是
   * 把同一个客户端交回去）。所以这里退一步守**实现形态**：只要写路径还是
   * 「model 组件 + `Prisma.getExtensionContext`」，事务安全就成立。
   * 真正的行为验收在 `apps/api/test/tenant-isolation.e2e-spec.ts` 的用例⑪。
   */
  const source = readFileSync(
    join(fileURLToPath(new URL('.', import.meta.url)), 'soft-delete.ts'),
    'utf8',
  )

  it('不再**调用** defineClientBoundQueryExtension（它捕获的客户端引用不跟事务走）', () => {
    // 文件头的说明里会提到这个名字（讲清楚为什么换掉），所以只查调用点，不查全文。
    expect(source).not.toMatch(/defineClientBoundQueryExtension\s*\(/)
    expect(source).not.toMatch(/import[^\n]*defineClientBoundQueryExtension/)
  })

  it('用 model 组件 + 扩展上下文实现 delete / deleteMany', () => {
    expect(source).toContain('defineModelAndQueryExtension')
    expect(source).toContain('extensionContext(this)')
  })

  it('透传分支走 $parent，而不是捕获来的客户端', () => {
    expect(source).toContain('$parent')
  })
})
