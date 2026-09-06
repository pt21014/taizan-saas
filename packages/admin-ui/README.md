# @taizan/admin-ui

`apps/admin` 与 `apps/platform` 共用的后台基座层（蓝图 §5.2）：request（基于
`@taizan/contracts` 的 `createEnvelopeClient`）、session（zustand，唯一真源来自
`/api/admin/auth/bootstrap`）、布局（`AppShell`/`ShopSwitcher`/`UserMenu`/`BreadcrumbBar`）、
登录/选店（`LoginPage`/`ShopChooserPage`）、只读闸门（`ReadonlyBanner`/`useWritable`）、
主题（`TaizanConfigProvider`）。

再加上 T3-2 的三层：服务端菜单 → 路由（`buildRoutes`/`renderMenus`/`defineComponentMap`）、
权限（`usePerm`/`<Perm>`/`withPerm`/`<RequirePermission>`/`<RequireAuth>`）、
CRUD（`useCrudTable`/`useCrudForm`/`<CrudTable>`/`<CrudDrawerForm>`/列工厂）与上传
（`<ImageUpload>`/`<MaterialPicker>`）。

## 装进一个 Vite 应用的三步

**第一步：建 session store 并套上 Provider。**

```tsx
// src/session.ts
import { createSessionStore } from '@taizan/admin-ui'

export const useSession = createSessionStore({
  baseURL: '/api',
  storageKeyPrefix: 'my_admin', // apps/admin 与 apps/platform 用不同前缀，避免互相踩键
})
```

```tsx
// src/main.tsx
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { SessionProvider, TaizanConfigProvider } from '@taizan/admin-ui'
import { useSession } from './session'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <TaizanConfigProvider>
    <SessionProvider store={useSession}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </SessionProvider>
  </TaizanConfigProvider>,
)
```

**第二步：接登录页，成功后拉 `bootstrap()` 并渲染 `<AppShell>`。**

```tsx
// src/App.tsx
import { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { AppShell, LoginPage, useSession } from '@taizan/admin-ui'
import { useSession as useMySession } from './session'

export default function App() {
  const status = useMySession((s) => s.status)
  const token = useMySession((s) => s.token)
  const bootstrap = useMySession((s) => s.bootstrap)

  useEffect(() => {
    if (token && status === 'idle') void bootstrap()
  }, [token, status, bootstrap])

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/*"
        element={
          token ? (
            <AppShell>
              <div>页面内容（T3-2 接完路由后换成 &lt;Outlet /&gt;）</div>
            </AppShell>
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
    </Routes>
  )
}
```

**第三步：需要禁写的地方接 `useWritable()`，账单页本身不接。**

```tsx
import { useWritable } from '@taizan/admin-ui'

function SaveButton() {
  const writable = useWritable()
  return (
    <Button type="primary" disabled={!writable} htmlType="submit">
      保存
    </Button>
  )
}
```

`<AppShell>` 已经内置了 `<ReadonlyBanner>`（套餐到期时顶部横幅 + 「去续费」跳账单页），
以及 401 清态跳登录、`1440301` 弹「去续费」通知——这两条错误码分流内置在
`createSessionStore()` 里，不需要业务侧再接一遍。

## 本地跑 demo

```bash
pnpm -F @taizan/admin-ui demo         # http://localhost:5174，登录页 → 选店 → 壳子
pnpm -F @taizan/admin-ui demo:build   # 验证 demo 能 vite build 成功
```

demo 用一个内嵌的 Vite 中间件 mock 了 `/api/admin/auth/{login,switch,bootstrap}` 与一套
`/api/admin/goods` 的 CRUD，不依赖真实后端。两家店的权限点刻意不同：

- **旗舰店**（店主，`goods:list/write/delete/export`）：商品页有「新增商品」与行内「编辑/删除」；
- **分店**（员工，只有 `goods:list`）：这些按钮**不渲染**，直接敲 `/goods/export` 得到一张
  403 页而不是白屏；控制台里还能看到 `buildRoutes()` 对未登记 `componentKey` 的那条 warn。

切店在右上角 `<ShopSwitcher>`。

## 第四步：把服务端菜单接成路由

```tsx
// src/routes/component-map.ts —— 新增一个页面时前端只改这里 + 写页面本身
import { lazy } from 'react'
import { defineComponentMap } from '@taizan/admin-ui'

export const componentMap = defineComponentMap({
  GoodsList: lazy(() => import('../pages/goods/GoodsListPage')),
})
```

```tsx
// src/App.tsx
const menus = useSession((s) => s.menus)
const routes = useMemo(() => buildRoutes(menus, componentMap, { notFound: NotFoundPage }), [menus])

return useRoutes([
  {
    path: '/login',
    element: <LoginPage config={{ homePath: readReturnTo(location.search) ?? '/' }} />,
  },
  {
    element: (
      <RequireAuth>
        <AppShell>
          <Outlet />
        </AppShell>
      </RequireAuth>
    ),
    children: routes,
  },
])
```

`buildRoutes()` 的四条规则：

| 情况                                                         | 结果                                                                                |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `type: 'MENU'` 且有 `path` 与已登记的 `componentKey`         | 建一条路由                                                                          |
| `type: 'DIR'`（纯分组）/ `type: 'BUTTON'`（按钮权限点）      | 不进路由                                                                            |
| `componentKey` 没登记 / `MENU` 有 `path` 却没 `componentKey` | `console.warn` **并跳过**（不渲染空白页）                                           |
| 任何一条路由                                                 | 都包一层 `<RequirePermission code={node.permission}>`，直达 URL 得到 403 而不是白屏 |

