/**
 * codegen 的单测：在临时目录里搭一个**最小的假项目**（只有七个锚点文件），
 * 跑 `generateModule`，然后逐条断言蓝图 §7 的七件事都做了。
 *
 * ## 为什么用假项目而不是真项目
 *
 * 真项目要装依赖、要 Prisma client、要几分钟。而这份 spec 想守的是**另一件事**：
 * 「七处注册有没有全都插进去、锚点找不到时会不会静默跳过、重跑一次会不会插两遍」。
 * 这三件事只需要文本，不需要能编译。
 *
 * 「生成出来的代码真的能编译、真的过 arch spec」由 `pnpm create:demo` 之后手工跑一次
 * `pnpm gen:module demo-item && pnpm test:arch` 验收——那是另一个量级的测试，
 * 不该塞进 `pnpm test`。
 *
 * @packageDocumentation
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { generateModule } from '../src/generate'
import { deriveNames } from '../src/naming'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/**
 * 搭一个最小假项目：**只放 codegen 会去插入的那几个锚点文件**，
 * 每份都保留真实文件里的锚点行形状。
 *
 * 少放一行就会让某条插入失效——这正是想测的：锚点不在就该抛，不该悄悄跳过。
 */
function fakeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'taizan-codegen-'))
  dirs.push(root)
  const write = (rel: string, text: string): void => {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, text, 'utf8')
  }

  write(
    'apps/api/package.json',
    JSON.stringify(
      {
        name: '@demo/api',
        scripts: {
          'taizan:verify-schema': 'taizan-verify-schema prisma/schema --registered=Goods,GoodsSku',
        },
      },
      null,
      2,
    ),
  )

  write('apps/api/prisma/schema/10-business/10-goods.prisma', 'model Goods {}\n')

  write(
    'apps/api/src/tenancy/tenant-models.ts',
    [
      "import { createBaseRegistry } from '@taizan/prisma-base'",
      '',
      'export const registry = createBaseRegistry()',
      '',
      "registry.register(['Goods', 'GoodsSku'])",
      '',
      'export const TENANT_MODELS = registry.freeze()',
      '',
      'export const SOFT_DELETE_MODELS: ReadonlySet<string> = new Set([',
      "  'Staff',",
      "  'Goods',",
      '])',
      '',
    ].join('\n'),
  )

  write(
    'apps/api/src/registry/permissions.ts',
    [
      "import { definePermissions } from '@taizan/contracts'",
      '',
      "import { GOODS_PERMISSIONS } from '../modules/example-goods/goods.permissions'",
      '',
      'export const PERMISSIONS = Object.freeze({',
      '  ...GOODS_PERMISSIONS,',
      '})',
      '',
      'function assertNoDuplicateCodes(): void {',
      '  const sources = [',
      "    ['example-goods', GOODS_PERMISSIONS],",
      '  ]',
      '  void sources',
      '}',
      'assertNoDuplicateCodes()',
      '',
    ].join('\n'),
  )

  write(
    'apps/api/src/registry/menus.ts',
    [
      "import { defineMenus } from '@taizan/contracts'",
      '',
      "import { GOODS_MENUS } from '../modules/example-goods/goods.menus'",
      '',
      'const ADMIN_FRAMEWORK_MENUS = []',
      '',
      'export const ADMIN_MENUS = defineMenus([',
      '  ...ADMIN_FRAMEWORK_MENUS,',
      '  ...GOODS_MENUS,',
      '])',
      '',
    ].join('\n'),
  )

  write(
    'apps/api/src/registry/features.ts',
    [
      'export const FEATURES = [',
      '  {',
      "    key: 'goods',",
      '    writeOnly: true,',
      "    pathPrefixes: ['/api/admin/goods'],",
      '  },',
      ']',
      '',
    ].join('\n'),
  )

  write(
    'apps/api/src/registry/audit-actions.ts',
    [
      "import { defineAuditActions } from '@taizan/nest-audit'",
      '',
      'export const APP_AUDIT_ACTIONS = defineAuditActions({',
      "  GOODS_CREATE: 'goods.create',",
      '})',
      '',
    ].join('\n'),
  )

  write(
    'apps/api/src/registry/jobs.ts',
    [
      "import { GOODS_SYNC_JOB_NAME } from '../modules/example-goods/goods-sync.handler'",
      '',
      'export const JOBS = [',
      '  {',
      '    name: GOODS_SYNC_JOB_NAME,',
      '    queue: GOODS_SYNC_JOB_NAME,',
      "    title: '商品同步',",
      '  },',
      ']',
      '',
    ].join('\n'),
  )

  write(
    'apps/api/src/bootstrap/app.module.ts',
    [
      "import { Module } from '@nestjs/common'",
      '',
      "import { GoodsModule } from '../modules/example-goods/goods.module'",
      '',
      '@Module({',
      '  imports: [',
      '    GoodsModule,',
      '  ],',
      '})',
      'export class AppModule {}',
      '',
    ].join('\n'),
  )

  write(
    'apps/admin/src/routes/component-map.ts',
    [
      "import { lazy } from 'react'",
      "import { defineComponentMap } from '@taizan/admin-ui'",
      '',
      'export const componentMap = defineComponentMap({',
      "  GoodsList: lazy(() => import('../pages/goods/GoodsListPage')),",
      '})',
      '',
    ].join('\n'),
  )

  return root
}

