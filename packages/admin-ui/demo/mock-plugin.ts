import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { ErrorCode } from '@taizan/contracts'

/**
 * demo 用的最小 mock 后端：一个 Vite 中间件，拦截 `/api/admin/*`，不依赖真实
 * `apps/api`。演示账号 `13900000001` / `demo1234`，名下两家店（会先走选店页），
 * 覆盖蓝图 §4.4 的 bootstrap 下发协议形状 + 一套 example-goods 的 CRUD 接口。
 *
 * 两家店的权限点刻意不同，用来演示权限层的两个方向：
 * - **旗舰店**（店主）：`goods:list/write/delete/export` 全有；
 * - **分店**（员工）：只有 `goods:list`——「新增商品」按钮不渲染（`<Perm>`），
 *   直接敲 `/goods/export` 得到 403（`<RequirePermission>`）而不是白屏。
 */

interface ShopFixture {
  tenantId: string
  name: string
  slug: string
  isOwner: boolean
  permissions: string[]
}

const SHOPS: ShopFixture[] = [
  {
    tenantId: 't1',
    name: '旗舰店',
    slug: 'flagship',
    isOwner: true,
    permissions: ['goods:list', 'goods:write', 'goods:delete', 'goods:export'],
  },
  { tenantId: 't2', name: '分店', slug: 'branch', isOwner: false, permissions: ['goods:list'] },
]

const DEMO_PHONE = '13900000001'
const DEMO_PASSWORD = 'demo1234'

interface GoodsRow {
  id: string
  name: string
  priceCents: number
  status: 'ON' | 'OFF'
  createdAt: string
}

// process-local: demo 的假数据库，只在 dev server 进程里活着，重启即清空。
const GOODS = new Map<string, GoodsRow>()
let goodsSeq = 0

function seedGoods(): void {
  if (GOODS.size > 0) return
  const names = ['冰美式', '生椰拿铁', '燕麦拿铁', '澳白', '手冲耶加', '桂花龙井', '柠檬茶']
  names.forEach((name, i) => {
    const id = `g${++goodsSeq}`
    GOODS.set(id, {
      id,
      name,
      priceCents: 1200 + i * 300,
      status: i % 3 === 0 ? 'OFF' : 'ON',
      createdAt: new Date(Date.now() - i * 86_400_000).toISOString(),
    })
  })
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf-8')))
    req.on('end', () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {})
      } catch (err) {
        reject(err as Error)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('X-Trace-Id', `demo-trace-${Date.now()}`)
  res.end(JSON.stringify(body))
}

function envelope(data: unknown) {
  return { code: 0, message: 'OK', data }
}

function loginResult(tenantId: string) {
  return {
    needChooseShop: false,
    access: `demo-token-${tenantId}`,
    refresh: 'demo-refresh',
    expiresIn: 3600,
    staffId: `staff-${tenantId}`,
    tenantId,
    shops: SHOPS,
  }
}

/**
 * 菜单树。真实后端会按 权限 ∩ 套餐 features ∩ 显式禁用 裁剪后再下发；
 * 这里**刻意不裁** `goods.export`，好让「分店」这个身份能演示直达 URL 的 403 兜底
 * （真实场景是：菜单裁掉了，但用户存了书签 / 同事发了链接）。
 *
 * `permission` 是 `MenuNode` 契约之外多带的一个字段——`buildRoutes()` 会拿它包
 * `<RequirePermission>`；后端不带这个字段时路由照样能建，只是直达 URL 会落 404。
 */
function menusFor() {
  return [
    {
      key: 'dashboard',
      title: '工作台',
      icon: 'DashboardOutlined',
      path: '/',
      componentKey: 'Dashboard',
      type: 'MENU',
      sort: 0,
    },
    {
      key: 'goods',
      title: '商品',
      icon: 'ShopOutlined',
      type: 'DIR',
      sort: 10,
      children: [
        {
          key: 'goods.list',
          title: '商品列表',
          path: '/goods',
          componentKey: 'GoodsList',
          permission: 'goods:list',
          type: 'MENU',
          sort: 10,
        },
        {
          key: 'goods.export',
          title: '导出商品',
          path: '/goods/export',
          componentKey: 'GoodsExport',
          permission: 'goods:export',
          type: 'MENU',
          sort: 20,
        },
        // BUTTON 节点只承载按钮级权限点，既不进侧边栏也不进路由
        { key: 'goods.write.btn', title: '新增商品', type: 'BUTTON', sort: 30 },
      ],
    },
    {
      key: 'billing',
      title: '账单与套餐',
      icon: 'AccountBookOutlined',
      path: '/billing',
      componentKey: 'Billing',
      type: 'MENU',
      sort: 90,
    },
    // 故意留一个前端没登记的 componentKey：启动后看控制台，buildRoutes() 会 warn 并跳过它
    {
      key: 'legacy',
      title: '老页面（未登记组件）',
      path: '/legacy',
      componentKey: 'NotRegistered',
      type: 'MENU',
      sort: 99,
    },
  ]
}

