/**
 * 平台超管登录。
 *
 * ## 为什么整个 `modules/platform/` 都在 raw 白名单里
 *
 * 平台面天然跨租户：`PlatformAdmin` 是平台域表（**根本没有 `tenantId` 列**），
 * `/api/platform/*` 也因此不进租户中间件（`TENANT_FREE_PREFIXES`）。
 * 走 `prisma.tenant` 在这里不是「更安全」，而是直接抛 `NO_CONTEXT`。
 * 白名单条目与理由写在 `src/tenancy/raw-reasons.ts`，由 spec 3 扫描比对。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { AuthFlowService, type IssuedTokens } from '@taizan/nest-auth'
import { BizException } from '@taizan/nest-core'
import { RawPrismaService } from '@taizan/nest-prisma'
import type { BootstrapIdentity, BootstrapResponse } from '@taizan/contracts'
import { ErrorCode } from '@taizan/contracts'
import { hashPasswordSync, hashPassword, needsRehash, verifyPassword } from '@taizan/prisma-base'
import { pruneMenus } from '@taizan/rbac-core'

import type { AppPrismaClient } from '../../../common/prisma.types'
import { PLATFORM_MENUS } from '../../../registry/menus'
import { ALL_PERMISSION_CODES } from '../../../registry/permissions'

/** 登录成功后回给前端的东西。 */
export interface PlatformLoginResult extends IssuedTokens {
  admin: { id: string; username: string; name: string }
}

/**
 * `GET /api/platform/auth/bootstrap` 的 `identity`：在通用 {@link BootstrapIdentity}
 * （`staffId`/`accountId`/`name`/`avatar`/`isOwner`）的基础上叠加平台侧真正有意义的
 * 两个字段。`staffId`/`accountId` 都填成 `admin.id`——平台管理员不是「员工」也没有
 * 「账号 vs 员工」的一号多店概念，这两个字段只是为了让整个响应结构上兼容
 * `@taizan/contracts` 的 `BootstrapResponse`（从而 `apps/platform` 能直接复用
 * `@taizan/admin-ui` 的通用 `createSessionStore()`，不必再手写一份「形状兼容」的 store）。
 */
export interface PlatformBootstrapIdentity extends BootstrapIdentity {
  adminId: string
  username: string
}

/**
 * `GET /api/platform/auth/bootstrap` 的完整响应。
 *
 * `tenant`/`shops`/`quotas` 三个字段对平台超管**没有语义**（平台管理员不属于任何一家
 * 租户），这里只填一份占位值来满足 `BootstrapResponse` 的结构（`tenant.slug` 特意留空
 * 字符串——`EnvelopeClient` 对空字符串不会加 `X-Tenant-Slug` 头，不会因为这份占位数据
 * 意外泄露出一个假租户维度）。`apps/platform` 的 `<AppShell>` 通过 `logo` 属性覆盖侧栏
 * 品牌区、`showShopSwitcher={false}` 关掉顶栏切换器，两者合起来这份占位值不会在界面上
 * 露出任何痕迹。
 */
export type PlatformBootstrapResponse = Omit<BootstrapResponse, 'identity'> & {
  identity: PlatformBootstrapIdentity
}

@Injectable()
export class PlatformAuthService {
  constructor(
    // raw-reason: 平台后台——PlatformAdmin 是平台域表，没有 tenantId 列，
    // 且 /api/platform/* 不进租户中间件，此刻上下文里根本没有租户。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
    @Inject(AuthFlowService) private readonly flow: AuthFlowService,
  ) {}

