/**
 * 集成测试脚手架：一个真的 Nest app，装着 `CoreModule` + `PrismaModule`（替身客户端）
 * + `AuthModule` + `RbacModule`，守卫链按蓝图 §4.3 的顺序装：
 *
 * ```
 * GlobalAuthGuard → PermissionsGuard → (拦截器) DataScopeInterceptor
 * ```
 *
 * 为什么起真 app 而不是直接 new 一个守卫来调 `canActivate`：本包一半的行为是**装配**
 * （守卫顺序对不对、装饰器 metadata 读不读得到、参数装饰器能不能拿到拦截器写的值），
 * 手工调守卫方法把这一半全绕过去了，绿了也不说明装配是对的。
 *
 * 本文件不是 spec（文件名不以 `.spec.ts` 结尾），vitest 不会把它当测试跑。
 *
 * @packageDocumentation
 */

import 'reflect-metadata'
import { Controller, Get, Module, Post, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { CoreModule } from '@taizan/nest-core'
import { AuthFlowService, AuthModule, type Membership } from '@taizan/nest-auth'
import { FakeMembershipProvider, InMemoryAuthRedis } from '@taizan/nest-auth/testing'
import { PrismaModule } from '@taizan/nest-prisma'
import { createFakePrisma, type FakePrismaControls } from '@taizan/nest-prisma/testing'
import { BootstrapService } from '../bootstrap.service'
import { type SubtreeResolver } from '../data-scope.interceptor'
import { DataScope, RequirePermission, ScopeWhere } from '../decorators'
import { RbacModule } from '../rbac.module'
import { RolePermissionsService } from '../role-permissions.service'
import { FakeRbacClock } from '../testing/fake-clock'
import {
  fixtureMenus,
  fixturePermissions,
  makeRoleRows,
  type FixtureRole,
} from '../testing/fixtures'

const KEY = 'a'.repeat(64)

/** 与 nest-auth 的集成测试同一份最小 env。 */
export function testEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/taizan',
    REDIS_URL: 'redis://127.0.0.1:6379/0',
    JWT_SECRET_PLATFORM: 'p'.repeat(40),
    JWT_SECRET_STAFF: 's'.repeat(40),
    JWT_SECRET_MEMBER: 'm'.repeat(40),
    CRYPTO_KEYS: JSON.stringify({ k1: KEY }),
    CRYPTO_KEY_CURRENT: 'k1',
    LOG_LEVEL: 'fatal',
  }
}

/** 商家后台的被测控制器。每条路由的 `@RequirePermission` 就是被断言的东西。 */
@Controller('api/admin/goods')
export class GoodsTestController {
  /** 只读：`goods:list`。 */
  @Get()
  @RequirePermission('goods:list')
  list(): { ok: true } {
    return { ok: true }
  }

  /** 写：`goods:write`。任务分解 T1-2 验收里那条 `POST /api/admin/goods`。 */
  @Post()
  @RequirePermission('goods:write')
  create(): { ok: true } {
    return { ok: true }
  }

  /** 或表达式。 */
  @Get('either')
  @RequirePermission('goods:list|order:list')
  either(): { ok: true } {
    return { ok: true }
  }

  /** 与表达式。 */
  @Get('both')
  @RequirePermission(['goods:list', 'order:list'])
  both(): { ok: true } {
    return { ok: true }
  }

  /** 引用了一个**没注册**的权限点，用来验证运行时兜底是「拒绝 + 打日志」。 */
  @Get('ghost')
  @RequirePermission('ghost:code')
  ghost(): { ok: true } {
    return { ok: true }
  }

  /** 没有任何权限声明：本守卫放行（认证已经由 GlobalAuthGuard 兜住）。 */
  @Get('open')
  open(): { ok: true } {
    return { ok: true }
  }

  /** 数据范围：`ownerField: createdBy`，`groupField: deptId`。 */
  @Get('scoped')
  @RequirePermission('goods:list')
  @DataScope({ ownerField: 'createdBy', groupField: 'deptId' })
  scoped(@ScopeWhere() scope: Record<string, unknown> | null): {
    scope: Record<string, unknown> | null
  } {
    return { scope }
  }

  /** 只标 `@DataScope()` 不标权限，验证拦截器与守卫互不依赖。 */
  @Get('scoped-only')
  @DataScope({ ownerField: 'createdBy' })
  scopedOnly(@ScopeWhere() scope: Record<string, unknown> | null): {
    scope: Record<string, unknown> | null
  } {
    return { scope }
  }
}

/** 平台面控制器：验证 platform 身份对商家侧权限点一路放行。 */
@Controller('api/platform/goods')
export class PlatformGoodsTestController {
  @Post()
  @RequirePermission('goods:write')
  create(): { ok: true } {
    return { ok: true }
  }
}

