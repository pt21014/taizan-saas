/**
 * 集成测试脚手架：一个真的 Nest app，装着 `CoreModule` + `PrismaModule`（替身客户端）
 * + `AuthModule`，外加几个专门用来被打的控制器。
 *
 * 为什么要起真 app 而不是直接 new 一个守卫来调 `canActivate`：本包一半的行为是
 * **装配**（APP_GUARD 挂没挂上、中间件排没排除、装饰器 metadata 读不读得到），
 * 手工调守卫方法把这一半全绕过去了，绿了也不说明装配是对的。
 *
 * 本文件不是 spec（文件名不以 `.spec.ts` 结尾），vitest 不会把它当测试跑。
 *
 * @packageDocumentation
 */

import 'reflect-metadata'
import { Body, Controller, Get, Inject, Module, Post, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { currentContext } from '@taizan/nest-core'
import { CoreModule } from '@taizan/nest-core'
import { PrismaModule } from '@taizan/nest-prisma'
import {
  createFakePrisma,
  type FakePrismaControls,
  type RecordedCall,
} from '@taizan/nest-prisma/testing'
import { AuthFlowService } from '../auth-flow.service'
import { AuthModule } from '../auth.module'
import { CaptchaService } from '../captcha/captcha.service'
import { Auth, CurrentUser, Public, RateLimited } from '../decorators'
import {
  CachedMembershipProvider,
  MEMBERSHIP_TTL_MS,
  type Membership,
  type MembershipProvider,
} from '../membership/membership.provider'
import type { AuthPrincipal } from '../principal'
import { provideRateLimitGuard } from '../ratelimit/provide'
import { InMemoryAuthRedis } from '../redis'
import { SessionService } from '../session/session.service'
import { TokenService } from '../token/token.service'
import { FakeClock } from '../testing/fake-clock'
import { FakeMembershipProvider } from '../testing/fake-membership'
import type { ConcurrencyLimits } from '../session/session.service'

const KEY = 'a'.repeat(64)

/** 与 nest-core 的集成测试同一份最小 env。 */
export function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
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
    // 线上拓扑是 客户端 → EdgeOne → nginx → Node，末尾两段由基础设施追加。
    TRUSTED_PROXY_HOPS: '2',
    ...overrides,
  }
}

/**
 * 一个 `incr` 永远失败的 Redis：模拟「Redis 挂了」。
 *
 * 只让 `incr` 挂、其余命令照常，是为了把「限流退回进程内」这条路径单独拎出来测——
 * 整个 Redis 都挂掉的话会话也没了，测出来的是另一件事。
 */
export class IncrBrokenRedis extends InMemoryAuthRedis {
  override async incr(_key: string): Promise<number> {
    throw new Error('ECONNREFUSED 127.0.0.1:6379')
  }
}

/** 回给测试的、上下文里那几个字段的快照。 */
export interface ContextEcho {
  tenantId: string | null
  identityKind: string | null
  identityId: string | null
}

function echoContext(): ContextEcho {
  const ctx = currentContext()
  return {
    tenantId: ctx?.tenantId ?? null,
    identityKind: ctx?.identity?.kind ?? null,
    identityId: ctx?.identity?.id ?? null,
  }
}

/**
 * 平台面控制器（`/api/platform` 是免租户前缀）。
 *
 * `none()` **一个装饰器都不加**——它就是「默认拒绝」这条不变量的活体样本。
 */
@Controller('api/platform/t')
export class PlatformTestController {
  /** 没有 @Public()、没有 @Auth()。期望：无 token 一律 401。 */
  @Get('none')
  none(): ContextEcho {
    return echoContext()
  }

  @Get('any')
  @Auth('platform')
  platformOnly(@CurrentUser() user: AuthPrincipal): AuthPrincipal {
    return user
  }
}

/** 公共面控制器（免租户 + 免登录）。 */
@Controller('api/public')
export class PublicTestController {
  @Get('ping')
  @Public()
  @RateLimited('public-default')
  ping(): ContextEcho {
    return echoContext()
  }

  /** 故意漏掉 @RateLimited，用来验证守卫会 warn（spec 5 的运行时半边）。 */
  @Get('unthrottled')
  @Public()
  unthrottled(): { ok: boolean } {
    return { ok: true }
  }
}

