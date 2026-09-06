/**
 * `prisma.raw` / `RawPrismaService` 的**允许清单**（蓝图 §4.2、§8 spec 3）。
 *
 * 租户隔离扩展只有一个逃生口，就是 raw 句柄。它存在是因为确实有三类操作绕不开：
 *
 * | # | 类别 | 为什么绕不开 |
 * |---|---|---|
 * | 1 | 登录/鉴权跨租户找账号 | 用户只输了手机号，此刻还不知道他属于哪家店——「算出 tenantId」这一步本身不可能带着 tenantId 做 |
 * | 2 | 支付回调按参数定位租户 | 回调来自外部，没有登录态，只能靠 `outTradeNo` 反查 |
 * | 3 | 平台后台 | 平台管理员天然跨租户，给它注入某一个 tenantId 反而会让它「看不到数据」 |
 *
 * 除此之外的每一次 raw 使用都视为事故。`test/arch/raw-usage.spec.ts` 扫 `src/**`
 * 里所有 `.raw` 用点，要求：**文件在下面的清单里** 且 **用点附近有 `// raw-reason:` 注释**。
 * 两个条件是「与」——只写注释不进清单不行（否则清单形同虚设），
 * 只进清单不写注释也不行（半年后没人记得这一处当初为什么要 raw）。
 *
 * @packageDocumentation
 */

/** 一条豁免。 */
export interface RawReasonEntry {
  /** 相对 `apps/api/` 的 POSIX 路径，或以 `/` 结尾表示整个目录。 */
  path: string
  /** 属于上表的哪一类。 */
  category: 'login-cross-tenant' | 'payment-callback' | 'platform-console'
  /** 中文理由，写清「为什么这里非 raw 不可」。空理由由 spec 3 判为无效条目。 */
  reason: string
}

/**
 * 允许出现 `prisma.raw` / `RawPrismaService` 的位置。
 *
 * 新增条目 = 新开一个绕过租户隔离的口子，**必须在 code review 里被当成一次架构决策**，
 * 而不是「先加上让测试过了再说」。
 */
export const RAW_REASONS: readonly RawReasonEntry[] = [
  {
    path: 'src/modules/platform/',
    category: 'platform-console',
    reason:
      '平台超管面天然跨租户：租户列表、跨店看板、平台管理员登录都发生在「还没有／不该有」租户上下文的时刻。' +
      '/api/platform 也因此不进租户中间件（TENANT_FREE_PREFIXES）。',
  },
  {
    path: 'src/modules/admin/bootstrap/bootstrap.service.ts',
    category: 'login-cross-tenant',
    reason:
      'bootstrap 要读 Tenant 与 StaffAccount 这两张**平台域**表（它们没有 tenantId 列），' +
      '以及「这个账号名下还有哪些店」的跨租户切换列表。当前店的隔离由 token 里的 tenantId 保证，' +
      '不是由 where 保证。',
  },
  {
    path: 'src/modules/admin/auth/admin-auth.service.ts',
    category: 'login-cross-tenant',
    reason:
      '商家登录只有手机号：要先跨租户找到 StaffAccount，再列出这个账号名下的所有店铺让前端选店。' +
      '「他属于哪家店」正是这一步要算出来的东西，此刻没有 tenantId 可用。',
  },
  {
    path: 'src/modules/admin/staff/staff.service.ts',
    category: 'login-cross-tenant',
    reason:
      '员工列表要显示登录手机号、还要能按手机号搜人，而手机号在 **StaffAccount**（平台域表，' +
      '一号多店的载体，没有 tenantId 列）。本文件里的两处 raw 查询都不带 tenantId 过滤条件：' +
      '隔离由「先用 prisma.tenant 查出本店的 accountId 集合、再按那个 id 集合反查账号」这个**顺序**保证。' +
      'Staff / StaffInvite / Role 三张租户域表一律走 prisma.tenant，一个 tenantId 都不写。',
  },
  {
    path: 'src/modules/admin/profile/profile.service.ts',
    category: 'login-cross-tenant',
    reason:
      '「个人设置」改的是 StaffAccount 上的显示名 / 头像 / 口令（平台域表，一号多店共用一份）。' +
      '改密还要跨租户列出「这个账号在哪些店里有 Staff 行」，才能把所有店的会话一起撤掉——' +
      '只撤当前这家店的话，攻击者拿着另一家店的 token 照样在线。tenantId 是那次查询的产物而非输入。',
  },
  {
    path: 'src/modules/admin/announcement/',
    category: 'platform-console',
    reason:
      '公告是平台域表：Announcement 不属于任何单个租户（audience = ALL_TENANT 时它属于所有租户），' +
      'AnnouncementRead 要跨租户统计已读。两张表都没有 tenantId 列，走 prisma.tenant 会被隔离扩展' +
      '当成未登记模型直接抛。「哪些公告对本店可见」由纯函数 isVisibleTo(公告, tenantId, planCode) 判，' +
      '而 tenantId 来自 token、planCode 来自 PlatformGateway，都不来自请求参数。',
  },
  {
    path: 'src/modules/public/invite/',
    category: 'login-cross-tenant',
    reason:
      '员工邀请的核销端：被邀请人此刻还不是这家店的员工、可能连账号都没有，所以这条路由免登录、' +
      '落在 /api/public（TENANT_FREE_PREFIXES，租户中间件根本不跑）。' +
      '「这张邀请属于哪家店」正是要从令牌反查出来的**产物**，此刻没有 tenantId 可用；' +
      'StaffAccount / Tenant 本身也是平台域表。扣配额时用 runWithPatchedContext({ tenantId }) 现开一个' +
      '租户上下文，那个 tenantId 来自库里那张邀请，不来自请求参数。',
  },
  {
    path: 'src/modules/public/signup/',
    category: 'login-cross-tenant',
    reason:
      '自助注册：建店这一刻租户**还不存在**，任何「先有 tenantId 再查」的路径在这里都成立不了' +
      '（/api/public 也因此不进租户中间件，spec 16）。' +
      '另外「这个手机号有没有账号」「这个 slug 被占了没」「在售套餐有哪些」查的都是平台域表' +
      '（StaffAccount / Tenant / Plan，它们没有 tenantId 列）。' +
      '建店本身一行都不在这里写——整块是 @taizan/provision 的 provisionTenant()，由 spec 14 盯着。',
  },
  {
    path: 'src/seed.ts',
    category: 'platform-console',
    reason:
      'seed 要跨租户造数（平台管理员、套餐、两个演示租户），隔离扩展在没有租户上下文时会正确地抛错。',
  },
]