  /**
   * 用户名 + 口令登录。
   *
   * @throws `BizException` 1140100 用户名不存在 / 口令不对 / 账号被停用
   *   ——三种情况**同一个错误码同一句文案**，不给枚举用户名的机会。
   */
  async login(username: string, password: string): Promise<PlatformLoginResult> {
    // raw-reason: 平台后台——按 username 找平台管理员，平台域表无租户维度。
    const admin = await this.raw.client.platformAdmin.findUnique({ where: { username } })

    // 口令校验**无论账号在不在都跑一遍**：直接 return 会让「用户名存在」变成一个
    // 可以用响应时间测出来的信息。这里对着一个固定的假哈希跑一次 scrypt。
    const hash = admin?.passwordHash ?? DUMMY_HASH
    const okPassword = await verifyPassword(password, hash)

    if (!admin || !okPassword || admin.status !== 'ACTIVE') {
      throw new BizException(ErrorCode.UNAUTHENTICATED, '用户名或密码不正确')
    }

    // scrypt 参数写在哈希串里，将来调高成本参数时老口令仍然能校验；
    // 校验成功的这一刻顺手按新参数重算写回，用户无感知地完成迁移。
    if (needsRehash(admin.passwordHash)) {
      // raw-reason: 平台后台——同上。
      await this.raw.client.platformAdmin.update({
        where: { id: admin.id },
        data: { passwordHash: await hashPassword(password) },
      })
    }

    // raw-reason: 平台后台——登录时间戳。
    await this.raw.client.platformAdmin.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    })

    // TODO(平台 MFA 第二阶段，见 platform-mfa.service.ts 文件头)：`admin.mfaSecretEnc`
    // 非空时本该在这里要求并校验一个 `totp` 字段；schema 目前的两列（secretEnc/keyId）
    // 表达不了「已确认启用」，本阶段只做 `PlatformMfaService` 的 enable/verify 开关位，
    // 登录流程完全不看这两列。

    const tokens = await this.flow.login('platform', admin.id)
    return {
      access: tokens.access,
      refresh: tokens.refresh,
      expiresIn: tokens.expiresIn,
      admin: { id: admin.id, username: admin.username, name: admin.name },
    }
  }

  /**
   * `GET /api/platform/auth/bootstrap`：一次性下发身份/权限/已裁剪菜单。
   *
   * ## `permissions` 为什么是字面量 `['*']`，不是展开后的具体 code 列表
   *
   * 平台侧 RBAC 本阶段**全权**：`platform.permissions.ts` 头部注释原话——
   * 「`@RequirePermission` 目前没有挂在任何 T1-7 控制器方法上」，`PlatformAdmin.roleIds`
   * 也完全没有参与任何鉴权判定（`@taizan/nest-rbac` 的 `RolePermissionsService.grantedFor()`
   * 对 `kind === 'platform'` 的主体本来就无条件返回全部已注册权限点，等价于「全权」）。
   * 下发一份「看起来是按角色算出来的」全量 code 列表，会让前端以为这是真的权限收窄结果；
   * 字面量 `'*'` 如实反映现状——**TODO**：平台侧角色/权限体系定下来之后，这里要换成
   * 按 `PlatformAdmin.roleIds` 展开 `RolePreset.permissionCodes` 的真实结果。
   *
   * ## `menus` 为什么不能也用 `'*'`
   *
   * `pruneMenus()`（`@taizan/rbac-core`）对 `MenuDef.permission` 做的是**精确** code
   * 匹配（`granted.has(code)`），不认通配符——那是刻意的，见 `rbac-core` 的
   * `evaluatePermission` 文档。所以这里单独构造一份「全部已注册权限点」的集合喂给它，
   * 与上面下发给前端的 `'*'` 是两件事：一个是「讲给前端听的诚实描述」，
   * 一个是「喂给裁剪函数的、真正能用来做交集运算的数据」。
   */
  async bootstrap(adminId: string): Promise<PlatformBootstrapResponse> {
    // raw-reason: 平台后台——按 id 找当前登录的平台管理员自己。
    const admin = await this.raw.client.platformAdmin.findUnique({ where: { id: adminId } })
    if (!admin) {
      throw new BizException(ErrorCode.UNAUTHENTICATED, '登录状态已失效，请重新登录')
    }

    const menus = pruneMenus(PLATFORM_MENUS, {
      granted: new Set(ALL_PERMISSION_CODES),
      features: null,
      side: 'PLATFORM',
    })

    return {
      identity: {
        staffId: admin.id,
        accountId: admin.id,
        name: admin.name,
        avatar: null,
        isOwner: true,
        adminId: admin.id,
        username: admin.username,
      },
      tenant: {
        id: '',
        slug: '',
        name: '',
        status: 'ACTIVE',
        planExpireAt: null,
        readonly: false,
        closedReason: null,
        features: null,
      },
      shops: [],
      // 见方法文档「permissions 为什么是字面量」。
      permissions: ['*'],
      menus,
      quotas: {},
    }
  }
}

/**
 * 账号不存在时用来「白跑一次 scrypt」的假哈希。
 *
 * 值本身无所谓（谁都校验不过它），要紧的是**参数与真实哈希同档**——
 * 这样「用户名不存在」与「口令不对」两条分支的耗时在同一个量级，
 * 拿响应时间当预言机枚举用户名这条路就断了。
 *
 * 现算而不是硬编码一个字面量：硬编码的串在 scrypt 默认参数被调高之后就与真实哈希
 * 不同档了，而那一天没有任何东西会提醒你。代价是启动时多花一次 scrypt（约 50–100ms）。
 */
const DUMMY_HASH = hashPasswordSync(`unused-${Math.random()}`)