/** `/api/admin/t/staff-only` 的响应形状。 */
export interface StaffEcho extends AuthPrincipal {
  context: ContextEcho
}

/** 商家面控制器。 */
@Controller('api/admin/t')
export class AdminTestController {
  @Get('staff-only')
  @Auth('staff')
  staffOnly(@CurrentUser() user: AuthPrincipal): StaffEcho {
    // 上下文快照的 tenantId 用 null 表示「没有」，而 AuthPrincipal 用 undefined，
    // 两者展开后会打架，所以回一个独立的形状而不是交叉类型。
    return { ...user, context: echoContext() }
  }

  @Get('any-identity')
  anyIdentity(@CurrentUser() user: AuthPrincipal): AuthPrincipal {
    return user
  }

  @Post('logout')
  @Auth('staff')
  async logout(@CurrentUser() user: AuthPrincipal): Promise<{ ok: boolean }> {
    await this.flow.logout(user)
    return { ok: true }
  }

  constructor(@Inject(AuthFlowService) private readonly flow: AuthFlowService) {}
}

/** C 端控制器（`X-Tenant-Slug` 只在这个前缀下生效）。 */
@Controller('api/client')
export class ClientTestController {
  @Get('whoami')
  @Public()
  @RateLimited('public-default')
  whoami(): ContextEcho {
    return echoContext()
  }
}

/**
 * 限流用的控制器（T2-6）。
 *
 * 三条路由分别覆盖：挂了档位的公开路由、没挂档位的公开路由（不该被限）、
 * 以及「业务流程在拿到账号之后自己补算账号维度」那条路径。
 */
@Controller('api/public/rl')
export class RateLimitTestController {
  constructor(@Inject(AuthFlowService) private readonly flow: AuthFlowService) {}

  /** 挂了 login 档（clientLimit=10）。回一份上下文里的 IP，方便断言限流 key 的来源。 */
  @Post('login-ish')
  @Public()
  @RateLimited('login')
  loginIsh(): { client: string; edge: string } {
    const ctx = currentContext()
    return { client: ctx?.ip.client ?? '', edge: ctx?.ip.edge ?? '' }
  }

  /** 挂了 login 档，并且**业务流程再补算一次账号维度**（成功也计数）。 */
  @Post('login-account')
  @Public()
  @RateLimited('login')
  async loginAccount(@Body() body: { account?: string }): Promise<{ ok: boolean }> {
    await this.flow.countAttempt('login', body.account ?? 'anonymous')
    return { ok: true }
  }

  /** 没挂 `@RateLimited`：本守卫不该管它（代价是 GlobalAuthGuard 会 warn 一条）。 */
  @Get('unlimited')
  @Public()
  unlimited(): { ok: boolean } {
    return { ok: true }
  }
}

/** 一个 `Tenant` 行（替身库里的）。 */
export interface FakeTenant {
  id: string
  slug: string
  status: string
}

/** 脚手架。 */
export interface Harness {
  app: INestApplication
  clock: FakeClock
  redis: InMemoryAuthRedis
  prisma: FakePrismaControls
  memberships: FakeMembershipProvider
  tokens: TokenService
  sessions: SessionService
  flow: AuthFlowService
  captcha: CaptchaService
  /** 记录每个 warn 调用（断言「公开路由没限流会 warn」）。 */
  warnings: string[]
  /** 记录每个 error 调用（断言「限流降级会打 error 日志」）。 */
  errors: string[]
}

/** {@link createHarness} 的选项。 */
export interface HarnessOptions {
  /** 预置的租户行（`SlugHeaderResolver` / `SubdomainResolver` 会查它）。 */
  tenants?: FakeTenant[]
  /** 并发端数上限覆盖。 */
  concurrency?: Partial<ConcurrencyLimits>
  /** 成员关系缓存有效期（毫秒）。 */
  membershipTtlMs?: number
  /** access TTL 覆盖（秒）。 */
  accessTtl?: Partial<Record<'platform' | 'staff' | 'member', number>>
  /** 子域名解析的根域。 */
  baseDomain?: string
  /**
   * 给成员关系提供者套上 30 秒缓存（默认不套）。
   *
   * 默认不套是因为大多数用例要断言的是「守卫每请求都问了一次」，套了缓存反而看不出来；
   * 只有「撤权延迟 ≤30 秒」那条用例需要真实的缓存行为。
   */
  cacheMembership?: boolean
  /** 用一个 `incr` 永远失败的 Redis（验证限流降级仍然拦得住）。 */
  brokenRedis?: boolean
  /** env 覆盖（比如把 `TRUSTED_PROXY_HOPS` 改成 1 来验证 hops 生效）。 */
  env?: Record<string, string>
}

