import { describe, expect, it } from 'vitest'
import { isOptimisticLockError, OptimisticLockError } from '../errors'
import { createFakePrisma } from '../testing/fake-prisma-client'
import { updateWithVersion } from './optimistic-lock'

describe('updateWithVersion', () => {
  it('⑧ where 带上 version、data 带上 increment，命中 1 行时返回新版本号', async () => {
    const { client, controls } = createFakePrisma()
    controls.on('Goods', 'updateMany', { count: 1 })

    const result = await updateWithVersion(client, 'Goods', {
      where: { id: 'g1' },
      expectedVersion: 3,
      data: { name: '新名字' },
    })

    expect(result).toEqual({ version: 4 })
    expect(controls.callsOf('Goods', 'updateMany')[0]?.args).toEqual({
      where: { id: 'g1', version: 3 },
      data: { name: '新名字', version: { increment: 1 } },
    })
  })

  it('⑧ 命中 0 行时抛 OptimisticLockError，并带上模型与期望版本', async () => {
    const { client, controls } = createFakePrisma()
    controls.on('Goods', 'updateMany', { count: 0 })

    const promise = updateWithVersion(client, 'Goods', {
      where: { id: 'g1' },
      expectedVersion: 3,
      data: { name: 'x' },
    })

    await expect(promise).rejects.toBeInstanceOf(OptimisticLockError)
    await promise.catch((error: unknown) => {
      expect(isOptimisticLockError(error)).toBe(true)
      expect((error as OptimisticLockError).context).toEqual({
        model: 'Goods',
        expectedVersion: 3,
      })
    })
  })

  it('⑧ 返回值形状不对（拿不到 count）时按冲突处理，不静默当成功', async () => {
    const { client, controls } = createFakePrisma()
    controls.on('Goods', 'updateMany', undefined)

    await expect(
      updateWithVersion(client, 'Goods', { where: { id: 'g1' }, expectedVersion: 1, data: {} }),
    ).rejects.toBeInstanceOf(OptimisticLockError)
  })

  it('⑧ 支持自定义版本列名', async () => {
    const { client, controls } = createFakePrisma()
    controls.on('Goods', 'updateMany', { count: 1 })

    await updateWithVersion(client, 'Goods', {
      where: { id: 'g1' },
      expectedVersion: 0,
      data: {},
      versionField: 'rev',
    })

    expect(controls.callsOf('Goods', 'updateMany')[0]?.args).toEqual({
      where: { id: 'g1', rev: 0 },
      data: { rev: { increment: 1 } },
    })
  })

  it('⑧ expectedVersion 不是整数时立刻抛 TypeError（而不是发一条永远命中 0 行的 SQL）', async () => {
    const { client } = createFakePrisma()

    await expect(
      updateWithVersion(client, 'Goods', {
        where: { id: 'g1' },
        expectedVersion: Number.NaN,
        data: {},
      }),
    ).rejects.toBeInstanceOf(TypeError)
  })
})