/** 脚手架。 */
export interface Harness {
  app: INestApplication
  clock: FakeRbacClock
  prisma: FakePrismaControls
  memberships: FakeMembershipProvider
  flow: AuthFlowService
  rolePermissions: RolePermissionsService
  bootstrap: BootstrapService
  /** 记录 error 级日志（断言「未注册 code 会报错」）。 */
  errors: string[]
}

/** {@link createHarness} 的选项。 */
export interface HarnessOptions {
  /** 预置的 `Role` 行。 */
  roles?: readonly FixtureRole[]
  /** `SUB_TREE` 解析器。 */
  subtreeResolver?: SubtreeResolver
}

/** 起一个完整的 app。 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const clock = new FakeRbacClock()
  const redis = new InMemoryAuthRedis(() => clock.now())
  const fake = createFakePrisma()
  const memberships = new FakeMembershipProvider()
  const errors: string[] = []

  fake.controls.on('Role', 'findMany', makeRoleRows(options.roles ?? []))

  @Module({
    imports: [
      CoreModule.forRoot({ envSource: testEnv(), registerHealthController: false }),
      PrismaModule.forRoot({
        // Role 登记成租户域模型：守卫走 `prisma.tenant` 时租户条件由扩展自动注入，
        // 这条链路（上下文里有 tenantId → 扩展注入 → 替身记录 args）也一并被覆盖。
        registered: { has: (model: string): boolean => model === 'Role' },
        softDeleteModels: new Set<string>(),
        client: fake.client,
        connectOnInit: false,
      }),
      AuthModule.forRoot({
        redis,
        clock,
        membershipProvider: memberships,
        // GlobalAuthGuard 由 AuthModule 自己注册进 APP_GUARD（它没导出这个类，
        // 应用侧拿不到它来 useExisting）。Nest 按 provider 的注册顺序执行全局守卫，
        // 被 import 的模块先于本模块的 providers，所以链路仍然是
        // GlobalAuthGuard → PermissionsGuard。
        registerGlobalGuard: true,
      }),
      RbacModule.forRoot({
        permissions: [fixturePermissions()],
        menus: [fixtureMenus()],
        features: [
          { key: 'order', name: '订单', writeOnly: true, pathPrefixes: ['/api/admin/orders'] },
          {
            key: 'marketing',
            name: '营销',
            writeOnly: true,
            pathPrefixes: ['/api/admin/coupons'],
          },
        ],
        clock,
        // ── 守卫链顺序（蓝图 §4.3）─────────────────────────────────
        // Nest 的全局守卫按「模块实例化顺序 → 模块内 providers 数组顺序」执行，
        // 而**根模块排在它 import 的模块之前**。所以在根模块 providers 里写
        // `providePermissionsGuard()` 会让它跑在 AuthModule 内部注册的
        // GlobalAuthGuard **前面**（表现：req.principal 还没挂，一律 1340300）。
        //
        // 这里改由两个模块各自注册、靠 import 顺序定序：
        //   AuthModule（GlobalAuthGuard）→ RbacModule（PermissionsGuard）。
        // 想把顺序写在一个 providers 数组里，前提是 nest-auth 导出 GlobalAuthGuard
        // 供 useExisting——见 README/交接说明里的待办。
        registerGlobalGuard: true,
        registerGlobalInterceptor: true,
        ...(options.subtreeResolver === undefined
          ? {}
          : { subtreeResolver: options.subtreeResolver }),
      }),
    ],
    controllers: [GoodsTestController, PlatformGoodsTestController],
  })
  class TestAppModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile()
  const app = moduleRef.createNestApplication({ logger: false })

  const { AppLogger } = await import('@taizan/nest-core')
  const logger = moduleRef.get<{ error: (m: string, c?: string) => void }>(AppLogger)
  const originalError = logger.error.bind(logger)
  logger.error = (message: string, context?: string): void => {
    errors.push(message)
    originalError(message, context)
  }

  await app.init()

  return {
    app,
    clock,
    prisma: fake.controls,
    memberships,
    flow: moduleRef.get(AuthFlowService),
    rolePermissions: moduleRef.get(RolePermissionsService),
    bootstrap: moduleRef.get(BootstrapService),
    errors,
  }
}

/** 造一条 ACTIVE 的成员关系。 */
export function activeMembership(overrides: Partial<Membership> = {}): Membership {
  return {
    staffId: 'STAFF00000000000000000001',
    status: 'ACTIVE',
    roleIds: [],
    dataScope: 'ALL',
    isOwner: false,
    ...overrides,
  }
}