function wrapMembership(
  inner: FakeMembershipProvider,
  options: HarnessOptions,
  clock: FakeClock,
): MembershipProvider {
  if (!options.cacheMembership) return inner
  return new CachedMembershipProvider(inner, clock, options.membershipTtlMs ?? MEMBERSHIP_TTL_MS)
}

/** 起一个完整的 app。 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const clock = new FakeClock()
  const redis = options.brokenRedis
    ? new IncrBrokenRedis(() => clock.now())
    : new InMemoryAuthRedis(() => clock.now())
  const fake = createFakePrisma()
  const memberships = new FakeMembershipProvider()
  const warnings: string[] = []
  const errors: string[] = []

  const tenants = options.tenants ?? []
  fake.controls.on('Tenant', 'findFirst', (call: RecordedCall) => {
    const args = call.args as { where?: { slug?: string } } | undefined
    const slug = args?.where?.slug
    return tenants.find((t) => t.slug === slug) ?? null
  })

  @Module({
    imports: [
      CoreModule.forRoot({
        envSource: testEnv(options.env ?? {}),
        registerHealthController: false,
      }),
      PrismaModule.forRoot({
        registered: { has: () => false },
        softDeleteModels: new Set<string>(),
        client: fake.client,
        connectOnInit: false,
      }),
      AuthModule.forRoot({
        redis,
        clock,
        membershipProvider: wrapMembership(memberships, options, clock),
        ...(options.concurrency ? { concurrency: options.concurrency } : {}),
        ...(options.membershipTtlMs !== undefined
          ? { membershipTtlMs: options.membershipTtlMs }
          : {}),
        ...(options.accessTtl ? { ttl: { access: options.accessTtl } } : {}),
        ...(options.baseDomain ? { baseDomain: options.baseDomain } : {}),
      }),
    ],
    controllers: [
      PlatformTestController,
      PublicTestController,
      AdminTestController,
      ClientTestController,
      RateLimitTestController,
    ],
    // 与 apps/api 的装配一致：限流守卫排在 GlobalAuthGuard 之前。
    providers: [...provideRateLimitGuard()],
  })
  class TestAppModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile()
  const app = moduleRef.createNestApplication({ logger: false })

  // 把守卫的 warn 收进数组。AppLogger 是 CoreModule 提供的单例，直接替它的方法最省事。
  const logger = moduleRef.get<{
    warn: (m: string, c?: string) => void
    error: (m: string, s?: string, c?: string) => void
  }>((await import('@taizan/nest-core')).AppLogger)
  const originalWarn = logger.warn.bind(logger)
  logger.warn = (message: string, context?: string): void => {
    warnings.push(message)
    originalWarn(message, context)
  }
  const originalError = logger.error.bind(logger)
  logger.error = (message: string, stack?: string, context?: string): void => {
    errors.push(message)
    originalError(message, stack, context)
  }

  await app.init()

  return {
    app,
    clock,
    redis,
    prisma: fake.controls,
    memberships,
    tokens: moduleRef.get(TokenService),
    sessions: moduleRef.get(SessionService),
    flow: moduleRef.get(AuthFlowService),
    captcha: moduleRef.get(CaptchaService),
    warnings,
    errors,
  }
}

/** 造一条 ACTIVE 的成员关系。 */
export function activeMembership(overrides: Partial<Membership> = {}): Membership {
  return {
    staffId: 'STAFF00000000000000000001',
    status: 'ACTIVE',
    roleIds: ['role-db'],
    dataScope: 'SELF',
    isOwner: false,
    ...overrides,
  }
}
