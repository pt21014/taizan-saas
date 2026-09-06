/**
 * 蓝图 §7 扩展点④ **注册菜单**：模块内定义，`src/registry/menus.ts` 汇总。
 *
 * 每个 `MENU` 节点带两个裁剪依据：
 * - `permission`：这个人的角色里有没有这个权限点；
 * - `featureKey`：这家店的套餐里有没有这个功能项。
 *
 * 两者是「与」的关系，缺一个菜单就不下发。`componentKey` 只是一个 key，
 * 服务端不知道也不该知道前端的文件路径——`apps/admin/src/routes/component-map.ts`
 * 负责把 key 映射到组件，由 `menu-route-map.spec.ts`（spec 7，T1-2）双向比对。
 *
 * @packageDocumentation
 */

import { type MenuDef } from '@taizan/contracts'

/** 商品模块的菜单。 */
export const GOODS_MENUS: readonly MenuDef[] = [
  {
    key: 'goods',
    title: '商品',
    icon: 'ShopOutlined',
    type: 'DIR',
    side: 'ADMIN',
    sort: 20,
    children: [
      {
        key: 'goods.list',
        title: '商品列表',
        path: '/goods',
        componentKey: 'GoodsList',
        type: 'MENU',
        side: 'ADMIN',
        permission: 'goods:list',
        featureKey: 'goods',
        sort: 10,
      },
      {
        // 按钮级菜单项：前端据它决定「新增商品」这个按钮画不画。
        //
        // 它是 `goods` 目录的**兄弟节点**而不是 `goods.list` 的子节点——
        // `defineMenus()` 明令「非 DIR 类型不能有 children」（一个 MENU 挂子节点，
        // 前端渲染成什么谁也说不清）。所以按钮和它所在的页面在树上是平级的，
        // 靠 key 的前缀（`goods.*`）表达归属。
        //
        // 有了它，「只有 goods:list 的员工」和「店主」拿到的菜单树才**真的不一样**，
        // 否则权限裁剪这件事在 bootstrap 的下发结果上完全看不出来。
        key: 'goods.create',
        title: '新增商品',
        type: 'BUTTON',
        side: 'ADMIN',
        permission: 'goods:write',
        featureKey: 'goods',
        sort: 20,
      },
    ],
  },
]
