/**
 * 装配入口。
 *
 * @packageDocumentation
 */

import {
  type DynamicModule,
  Global,
  Inject,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type Provider,
  RequestMethod,
} from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { IP_RESOLVER } from '@taizan/nest-core'
import { RawPrismaService } from '@taizan/nest-prisma'
import { assertAllTiersSane } from '@taizan/ratelimit-core'
import { AuthFlowService } from './auth-flow.service'
import { CaptchaService } from './captcha/captcha.service'
import { systemClock, type Clock } from './clock'
import { GlobalAuthGuard } from './guards/global-auth.guard'
import {
  CachedMembershipProvider,
  MEMBERSHIP_TTL_MS,
  PrismaMembershipProvider,
  type MembershipProvider,
} from './membership/membership.provider'
import type { AuthRedis } from './redis'
import {
  DEFAULT_CONCURRENCY,
  SessionService,
  type ConcurrencyLimits,
} from './session/session.service'
import { TokenService } from './token/token.service'
import { resolveTtl, type TokenTtlConfig, type TokenTtlOverrides } from './token/ttl'
import {
  SlugHeaderResolver,
  SubdomainResolver,
  TokenTenantResolver,
} from './tenant-resolver/resolvers'
import { TENANT_FREE_PREFIXES, type TenantResolverStrategy } from './tenant-resolver/strategy'
import { TenantMiddleware, TenantResolverChain } from './tenant-resolver/tenant.middleware'
import { ResolveIpsAdapter } from './ratelimit/ip-resolver'
import { RateLimitGuard } from './ratelimit/rate-limit.guard'
import { RateLimitService, type RateLimitRuntimeOptions } from './ratelimit/rate-limit.service'
import { AuthRedisRateLimitStore } from './ratelimit/store'
import {
  AUTH_CLOCK,
  AUTH_CONCURRENCY,
  AUTH_OPTIONS,
  AUTH_REDIS,
  AUTH_TTL,
  MEMBERSHIP_PROVIDER,
  RATE_LIMIT_OPTIONS,
  RATE_LIMIT_STORE,
  TENANT_RESOLVERS,
} from './tokens'

/** {@link AuthModule.forRoot} 的选项。 */
export interface AuthModuleOptions {
  /**
   * Redis 客户端。`new Redis(env.REDIS_URL)` 直接传进来即可（`ioredis` 的实例
   * 天然满足 {@link AuthRedis}）；测试传 `InMemoryAuthRedis`。
   */
  redis: AuthRedis
  /**
   * 覆盖成员关系提供者。不传就用 {@link PrismaMembershipProvider} 套一层
   * {@link CachedMembershipProvider}（30 秒缓存）。
   *
   * 传自定义实现时**缓存要自己套**——不替你包，是因为外部实现可能自带缓存，
   * 套两层反而让撤权延迟翻倍且难排查。
   */
  membershipProvider?: MembershipProvider
  /** token 有效期覆盖，见 `token/ttl.ts` 的默认值表。 */
  ttl?: TokenTtlOverrides
  /** 各 kind 的并发端数上限，见 {@link DEFAULT_CONCURRENCY}。 */
  concurrency?: Partial<ConcurrencyLimits>
  /**
   * 租户解析链。不传就用内置三件套（token → slug 头 → 子域名）。
   *
   * 传了就**整条替换**（不是追加）：顺序即优先级，追加语义下没人说得清新策略
   * 该插在哪一档，不如让下游把完整顺序写出来。
   */
  tenantResolvers?: readonly TenantResolverStrategy[]
  /** 子域名解析用的根域，如 `example.com`。不配时 `SubdomainResolver` 退化成取 Host 第一段。 */
  baseDomain?: string
  /** 是否注册 `TenantMiddleware`，默认 `true`。平台专用进程可以关掉。 */
  registerTenantMiddleware?: boolean
  /** 是否把 `GlobalAuthGuard` 注册成 `APP_GUARD`，默认 `true`。**关掉等于关掉默认拒绝**。 */
  registerGlobalGuard?: boolean
  /** 时钟。测试里传可推进的假时钟。 */
  clock?: Clock
  /** 成员关系缓存有效期（毫秒），默认 {@link MEMBERSHIP_TTL_MS}。 */
  membershipTtlMs?: number
  /**
   * 限流的运行时配置（key 前缀、降级日志限频）。
   *
   * 档位表本身**不在这里配**——它在 `@taizan/ratelimit-core` 的 `RATE_LIMIT_TIERS`，
   * 业务项目要加档位用 `defineTier`（定义即校验）。放在这里能配的话，
   * 「入口/账号维度必须宽松」这条不变量就会变成一个可以被 `.env` 悄悄改掉的东西。
   */
  rateLimit?: RateLimitRuntimeOptions
  /**
   * 是否把 `resolveIps` 注册成 `@taizan/nest-core` 的 {@link IP_RESOLVER}，默认 `true`。
   *
   * **关掉等于让 `ctx.ip.client` 停在占位实现上**（粒度 = 直连我们的那一跳），
   * 限流会误伤同一入口后面的所有人。只有在应用自己往 `CoreModule.forRoot({ ipResolver })`
   * 传了实现时才该关。
   */
  registerIpResolver?: boolean
}

