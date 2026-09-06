/**
 * **快照期的定点改写**：几处源码在框架仓库里是对的，搬进生成项目就不对了。
 *
 * ## 为什么需要这张表
 *
 * `apps/api/test/arch/**` 是框架交付的一部分——生成出来的项目要靠那 16 条断言守住
 * 多租户隔离、金额单位、守卫默认拒绝这些不变量。但其中三条在**框架仓库**里会去读
 * `packages/`（框架包的源码就在隔壁）；生成出来的项目里根本没有 `packages/`
 * （框架是从 npm 装的），那三条会在 import 期直接 `ENOENT` 崩掉，
 * 于是**整份 `pnpm test` 红**——用户看到的错误信息是「scandir packages 失败」，
 * 与「你少了一个目录」之间隔着好几步推理。
 *
 * 不改 `apps/**` 的理由前面说过：那是参考应用，不该为生成器的可选性买单，
 * 而且别的人正在上面写业务。所以改在**快照的那一刻**，只影响模板。
 *
 * ## 每条 patch 必须命中
 *
 * `find` 找不到就让 `pnpm build:templates` 失败。静默跳过的后果是：模板里带着一条
 * 必崩的 spec，而这件事要等到有人真的生成一个项目、真的跑 `pnpm test` 才会发现。
 *
 * @packageDocumentation
 */

/** 一条定点改写。 */
export interface FilePatch {
  /** 相对仓库根的 POSIX 路径。 */
  file: string
  /** 要替换掉的原文（必须唯一命中一次）。 */
  find: string
  /** 换成什么。 */
  replace: string
  /** 为什么这一处在生成项目里不成立。 */
  why: string
}

/** `packages/` 目录在生成项目里不存在时的兜底写法。 */
const GUARDED_PACKAGES_LOOP = [
  '  // 生成器改写：业务项目里没有 `packages/`（框架包是从 npm 装的），',
  '  // 这一侧退化成空集合。框架仓库里它照常扫。',
  '  if (!existsSync(PACKAGES_DIR)) return out',
  '  for (const name of readdirSync(PACKAGES_DIR)) {',
].join('\n')