const read = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf8')

/**
 * 只留代码，剥掉注释。
 *
 * 断言「生成的代码里没有 X」时必须先剥注释：模板的注释里**恰恰在解释**为什么不用 X
 * （「禁用 Decimal」「没有 @Public() 所以默认拒绝」）。不剥的话这些 spec 会被自己的
 * 文档卡住，而人的反应通常是把断言删掉。
 */
function code(root: string, rel: string): string {
  return read(root, rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

describe('命名派生', () => {
  it('一个 slug 定下之后，其余名字全部是算出来的', () => {
    expect(deriveNames('sales-order', '销售单')).toMatchObject({
      Pascal: 'SalesOrder',
      camel: 'salesOrder',
      CONST: 'SALES_ORDER',
      componentKey: 'SalesOrderList',
    })
  })

  it('拒绝非 kebab-case，而不是「帮你改成」kebab-case', () => {
    // 悄悄改名的后果是：用户下一步去找 `SalesOrder` 目录，找不到。
    expect(() => deriveNames('SalesOrder', 'x')).toThrow(/不合法/)
    expect(() => deriveNames('sales_order', 'x')).toThrow(/不合法/)
    expect(() => deriveNames('1order', 'x')).toThrow(/不合法/)
  })

  it('拒绝与框架自己的模块目录重名', () => {
    expect(() => deriveNames('platform', 'x')).toThrow(/重名/)
  })
})

describe('生成七件事', () => {
  it('十一个文件 + 前端两份都生成出来了', () => {
    const root = fakeProject()
    const r = generateModule({ root, slug: 'order', name: '订单' })
    expect(r.created).toEqual([
      'apps/api/prisma/schema/10-business/20-order.prisma',
      'apps/api/src/modules/order/order.module.ts',
      'apps/api/src/modules/order/order.controller.ts',
      'apps/api/src/modules/order/order.service.ts',
      'apps/api/src/modules/order/order.rules.ts',
      'apps/api/src/modules/order/order.rules.spec.ts',
      'apps/api/src/modules/order/order.permissions.ts',
      'apps/api/src/modules/order/order.menus.ts',
      'apps/api/src/modules/order/order-sync.handler.ts',
      'apps/api/src/modules/order/dto/order.dto.ts',
      'apps/api/test/order.e2e-spec.ts',
      'apps/admin/src/api/order.ts',
      'apps/admin/src/pages/order/index.tsx',
    ])
  })

  it('① 加表：tenantId + @@index([tenantId, id]) + deletedAt + 唯一索引带 deletedAt', () => {
    const root = fakeProject()
    generateModule({ root, slug: 'order', name: '订单' })
    const schema = code(root, 'apps/api/prisma/schema/10-business/20-order.prisma')
    expect(schema).toContain('tenantId   String')
    expect(schema).toContain('@@index([tenantId, id])')
    expect(schema).toContain('deletedAt  DateTime?')
    expect(schema).toContain('@@unique([tenantId, name, deletedAt])')
    // 金额必须是 Int 且以 Cents 结尾（money-field.spec.ts）；禁止 Decimal。
    expect(schema).toContain('priceCents Int')
    expect(schema).not.toContain('Decimal')
    // 状态必须是 enum（enum-and-key.spec.ts）
    expect(schema).toContain('enum OrderStatus {')
    // 主键必须是 String（enum-and-key.spec.ts）
    expect(schema).toMatch(/id\s+String\s+@id/)
  })

  it('② 注册隔离：TENANT_MODELS + 软删清单 + verify-schema 的清单', () => {
    const root = fakeProject()
    generateModule({ root, slug: 'order', name: '订单' })
    const tm = read(root, 'apps/api/src/tenancy/tenant-models.ts')
    expect(tm).toContain("registry.register(['Order'])")
    expect(tm).toMatch(/'Order',\n\]\)/)
    const pkg = JSON.parse(read(root, 'apps/api/package.json'))
    expect(pkg.scripts['taizan:verify-schema']).toContain('--registered=Goods,GoodsSku,Order')
  })

  it('③④⑤⑥⑦ 五张注册表都插上了', () => {
    const root = fakeProject()
    generateModule({ root, slug: 'order', name: '订单' })

    const perms = read(root, 'apps/api/src/registry/permissions.ts')
    expect(perms).toContain(
      "import { ORDER_PERMISSIONS } from '../modules/order/order.permissions'",
    )
    expect(perms).toContain('  ...ORDER_PERMISSIONS,')
    expect(perms).toContain("['order', ORDER_PERMISSIONS],")

    const menus = read(root, 'apps/api/src/registry/menus.ts')
    expect(menus).toContain("import { ORDER_MENUS } from '../modules/order/order.menus'")
    expect(menus).toContain('  ...ORDER_MENUS,')

    const features = read(root, 'apps/api/src/registry/features.ts')
    // pathPrefixes 必须与真实 @Controller 前缀一致（billing-routes.spec.ts）
    expect(features).toContain("pathPrefixes: ['/api/admin/order'],")
    expect(read(root, 'apps/api/src/modules/order/order.controller.ts')).toContain(
      "@Controller('api/admin/order')",
    )

    const audit = read(root, 'apps/api/src/registry/audit-actions.ts')
    for (const action of ['ORDER_CREATE', 'ORDER_UPDATE', 'ORDER_DELETE']) {
      expect(audit, action).toContain(action)
    }

    const jobs = read(root, 'apps/api/src/registry/jobs.ts')
    expect(jobs).toContain(
      "import { ORDER_SYNC_JOB_NAME } from '../modules/order/order-sync.handler'",
    )
    expect(jobs).toContain('    name: ORDER_SYNC_JOB_NAME,')
  })

  it('装配与前端两步', () => {
    const root = fakeProject()
    generateModule({ root, slug: 'order', name: '订单' })
    const app = read(root, 'apps/api/src/bootstrap/app.module.ts')
    expect(app).toContain("import { OrderModule } from '../modules/order/order.module'")
    expect(app).toContain('    OrderModule,')
    const map = read(root, 'apps/admin/src/routes/component-map.ts')
    // componentKey 必须与菜单里的对得上（menu-route-map.spec.ts）
    expect(map).toContain("OrderList: lazy(() => import('../pages/order'))")
    expect(read(root, 'apps/api/src/modules/order/order.menus.ts')).toContain(
      "componentKey: 'OrderList',",
    )
  })

  it('控制器带齐四个装饰器（守卫 / 权限 / 审计 / 数据范围）', () => {
    const root = fakeProject()
    generateModule({ root, slug: 'order', name: '订单' })
    const c = code(root, 'apps/api/src/modules/order/order.controller.ts')
    expect(c).toContain("@Auth('staff')")
    expect(c).toContain("@RequirePermission('order:list')")
    expect(c).toContain("@RequirePermission('order:write')")
    expect(c).toContain("@RequirePermission('order:delete')")
    expect(c).toContain("@DataScope({ ownerField: 'createdBy' })")
    expect(c).toContain('@Audit({ action: APP_AUDIT_ACTIONS.ORDER_CREATE')
    // 默认拒绝：不该有 @Public()
    expect(c).not.toContain('@Public()')
    // 导出路由必须排在 :id 之前，否则 /export 会命中 :id
    expect(c.indexOf("@Get('export')")).toBeLessThan(c.indexOf("@Get(':id')"))
  })

  it('service 只用 prisma.tenant，绝不手写 tenantId 过滤', () => {
    const root = fakeProject()
    generateModule({ root, slug: 'order', name: '订单' })
    const s = code(root, 'apps/api/src/modules/order/order.service.ts')
    expect(s).toContain('this.prisma.tenant.order.findMany')
    // 这一条就是 no-manual-tenant-filter.spec.ts（spec 4）守的东西。
    expect(s).not.toMatch(/where:\s*\{[^}]*tenantId/)
  })

  it('rules 是纯函数（不 import nest / prisma），且带一份自己的 spec', () => {
    const root = fakeProject()
    generateModule({ root, slug: 'order', name: '订单' })
    const rules = read(root, 'apps/api/src/modules/order/order.rules.ts')
    expect(rules).not.toMatch(/from '@nestjs\//)
    expect(rules).not.toMatch(/from '@prisma\//)
    expect(existsSync(join(root, 'apps/api/src/modules/order/order.rules.spec.ts'))).toBe(true)
    expect(existsSync(join(root, 'apps/api/test/order.e2e-spec.ts'))).toBe(true)
  })

  it('schema 片段的数字前缀往后排，菜单 sort 也往后排', () => {
    const root = fakeProject()
    generateModule({ root, slug: 'order', name: '订单' })
    // 已有 10-goods.prisma → 新的是 20-
    expect(existsSync(join(root, 'apps/api/prisma/schema/10-business/20-order.prisma'))).toBe(true)
  })
})

describe('可重复执行 / 失败模式', () => {
  it('重跑一次不会插两遍（幂等）', () => {
    const root = fakeProject()
    generateModule({ root, slug: 'order', name: '订单' })
    // 模块目录已存在 → 直接拒绝，不覆盖别人写了一周的 service。
    expect(() => generateModule({ root, slug: 'order', name: '订单' })).toThrow(/已存在/)

    // 把目录删掉再跑一次：注册行已经在了，应该全部 skipped 而不是又插一遍。
    rmSync(join(root, 'apps/api/src/modules/order'), { recursive: true, force: true })
    const again = generateModule({ root, slug: 'order', name: '订单' })
    expect(again.edits.filter(([, , outcome]) => outcome === 'inserted')).toEqual([])
    const perms = read(root, 'apps/api/src/registry/permissions.ts')
    expect(perms.split('...ORDER_PERMISSIONS,').length - 1).toBe(1)
  })

  it('锚点找不到时**抛错**，不静默跳过', () => {
    // 静默跳过 = 七件事只做了六件，而生成器说成功了。漏掉的可能正是「注册隔离」。
    const root = fakeProject()
    writeFileSync(join(root, 'apps/api/src/registry/jobs.ts'), 'export const JOBS = []\n')
    expect(() => generateModule({ root, slug: 'order', name: '订单' })).toThrow(/插入锚点/)
  })

  it('不是一个 taizan-saas 项目时直接说清楚', () => {
    const root = mkdtempSync(join(tmpdir(), 'taizan-codegen-empty-'))
    dirs.push(root)
    // 断言里挑的是**路径**而不是项目名：这份模板会被生成器改写（项目名会变成用户的
    // 项目名），拿项目名做断言等于让这条 spec 在生成出来的项目里必然失败。
    expect(() => generateModule({ root, slug: 'order' })).toThrow(
      /apps\/api\/src\/registry\/permissions\.ts/,
    )
  })

  it('--dry-run 不写盘', () => {
    const root = fakeProject()
    const r = generateModule({ root, slug: 'order', name: '订单', dryRun: true })
    expect(r.created.length).toBeGreaterThan(0)
    expect(existsSync(join(root, 'apps/api/src/modules/order'))).toBe(false)
    expect(read(root, 'apps/api/src/registry/jobs.ts')).not.toContain('ORDER_SYNC_JOB_NAME')
  })

  it('没有 apps/admin 时只生成后端那一半（api-only 项目）', () => {
    const root = fakeProject()
    rmSync(join(root, 'apps/admin'), { recursive: true, force: true })
    const r = generateModule({ root, slug: 'order', name: '订单' })
    expect(r.created.some((f) => f.startsWith('apps/admin/'))).toBe(false)
    // 菜单仍然注册：componentKey 的对账只在存在的那一侧做（见生成器的裁剪逻辑）。
    expect(read(root, 'apps/api/src/registry/menus.ts')).toContain('...ORDER_MENUS,')
  })
})
