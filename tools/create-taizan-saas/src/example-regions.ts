/**
 * **示例业务模块的「可删行」清单**（蓝图 §6 问题 8：不保留示例模块时删哪些东西）。
 *
 * ## 为什么是「快照期插标记」而不是「裁剪期认代码」
 *
 * 生成器不允许改 `apps/**`——那是参考应用，还有别的人在上面写业务。所以标记注释
 * （`// @taizan-example-start` / `// @taizan-example-end`）由 `build-templates.ts`
 * 在**快照那一刻**插进模板里，`prune.ts` 只认标记、不认代码。
 *
 * 好处是裁剪逻辑永远只有一句「删掉标记之间的行」，坏处是这张表会随 apps/ 漂移——
 * 所以每条规则都**必须命中**，命中不到就让 `pnpm build:templates` 直接失败
 * （见 `assertAllMatched`）。漏删一行的后果是生成出来的项目 `import` 一个不存在的
 * 文件，`pnpm build` 当场红；而静默跳过会让人以为「示例已经删干净了」。
 *
 * ## 没有覆盖到的地方
 *
 * `apps/client`（Taro）与 `apps/app-client` / `apps/app-merchant`（Expo）这三个 C 端**整个
 * 就是示例**——它们唯一的业务界面就是示例列表页与详情页。删掉示例之后那里不剩任何东西，
 * 所以 CLI 在「不保留示例」时会直接把这三个端一起去掉，并明确告诉用户（见 `src/prompts.ts`
 * 的 `reconcileAnswers`）。硬把空壳留下比不留更糟：它会长期挂在 turbo 的 build 里，
 * 而里面没有一行属于这个项目的代码。
 *
 * @packageDocumentation
 */

/** 一条标记区间规则。 */
export interface RegionRule {
  /** 区间起始行的匹配。 */
  from: RegExp
  /** 区间结束行的匹配；不给 = 单行区间。 */
  to?: RegExp
  /** 往前多包几行（把紧贴其上的 doc 注释一起圈进来）。 */
  lead?: number
  /** 期望命中次数；实际不符就让 build:templates 失败。默认 1。 */
  times?: number
  /** 这几行为什么属于示例业务。 */
  why: string
}

/**
 * 相对仓库根的 POSIX 路径 → 这个文件里属于示例业务的行。
 *
 * 顺序即蓝图 §7 的七件事 + 前端两步，照着这张表就能回答「一个业务模块到底散在哪」。
 */