export const FILE_PATCHES: readonly FilePatch[] = [
  // ── spec 13 ip-source ───────────────────────────────────────────────────
  {
    file: 'apps/api/test/arch/ip-source.spec.ts',
    find: "import { readdirSync, readFileSync, statSync } from 'node:fs'",
    replace: "import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'",
    why: '下面那条 packages/ 兜底要用 existsSync。',
  },
  {
    file: 'apps/api/test/arch/ip-source.spec.ts',
    find: '  for (const name of readdirSync(PACKAGES_DIR)) {',
    replace: GUARDED_PACKAGES_LOOP,
    why: '生成项目里没有 packages/，readdirSync 会 ENOENT，整份 pnpm test 在 import 期就红。',
  },

  {
    file: 'apps/api/test/arch/ip-source.spec.ts',
    find: "  it('把唯一注入点的豁免注释抹掉，它**必须**被报出来——否则说明扫描器压根没在工作', () => {",
    replace: [
      '  // 生成器改写：这条哨兵读的是 `packages/nest-core` 的源码。业务项目里没有那个目录，',
      '  // 于是它必然找不到——那不是「扫描器坏了」，是「框架源码不在本仓库」。跳过它，',
      '  // 而不是放宽它：放宽之后框架仓库里的哨兵也就没用了。',
      "  it.skipIf(!existsSync(PACKAGES_DIR))('把唯一注入点的豁免注释抹掉，它**必须**被报出来——否则说明扫描器压根没在工作', () => {",
    ].join('\n'),
    why: '这条哨兵按路径去 packages/nest-core 里找注入点，业务项目里没有 packages/。',
  },
  {
    file: 'apps/api/test/arch/ip-source.spec.ts',
    find: "  it('nest-auth 的 ratelimit/ip-resolver.ts 不在白名单里——它本来就不该碰原始头', () => {",
    replace:
      "  it.skipIf(!existsSync(PACKAGES_DIR))('nest-auth 的 ratelimit/ip-resolver.ts 不在白名单里——它本来就不该碰原始头', () => {",
    why: '同上：正面样本文件在 packages/nest-auth 里。',
  },

  // ── response-shape ──────────────────────────────────────────────────────
  {
    file: 'apps/api/test/arch/response-shape.spec.ts',
    find: "import { readdirSync, readFileSync, statSync } from 'node:fs'",
    replace: "import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'",
    why: '同上。',
  },
  {
    file: 'apps/api/test/arch/response-shape.spec.ts',
    find: '  for (const name of readdirSync(PACKAGES_DIR)) {',
    replace: GUARDED_PACKAGES_LOOP,
    why: '同上。',
  },
  {
    file: 'apps/api/test/arch/response-shape.spec.ts',
    find: `    for (const entry of FILE_WHITELIST) {
      expect(entry.reason.trim().length, \`\${entry.file} 的白名单理由为空\`).toBeGreaterThan(10)`,
    replace: `    for (const entry of FILE_WHITELIST) {
      expect(entry.reason.trim().length, \`\${entry.file} 的白名单理由为空\`).toBeGreaterThan(10)
      // 生成器改写：白名单里指向 packages/ 的那几条在业务项目里扫不到（没有那个目录）。
      // 「理由必须写」这一半照常校验，「路径必须真实存在」那一半只对本项目内的文件校验——
      // 否则一条守着框架包的白名单会把业务项目的 pnpm test 拖红。
      if (entry.file.startsWith('packages/')) continue`,
    why: '白名单里有 packages/nest-payment 的控制器，业务项目里扫不到它，那条「路径必须真实」的断言必然失败。',
  },

  // ── menu-route-map（spec 7）：两个前端都是可选的 ──────────────────────────
  {
    file: 'apps/api/test/arch/menu-route-map.spec.ts',
    find: 'const ADMIN_COMPONENT_KEYS = extractComponentMapKeys(ADMIN_COMPONENT_MAP_FILE)',
    replace: [
      '// 生成器改写：`apps/admin` 与 `apps/platform` 在业务项目里都是可选的。',
      '// 框架仓库里两个都在，这段与原来完全等价；只生成了 api 的项目里两侧都不在，',
      '// 整条 spec 7 会被跳过——它对账的是「后端菜单」与「前端路由表」，',
      '// 一侧不存在时这个对账没有意义，硬跑只会红成一片，把真正的问题淹掉。',
      'const ADMIN_COMPONENT_MAP_EXISTS = existsSync(ADMIN_COMPONENT_MAP_FILE)',
      'const ADMIN_COMPONENT_KEYS = ADMIN_COMPONENT_MAP_EXISTS',
      '  ? extractComponentMapKeys(ADMIN_COMPONENT_MAP_FILE)',
      '  : []',
    ].join('\n'),
    why: '框架仓库里 apps/admin 恒存在，所以这里没有兜底；业务项目可以只生成 api。',
  },
  {
    file: 'apps/api/test/arch/menu-route-map.spec.ts',
    find: 'const report = verifyMenuComponentMap(ALL_MENUS, COMPONENT_KEY_SET, { permissions: PERMISSIONS })',
    replace: [
      '/** 有 component-map 的那几侧。没有前端的那一侧不参与对账。 */',
      'const CHECKED_SIDES: readonly string[] = [',
      "  ...(ADMIN_COMPONENT_MAP_EXISTS ? ['ADMIN'] : []),",
      "  ...(PLATFORM_COMPONENT_KEYS_EXISTS ? ['PLATFORM'] : []),",
      ']',
      'const MENUS_UNDER_CHECK = ALL_MENUS.filter((def) => CHECKED_SIDES.includes(def.side))',
      '',
      'const report = verifyMenuComponentMap(MENUS_UNDER_CHECK, COMPONENT_KEY_SET, {',
      '  permissions: PERMISSIONS,',
      '})',
    ].join('\n'),
    why: '只对「前端真的存在的那一侧」做菜单 ↔ 组件映射对账。',
  },
  {
    file: 'apps/api/test/arch/menu-route-map.spec.ts',
    find: 'const flat = flatten(ALL_MENUS)',
    replace: 'const flat = flatten(MENUS_UNDER_CHECK)',
    why: '同上：摊平的也只该是参与对账的那几侧。',
  },
  {
    file: 'apps/api/test/arch/menu-route-map.spec.ts',
    find: "describe('spec 7：菜单 ↔ componentKey 映射对账', () => {",
    replace:
      "describe.skipIf(CHECKED_SIDES.length === 0)('spec 7：菜单 ↔ componentKey 映射对账', () => {",
    why: '两个前端都没生成时整条 spec 无对象可对账。',
  },
  {
    file: 'apps/api/test/arch/menu-route-map.spec.ts',
    find: "  it('哨兵：ADMIN 侧真的解析出了 componentKey（真源没有悄悄变成空集合）', () => {",
    replace:
      "  it.skipIf(!ADMIN_COMPONENT_MAP_EXISTS)('哨兵：ADMIN 侧真的解析出了 componentKey（真源没有悄悄变成空集合）', () => {",
    why: '这条哨兵读的是 apps/admin 的 component-map。',
  },
  {
    file: 'apps/api/test/arch/menu-route-map.spec.ts',
    find: "  it('哨兵：这条 spec 真的在读 apps/admin 的源文件，不是缓存了一份旧结果', () => {",
    replace:
      "  it.skipIf(!ADMIN_COMPONENT_MAP_EXISTS)('哨兵：这条 spec 真的在读 apps/admin 的源文件，不是缓存了一份旧结果', () => {",
    why: '同上。',
  },

  // ── 片段数量哨兵：业务项目每 gen:module 一次就多一个片段 ────────────────
  {
    file: 'apps/api/test/arch/tenant-models.spec.ts',
    find: `    // 9 个框架片段 + 1 个业务片段。数字写死是刻意的：
    // 有人删掉 10-business/ 之后所有断言仍然全绿，只有这一条会红。
    expect(result.scannedFiles.length).toBe(10)`,
    replace: `    // 生成器改写：框架仓库里写死 10（9 个框架片段 + 1 个示例片段），业务项目里
    // 每跑一次 \`pnpm gen:module\` 就多一个片段，写死会让「加一张表」这件事本身把
    // 测试跑红。改成下界——哨兵要防的是「扫了个空目录所以全绿」，下界同样防得住。
    expect(result.scannedFiles.length).toBeGreaterThanOrEqual(9)`,
    why: '框架仓库里 schema 片段数固定，业务项目里每加一个模块就多一个。',
  },
  {
    file: 'apps/api/test/arch/index.spec.ts',
    find: `    // 9 个框架片段 + 1 个业务片段。数字写死是刻意的，同 spec 1。
    expect(schemaFiles.map((f) => f.name).length).toBe(10)`,
    replace: `    // 生成器改写：理由同 tenant-models.spec.ts 里那条——业务项目的片段数会长。
    expect(schemaFiles.map((f) => f.name).length).toBeGreaterThanOrEqual(9)`,
    why: '同上。',
  },
]