/** {@link AUTH_OPTIONS} 里存的东西：只有 `configure()` 需要的那部分。 */
export interface ResolvedOptions {
  registerTenantMiddleware: boolean
}

/**
 * 三套身份认证模块（蓝图 T0-7）。
 *
 * ## 一次 `forRoot()` 接好这些
 *
 * - `TokenService`（三把密钥、HS256、kind 校验、refresh 一次性轮换）；
 * - `SessionService`（Redis 按 jti 的多会话，改密全撤、超端数踢最旧）；
 * - `MembershipProvider`（staff 每请求现查 + 30 秒缓存 + 库里角色覆盖 token）；
 * - `GlobalAuthGuard` 注册为 `APP_GUARD`（**默认拒绝**）；
 * - `TenantMiddleware`（三条策略有序解析，排除 {@link TENANT_FREE_PREFIXES}）；
 * - `CaptchaService`、`AuthFlowService`。
 *
 * ## `@Global()` 的理由
 *
 * `@CurrentUser()` 与 `AuthPrincipal` 会出现在几乎每个业务模块里，让它们逐个
 * `imports: [AuthModule]` 是纯噪音；而全局守卫本来就是全局的。
 *
 * ## 前置条件
 *
 * 必须在 `CoreModule.forRoot()` **之后**导入——`TokenService` 要注入 `ConfigService`，
 * `TenantMiddleware` 要 `patchCurrentContext`（依赖 `ContextMiddleware` 先跑）。
 * 中间件顺序由 Nest 按模块 `configure()` 的注册先后决定，`CoreModule` 在前就对了。
 */