export const EXAMPLE_REGIONS: Readonly<Record<string, readonly RegionRule[]>> = {
  // ── 扩展点② 注册隔离 ──────────────────────────────────────────────────
  'apps/api/src/tenancy/tenant-models.ts': [
    {
      from: /^\/\/ ── 扩展点②/,
      to: /^registry\.register\(\['Goods', 'GoodsSku'\]\)$/,
      why: '扩展点②：业务表进 TENANT_MODELS。示例删了，这一行也没有对应的 model 了。',
    },
    {
      from: /^ {2}\/\/ 业务侧$/,
      to: /^ {2}'GoodsSku',$/,
      why: 'SOFT_DELETE_MODELS 里的业务侧两张表。',
    },
  ],

  // ── 扩展点③ 注册权限点 ────────────────────────────────────────────────
  'apps/api/src/registry/permissions.ts': [
    { from: /^import \{ GOODS_PERMISSIONS \}/, why: '扩展点③：示例模块的权限点导入。' },
    { from: /^ {2}\.\.\.GOODS_PERMISSIONS,$/, why: '扩展点③：汇总进 PERMISSIONS。' },
    { from: /^ {4}\['example-goods', GOODS_PERMISSIONS\],$/, why: '撞名检查的来源表条目。' },
  ],

  // ── 扩展点④ 注册菜单 ──────────────────────────────────────────────────
  'apps/api/src/registry/menus.ts': [
    { from: /^import \{ GOODS_MENUS \}/, why: '扩展点④：示例模块的菜单导入。' },
    {
      from: /^ {2}\/\/ 示例业务模块的菜单排在工作台之后/,
      to: /^ {2}\.\.\.GOODS_MENUS,$/,
      why: '扩展点④：汇总进 ADMIN_MENUS。菜单没了，apps/admin 的 GoodsList 路由也就不该存在。',
    },
  ],

  // ── 扩展点⑤ 注册套餐功能项 ────────────────────────────────────────────
  'apps/api/src/registry/features.ts': [
    {
      from: /^ {2}\{$/,
      to: /^ {2}\},$/,
      why: '扩展点⑤：goods 功能项。删掉后 FEATURES 是空数组——这是合法状态（新项目还没有任何按套餐开关的功能）。',
    },
  ],

  // ── 扩展点⑥ 注册审计动作 ──────────────────────────────────────────────
  'apps/api/src/registry/audit-actions.ts': [
    {
      from: /^ {2}\/\*\* 新建商品。 \*\/$/,
      to: /^ {2}GOODS_DELETE: 'goods\.delete',$/,
      why: '扩展点⑥：示例模块的三个审计动作。',
    },
  ],

  // ── 扩展点⑦ 注册队列任务 ──────────────────────────────────────────────
  'apps/api/src/registry/jobs.ts': [
    { from: /^import \{ GOODS_SYNC_JOB_NAME \}/, why: '扩展点⑦：示例任务名导入。' },
    {
      from: /^ {2}\{$/,
      to: /^ {2}\},$/,
      why: '扩展点⑦：JOBS 里的 goods.sync 条目。',
    },
  ],

  // ── 模块装配 ──────────────────────────────────────────────────────────
  'apps/api/src/bootstrap/app.module.ts': [
    { from: /^import \{ GoodsModule \}/, why: '示例模块的装配导入。' },
    { from: /^ {4}GoodsModule,$/, why: 'AppModule.imports 里的示例模块。' },
  ],
  'apps/api/src/modules/client/client.module.ts': [
    { from: /^import \{ ClientGoodsModule \}/, why: 'C 端示例只读接口的导入。' },
    { from: /ClientGoodsModule\]/, why: 'ClientModule.imports 里的 C 端示例模块。' },
  ],

  // ── seed：示例数据 ────────────────────────────────────────────────────
  'apps/api/src/seed.ts': [
    { from: /^\/\*\* A 店的商品。 \*\/$/, to: /^\]$/, why: 'A 店的示例商品数据。' },
    { from: /^\/\*\* B 店的商品。名字/, to: /^\]$/, why: 'B 店的示例商品数据。' },
    {
      from: /^\/\*\* 幂等地给某家店塞商品/,
      to: /^\}$/,
      why: 'seedGoods 函数本身（用 prisma.goods，示例表没了就编译不过）。',
    },
    { from: /^ {2}const createdA = await seedGoods\(/, why: 'seed 主流程里的调用点。' },
    { from: /^ {2}const createdB = await seedGoods\(/, why: 'seed 主流程里的调用点。' },
    { from: /商品 {12}A 店 \$\{GOODS_A\.length\}/, why: 'seed 产出说明里的商品行。' },
  ],

  // ── 前端第一步：component-map ──────────────────────────────────────────
  'apps/admin/src/routes/component-map.ts': [
    {
      from: /^ {2}GoodsList: lazy\(/,
      why: '前端第一步：componentKey → 页面组件。菜单删了这条也必须删，否则 component-map.spec 会报「死 key」。',
    },
  ],
}

/**
 * 示例业务**独占**的文件与目录：不保留示例时整份删掉。
 *
 * 路径写的是**模板里的样子**（已经被 G3 规则换成 `{{domainSlug}}`），
 * 因为 `prune.ts` 是在渲染之后、拿着真实项目目录跑的——它拿到的是渲染结果。
 * 所以这里存的是「渲染前的模板路径」，由 `prune.ts` 自己先渲染一遍再删。
 */
export const EXAMPLE_ONLY_PATHS: readonly string[] = [
  'apps/api/src/modules/example-{{domainSlug}}',
  'apps/api/src/modules/client/{{domainSlug}}',
  'apps/api/prisma/schema/10-business/10-{{domainSlug}}.prisma',
  // 这两份 e2e 直接 import 示例模块的 service / handler，示例没了就编译不过。
  'apps/api/test/tenant-isolation.e2e-spec.ts',
  'apps/api/test/rbac-billing.e2e-spec.ts',
  'apps/admin/src/api/{{domainSlug}}.ts',
  'apps/admin/src/pages/{{domainSlug}}',
  'apps/admin/e2e/owner-{{domainSlug}}-crud.spec.ts',
]
