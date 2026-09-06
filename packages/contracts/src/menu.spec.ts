import { describe, expect, it } from 'vitest'

import { defineMenus } from './menu'

describe('defineMenus', () => {
  it('合法的 DIR + children 结构正常注册', () => {
    const MENUS = defineMenus([
      {
        key: 'goods',
        title: '商品',
        icon: 'ShopOutlined',
        type: 'DIR',
        side: 'ADMIN',
        children: [
          {
            key: 'goods.list',
            title: '商品列表',
            path: '/goods',
            componentKey: 'GoodsList',
            permission: 'goods:list',
            featureKey: 'goods',
            sort: 10,
            type: 'MENU',
            side: 'ADMIN',
          },
        ],
      },
    ])
    expect(MENUS[0].key).toBe('goods')
    expect(Object.isFrozen(MENUS)).toBe(true)
  })

  it('DIR 没有 children 时抛出', () => {
    expect(() =>
      defineMenus([{ key: 'empty-dir', title: '空分组', type: 'DIR', side: 'ADMIN' }]),
    ).toThrow(/DIR 必须有至少一个 children/)
  })

  it('DIR 的 children 为空数组时同样抛出', () => {
    expect(() =>
      defineMenus([
        { key: 'empty-dir', title: '空分组', type: 'DIR', side: 'ADMIN', children: [] },
      ]),
    ).toThrow()
  })

  it('全树（跨层级）key 重复时抛出', () => {
    expect(() =>
      defineMenus([
        {
          key: 'goods',
          title: '商品',
          type: 'DIR',
          side: 'ADMIN',
          children: [
            { key: 'goods', title: '重复 key', type: 'MENU', side: 'ADMIN', path: '/goods' },
          ],
        },
      ]),
    ).toThrow(/重复注册/)
  })

  it('同级兄弟节点 key 重复时抛出', () => {
    expect(() =>
      defineMenus([
        { key: 'dup', title: 'A', type: 'MENU', side: 'ADMIN', path: '/a' },
        { key: 'dup', title: 'B', type: 'MENU', side: 'ADMIN', path: '/b' },
      ]),
    ).toThrow(/重复注册/)
  })

  it('MENU/BUTTON 类型携带 children 时抛出', () => {
    expect(() =>
      defineMenus([
        {
          key: 'leaf',
          title: '叶子',
          type: 'MENU',
          side: 'ADMIN',
          path: '/leaf',
          children: [{ key: 'child', title: '不该有我', type: 'MENU', side: 'ADMIN' }],
        },
      ]),
    ).toThrow(/不应有 children/)
  })
})