`renderMenus(menus, componentMap)` 用同一套规则生成侧边栏 `items`（`<AppShell>` 已内置）：
菜单里给不出入口的东西，路由里也不会有。

## 一个业务页面的 40 行范式

```tsx
import { Form, Input } from 'antd'
import { CrudDrawerForm, CrudTable, useCrudForm, useCrudTable } from '@taizan/admin-ui'
import { useGoodsApi, type Goods, type GoodsInput } from '../api/goods'

export default function GoodsListPage() {
  const api = useGoodsApi()
  const table = useCrudTable<Goods>({
    list: api.list,
    remove: api.remove,
    rowKey: 'id',
    searchSchema: [{ name: 'keyword', label: '名称' }],
  })
  const form = useCrudForm<GoodsInput>({
    get: api.get,
    create: api.create,
    update: api.update,
    onSuccess: table.refresh,
  })
  return (
    <>
      <CrudTable
        table={table}
        title="商品"
        create={{ label: '新增商品', perm: 'goods:write', onClick: () => form.openForm() }}
        columns={[
          { title: '名称', dataIndex: 'name', key: 'name' },
          { title: '价格（分）', dataIndex: 'priceCents', key: 'priceCents' },
        ]}
        actions={[
          { key: 'edit', label: '编辑', perm: 'goods:write', onClick: (r) => form.openForm(r.id) },
          { key: 'del', label: '删除', perm: 'goods:delete', onClick: table.removeRow },
        ]}
      />
      <CrudDrawerForm form={form} title="商品">
        <Form.Item name="name" label="名称" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
      </CrudDrawerForm>
    </>
  )
}
```

上面这 41 行（含 import）里已经包含：分页、搜索、排序、按钮级权限（`create.perm` 与行操作的
`perm` 内部就是 `<Perm>`）、删除确认、新建/编辑两态与回填、提交态、`1440301`/`1540301`
的错误码分流、只读态自动禁用提交。**页面里没有一行 `useState`**，也没有一行 `useEffect`。

接口层 `api/goods.ts` 是配套的五个函数（`list/get/create/update/remove`），
写法见 `demo/src/goods-api.ts`。跑得起来的完整版是 `demo/src/pages/GoodsListPage.tsx`
（57 行：多了状态 Tag 列、时间列、金额列、`syncUrl` 与第二个表单字段）。

三件事按需自取，不是必须的：

- 批量操作：`<CrudTable selectable batchToolbar={(keys) => ...}>`；
- 顶部工具栏（导出、批量导入）：`toolbar={<Perm code="goods:export"><Button>导出</Button></Perm>}`；
- 常用列工厂：`moneyColumn`（分→元，右对齐等宽）、`dateTimeColumn`、`enumColumn`、
  `statusTagColumn`、`textColumn`（省略 + 复制，ID 列用它）、`indexColumn`。

## component-map 与后端菜单 componentKey 的对账（蓝图 §8 spec 7）

`componentKey` 是后端菜单注册表与前端映射表之间**唯一**的连接点，两边靠肉眼对齐。
漏一个的表现是「菜单点进去白屏，控制台一句话都没有」——这种 bug 只会由用户报上来。
所以两道防线都要有：

**① 运行期**：`buildRoutes()` / `renderMenus()` 遇到没登记的 key 会 `console.warn` 并跳过
（同一个 key 只 warn 一次）。跳过而不是渲染空组件——少一条路由至少会落到兜底 404。

**② 测试期**：`verifyComponentMap(menus, componentMap)` 做**双向**对账。

```ts
// apps/admin/src/routes/component-map.spec.ts
import { verifyComponentMap, describeComponentMapReport } from '@taizan/admin-ui'
import { ADMIN_MENUS } from '../../../api/src/registry/menus' // 或 bootstrap 响应的快照
import { componentMap } from './component-map'

it('spec 7：菜单 componentKey 与 component-map 双向对齐', () => {
  const report = verifyComponentMap(ADMIN_MENUS, componentMap)
  expect(describeComponentMapReport(report)).toBe('componentKey 双向对齐')
})
```

返回的三项都要为空：

| 字段                      | 含义                                 | 漏了会怎样                             |
| ------------------------- | ------------------------------------ | -------------------------------------- |
| `missing`                 | 菜单引用了、映射表里没有             | 菜单点进去白屏                         |
| `unused`                  | 映射表登记了、没有菜单引用           | 死代码；或者菜单漏注册，页面永远进不去 |
| `pathWithoutComponentKey` | `MENU` 有 `path` 却没 `componentKey` | 同样白屏                               |

**本阶段的真源交接**：`apps/api/src/registry/component-keys.ts` 里那份手写 key 清单是
**临时**真源（它自己的注释里写了「将来会被删掉」）——写它的时候 `apps/admin` 还不存在，
spec 7 没有比对对象。现在有了：

1. 在 `apps/admin` / `apps/platform` 各加一条上面那样的 spec，`menus` 一侧取
   `apps/api/src/registry/menus.ts` 里对应 `side` 的注册表（`ADMIN` / `PLATFORM`）；
2. 把 `apps/api/test/arch/menu-route-map.spec.ts` 改成扫这两份 `component-map.ts`；
3. 删掉 `apps/api/src/registry/component-keys.ts`。

第 3 步是关键：那份清单留着，就永远有人只更新它而不更新前端，spec 7 会一直是绿的假象。
