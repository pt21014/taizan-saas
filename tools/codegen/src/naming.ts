/**
 * 一个业务模块的命名派生。
 *
 * 只有一个输入（`slug`）与一个中文名，其余全部算出来——这不是偷懒，是**约定**：
 * `order` 这个 slug 一旦定下，目录名、model 名、权限点前缀、路由段、队列任务名、
 * 前端 componentKey 就全都定了。允许它们各写各的，等于允许 `/api/admin/orders`
 * 配 `order:list` 配 `OrdersList` 这种组合，然后每次找东西都要先猜是哪个拼法。
 *
 * @packageDocumentation
 */

/** 一个模块的全部名字。 */
export interface Names {
  /** 命令行给的：`order`、`sales-order`。 */
  slug: string
  /** 中文名，菜单/权限点/审计动作的显示名用它。 */
  name: string
  /** `sales-order` → `SalesOrder`。model 名、类名前缀。 */
  Pascal: string
  /** `sales-order` → `salesOrder`。Prisma delegate（`prisma.tenant.salesOrder`）。 */
  camel: string
  /** `sales-order` → `SALES_ORDER`。常量名前缀。 */
  CONST: string
  /** `sales-order` → `sales_order`。schema 片段文件名里不用，但 DB 相关处可能要。 */
  snake: string
  /** 前端 componentKey：`SalesOrderList`。 */
  componentKey: string
}

export function deriveNames(slug: string, name: string): Names {
  assertSlug(slug)
  const words = slug.split('-').filter(Boolean)
  const Pascal = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')
  return {
    slug,
    name,
    Pascal,
    camel: Pascal.charAt(0).toLowerCase() + Pascal.slice(1),
    CONST: words.join('_').toUpperCase(),
    snake: words.join('_'),
    componentKey: `${Pascal}List`,
  }
}

/**
 * slug 的形状约束。
 *
 * 拒绝而不是「帮你规范化」：`SalesOrder` 被悄悄改成 `sales-order` 之后，用户下一步
 * 去找 `SalesOrder` 目录会找不到，而错误信息发生在十分钟以后的某个 import 上。
 */
export function assertSlug(slug: string): void {
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(
      `模块 slug "${slug}" 不合法。\n` +
        '  只允许小写字母开头的 kebab-case（order、sales-order、demo-item）。\n' +
        '  它会同时变成：目录名 src/modules/<slug>/、路由段 /api/admin/<slug>、\n' +
        '  权限点前缀 <slug>:list、队列任务名 <slug>.sync、schema 片段文件名。',
    )
  }
  const reserved = new Set([
    'admin',
    'client',
    'platform',
    'public',
    'common',
    'registry',
    'tenancy',
  ])
  if (reserved.has(slug)) {
    throw new Error(
      `模块 slug "${slug}" 与框架自己的目录重名（src/modules/${slug} 已经存在且是框架的）。换一个。`,
    )
  }
}