function bootstrapFor(tenantId: string) {
  const shop = SHOPS.find((s) => s.tenantId === tenantId) ?? (SHOPS[0] as ShopFixture)
  return {
    identity: {
      staffId: `staff-${tenantId}`,
      accountId: 'acc-1',
      name: shop.isOwner ? '演示店主' : '演示员工',
      isOwner: shop.isOwner,
    },
    tenant: {
      id: shop.tenantId,
      slug: shop.slug,
      name: shop.name,
      status: 'ACTIVE',
      planExpireAt: null,
      readonly: false,
      features: null,
    },
    shops: SHOPS.map((s) => ({ tenantId: s.tenantId, name: s.name, slug: s.slug })),
    permissions: shop.permissions,
    menus: menusFor(),
    quotas: { staff: { used: 2, limit: 10 } },
  }
}

function listGoods(url: URL) {
  const page = Number(url.searchParams.get('page') ?? '1')
  const pageSize = Number(url.searchParams.get('pageSize') ?? '20')
  const keyword = url.searchParams.get('keyword')
  const status = url.searchParams.get('status')
  const sortBy = url.searchParams.get('sortBy')
  const sortOrder = url.searchParams.get('sortOrder')

  let items = [...GOODS.values()]
  if (keyword) items = items.filter((it) => it.name.includes(keyword))
  if (status) items = items.filter((it) => it.status === status)
  if (sortBy === 'priceCents') {
    items.sort((a, b) =>
      sortOrder === 'desc' ? b.priceCents - a.priceCents : a.priceCents - b.priceCents,
    )
  }
  const total = items.length
  return { items: items.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize }
}

export function mockAdminApi(): Plugin {
  return {
    name: 'taizan-admin-ui-demo-mock',
    configureServer(server) {
      seedGoods()
      server.middlewares.use((req, res, next) => {
        const rawUrl = req.url ?? ''
        if (!rawUrl.startsWith('/api/admin/')) {
          next()
          return
        }
        const url = new URL(rawUrl, 'http://demo.local')
        const path = url.pathname

        void (async () => {
          try {
            if (req.method === 'POST' && path === '/api/admin/auth/login') {
              const body = await readBody(req)
              if (body.phone !== DEMO_PHONE || body.password !== DEMO_PASSWORD) {
                // 1040000：@taizan/contracts 的 ErrorCode.BAD_REQUEST，httpSemantic===400 走 onBizError
                sendJson(res, 200, { code: 1040000, message: '手机号或密码不正确', data: null })
                return
              }
              const tenantId = body.tenantId as string | undefined
              if (!tenantId) {
                sendJson(res, 200, envelope({ needChooseShop: true, shops: SHOPS }))
                return
              }
              sendJson(res, 200, envelope(loginResult(tenantId)))
              return
            }

            if (req.method === 'POST' && path === '/api/admin/auth/switch') {
              if (!req.headers.authorization) {
                sendJson(res, 401, { code: 1140100, message: '未登录', data: null })
                return
              }
              const body = await readBody(req)
              sendJson(res, 200, envelope(loginResult(body.tenantId as string)))
              return
            }

            const match = /demo-token-(\w+)/.exec(req.headers.authorization ?? '')
            if (!match) {
              sendJson(res, 401, { code: 1140100, message: '未登录', data: null })
              return
            }
            const shop = SHOPS.find((s) => s.tenantId === match[1]) ?? (SHOPS[0] as ShopFixture)

            if (req.method === 'GET' && path === '/api/admin/auth/bootstrap') {
              sendJson(res, 200, envelope(bootstrapFor(shop.tenantId)))
              return
            }

            // ── example-goods CRUD ────────────────────────────────────────
            // 后端守卫是真正的安全边界：前端藏了按钮，接口这里照样要拒。
            const need = (code: string): boolean => {
              if (shop.permissions.includes(code)) return true
              sendJson(res, 200, {
                code: ErrorCode.RBAC_FORBIDDEN.code,
                message: `无权限（需要 ${code}）`,
                data: null,
              })
              return false
            }

            if (path === '/api/admin/goods') {
              if (req.method === 'GET') {
                if (!need('goods:list')) return
                sendJson(res, 200, envelope(listGoods(url)))
                return
              }
              if (req.method === 'POST') {
                if (!need('goods:write')) return
                const body = await readBody(req)
                const id = `g${++goodsSeq}`
                GOODS.set(id, {
                  id,
                  name: String(body.name ?? '未命名'),
                  priceCents: Number(body.priceCents ?? 0),
                  status: 'ON',
                  createdAt: new Date().toISOString(),
                })
                sendJson(res, 200, envelope({ id }))
                return
              }
            }

            const idMatch = /^\/api\/admin\/goods\/([\w-]+)$/.exec(path)
            if (idMatch) {
              const id = idMatch[1] as string
              const row = GOODS.get(id)
              if (!row) {
                sendJson(res, 200, { code: 1040400, message: '商品不存在', data: null })
                return
              }
              if (req.method === 'GET') {
                if (!need('goods:list')) return
                sendJson(res, 200, envelope(row))
                return
              }
              if (req.method === 'PUT') {
                if (!need('goods:write')) return
                const body = await readBody(req)
                GOODS.set(id, {
                  ...row,
                  name: String(body.name ?? row.name),
                  priceCents: Number(body.priceCents ?? row.priceCents),
                })
                sendJson(res, 200, envelope({ id }))
                return
              }
              if (req.method === 'DELETE') {
                if (!need('goods:delete')) return
                GOODS.delete(id)
                sendJson(res, 200, envelope({ id }))
                return
              }
            }

            next()
          } catch (err) {
            sendJson(res, 500, { code: 9050000, message: (err as Error).message, data: null })
          }
        })()
      })
    },
  }
}