@Global()
@Module({})
export class AuthModule implements NestModule {
  static forRoot(options: AuthModuleOptions): DynamicModule {
    const {
      redis,
      membershipProvider,
      ttl,
      concurrency,
      tenantResolvers,
      baseDomain,
      registerTenantMiddleware = true,
      registerGlobalGuard = true,
      clock = systemClock,
      membershipTtlMs = MEMBERSHIP_TTL_MS,
      rateLimit,
      registerIpResolver = true,
    } = options

    // 档位表在装配时校验一次：「入口/账号维度必须比客户端维度宽松」这条不变量
    // 要么在启动时炸，要么在线上被爆破时才发现，没有第三种。
    assertAllTiersSane()

    const ttlConfig: TokenTtlConfig = resolveTtl(ttl)
    const limits: ConcurrencyLimits = { ...DEFAULT_CONCURRENCY, ...(concurrency ?? {}) }

    const membershipProviderDef: Provider = membershipProvider
      ? { provide: MEMBERSHIP_PROVIDER, useValue: membershipProvider }
      : {
          provide: MEMBERSHIP_PROVIDER,
          useFactory: (inner: PrismaMembershipProvider): MembershipProvider =>
            new CachedMembershipProvider(inner, clock, membershipTtlMs),
          inject: [PrismaMembershipProvider],
        }

    const resolversDef: Provider = tenantResolvers
      ? { provide: TENANT_RESOLVERS, useValue: tenantResolvers }
      : {
          provide: TENANT_RESOLVERS,
          useFactory: (
            tokens: TokenService,
            raw: RawPrismaService,
          ): readonly TenantResolverStrategy[] => [
            // 顺序即优先级，见 `tenant-resolver/resolvers.ts` 的文件头。
            new TokenTenantResolver(tokens),
            new SlugHeaderResolver(raw),
            new SubdomainResolver(raw, baseDomain),
          ],
          inject: [TokenService, RawPrismaService],
        }

    const providers: Provider[] = [
      // 归一化后的装配选项。`configure()` 是实例方法，要从这里读——
      // 用 static 字段存的话，同一进程里装配两次（测试里很常见）后一次会覆盖前一次。
      { provide: AUTH_OPTIONS, useValue: { registerTenantMiddleware } satisfies ResolvedOptions },
      { provide: AUTH_REDIS, useValue: redis },
      { provide: AUTH_TTL, useValue: ttlConfig },
      { provide: AUTH_CONCURRENCY, useValue: limits },
      { provide: AUTH_CLOCK, useValue: clock },
      SessionService,
      TokenService,
      CaptchaService,
      // 即使下游换了 membershipProvider，默认实现也照样注册——
      // 它很便宜，而少一个可选分支就少一处「为什么这里注入不到」的排查。
      PrismaMembershipProvider,
      membershipProviderDef,
      resolversDef,
      TenantResolverChain,
      TenantMiddleware,
      AuthFlowService,
      GlobalAuthGuard,
      // ── 限流（T2-6）────────────────────────────────────────────────────
      { provide: RATE_LIMIT_OPTIONS, useValue: rateLimit ?? {} },
      AuthRedisRateLimitStore,
      { provide: RATE_LIMIT_STORE, useExisting: AuthRedisRateLimitStore },
      RateLimitService,
      // 守卫本体也注册在这里，好让 `apps/api` 的 provideRateLimitGuard() 能 useExisting；
      // 但**不**在这里注册成 APP_GUARD——顺序必须由应用决定，见 provide.ts 的注释。
      RateLimitGuard,
    ]

    if (registerIpResolver) {
      // 接上不变量 6 的真源：ctx.ip.client 从此是「XFF 末尾倒数 TRUSTED_PROXY_HOPS 段」。
      providers.push(ResolveIpsAdapter, {
        provide: IP_RESOLVER,
        useExisting: ResolveIpsAdapter,
      })
    }

    if (registerGlobalGuard) {
      // 注意：这里注册的是**同一个实例**（useExisting），不是再 new 一个。
      // 用 useClass 的话 GlobalAuthGuard 会有两份，那个记「已经 warn 过」的 Set
      // 就会各记各的，公开路由的告警要刷两遍。
      providers.push({ provide: APP_GUARD, useExisting: GlobalAuthGuard })
    }

    return {
      module: AuthModule,
      providers,
      exports: [
        AUTH_OPTIONS,
        AUTH_REDIS,
        AUTH_TTL,
        AUTH_CLOCK,
        SessionService,
        TokenService,
        CaptchaService,
        AuthFlowService,
        MEMBERSHIP_PROVIDER,
        TenantResolverChain,
        TENANT_RESOLVERS,
        RATE_LIMIT_STORE,
        RateLimitService,
        RateLimitGuard,
        ...(registerIpResolver ? [IP_RESOLVER] : []),
      ],
    }
  }

  constructor(@Inject(AUTH_OPTIONS) private readonly options: ResolvedOptions) {}

  /**
   * 挂载 `TenantMiddleware`，**排除免租户前缀**。
   *
   * `exclude()` 的入参直接来自 {@link TENANT_FREE_PREFIXES} 常量——spec 16
   * （`tenant-middleware.spec.ts`）会扫这个文件比对，手抄一份字符串会被它抓住。
   */
  configure(consumer: MiddlewareConsumer): void {
    if (!this.options.registerTenantMiddleware) return

    consumer
      .apply(TenantMiddleware)
      .exclude(
        // `{prefix}/(.*)` 覆盖子路径，裸 `{prefix}` 覆盖前缀本身。
        ...TENANT_FREE_PREFIXES.flatMap((prefix) => [
          { path: prefix, method: RequestMethod.ALL },
          { path: `${prefix}/*path`, method: RequestMethod.ALL },
        ]),
      )
      // 与 CoreModule 一致：Nest 11 底下是 Express 5 + path-to-regexp 8，
      // 裸 '*' 会被当成非法路径参数报 Missing parameter name。
      .forRoutes({ path: '*', method: RequestMethod.ALL })
  }
}
