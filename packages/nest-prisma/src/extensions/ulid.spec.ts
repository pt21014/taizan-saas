import { describe, expect, it } from 'vitest'
import { isUlid } from '@taizan/contracts'
import { createFakePrisma, modelOf, type FakePrismaClient } from '../testing/fake-prisma-client'
import { createUlidExtension } from './ulid'

function setup(hasStringId?: (model: string) => boolean): {
  client: FakePrismaClient
  controls: ReturnType<typeof createFakePrisma>['controls']
} {
  const { client: base, controls } = createFakePrisma()
  return { client: base.$extends(createUlidExtension({ hasStringId })), controls }
}

/** 取出这次调用真正写进 `data` 的 id。 */
function idOf(args: unknown): unknown {
  return (args as { data?: { id?: unknown } }).data?.id
}

describe('createUlidExtension', () => {
  it('⑦ create 没给 id 时自动填 26 位 ULID', async () => {
    const { client, controls } = setup()

    await modelOf(client, 'goods').create({ data: { name: 'x' } })

    const id = idOf(controls.callsOf('Goods', 'create')[0]?.args)
    expect(typeof id).toBe('string')
    expect(id as string).toHaveLength(26)
    expect(isUlid(id as string)).toBe(true)
  })

  it('⑦ 调用方给了 id 就不覆盖', async () => {
    const { client, controls } = setup()

    await modelOf(client, 'goods').create({ data: { id: '手写的id', name: 'x' } })

    expect(idOf(controls.callsOf('Goods', 'create')[0]?.args)).toBe('手写的id')
  })

  it('⑦ 显式写 id: undefined 也不覆盖（那是「让数据库默认值生效」的意思）', async () => {
    const { client, controls } = setup()

    await modelOf(client, 'goods').create({ data: { id: undefined, name: 'x' } })

    expect(idOf(controls.callsOf('Goods', 'create')[0]?.args)).toBeUndefined()
  })

  it('⑦ createMany 的每一行都单独填，且互不相同', async () => {
    const { client, controls } = setup()

    await modelOf(client, 'goods').createMany({ data: [{ name: 'a' }, { name: 'b', id: '固定' }] })

    const rows = (controls.callsOf('Goods', 'createMany')[0]?.args as { data: { id: string }[] })
      .data
    expect(isUlid(rows[0]?.id ?? '')).toBe(true)
    expect(rows[1]?.id).toBe('固定')
  })

  it('⑦ upsert 只填 create 分支，不碰 update 分支', async () => {
    const { client, controls } = setup()

    await modelOf(client, 'goods').upsert({
      where: { id: 'g1' },
      create: { name: 'a' },
      update: { name: 'b' },
    })

    const args = controls.callsOf('Goods', 'upsert')[0]?.args as {
      create: { id?: string }
      update: Record<string, unknown>
    }
    expect(isUlid(args.create.id ?? '')).toBe(true)
    expect(args.update).toEqual({ name: 'b' })
  })

  it('⑦ hasStringId 返回 false 的模型完全不碰（遗留自增主键表）', async () => {
    const { client, controls } = setup((model) => model !== 'LegacyCounter')

    await modelOf(client, 'legacyCounter').create({ data: { hits: 1 } })

    expect(controls.callsOf('LegacyCounter', 'create')[0]?.args).toEqual({ data: { hits: 1 } })
  })

  it('⑦ 读操作原样透传', async () => {
    const { client, controls } = setup()

    await modelOf(client, 'goods').findMany({ where: { name: 'x' } })

    expect(controls.callsOf('Goods', 'findMany')[0]?.args).toEqual({ where: { name: 'x' } })
  })
})
