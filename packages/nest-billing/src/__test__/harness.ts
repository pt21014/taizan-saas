/**
 * 集成测试脚手架：一个真的 Nest app，装着 `CoreModule` + `PrismaModule`（替身客户端）
 * + `AuthModule` + `BillingModule`，守卫链是 `GlobalAuthGuard → BillingGateGuard`。
 *
 * 为什么起真 app 而不是直接 new 一个守卫来调 `canActivate`：本包一半的行为是**装配**
 * （守卫顺序对不对、中间件排在租户解析之后没有、`req.principal` 读不读得到）。
 * 手工调守卫方法把这一半全绕过去了，绿了也不说明装配是对的。
 *
 * 本文件不是 spec（文件名不以 `.spec.ts` 结尾），vitest 不会把它当测试跑。
 *
 * @packageDocumentation
 */

import 'reflect-metadata'
import {
  Controller,
  Delete,
  Get,
  Module,
  Post,
  type INestApplication,
  type MiddlewareConsumer,
  type NestModule,
  RequestMethod,
} from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { FeatureDef } from '@taizan/billing-rules'
import { AppLogger, CoreModule, currentContext, patchCurrentContext } from '@taizan/nest-core'
import {
  AuthFlowService,
  AuthModule,
  InMemoryAuthRedis,
  Public,
  RateLimited,
} from '@taizan/nest-auth'
import { FakeClock, FakeMembershipProvider } from '@taizan/nest-auth/testing'
import { PrismaModule } from '@taizan/nest-prisma'
import {
  createFakePrisma,
  type FakePrismaControls,
  type RecordedCall,
} from '@taizan/nest-prisma/testing'
import type { NextFunction, Request, Response } from 'express'
import { BillingModule } from '../billing.module'
import { ConsumeQuota } from '../consume-quota.decorator'
import { PrismaPlatformGateway } from '../platform-gateway'
import { QuotaService } from '../quota.service'
import { TenantGateMiddleware } from '../tenant-gate.middleware'

const KEY = 'a'.repeat(64)

export const ACCOUNT = 'ACCT0000000000000000000001'
export const TENANT = 'TENANT000000000000000000A'
export const PLAN = 'PLAN00000000000000000001'

/** 与 nest-core / nest-auth 的集成测试同一份最小 env。 */
export function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'mysql://u:p@127.0.0.1:3306/taizan',
    REDIS_URL: 'redis://127.0.0.1:6379/0',
    JWT_SECRET_PLATFORM: 'p'.repeat(40),
    JWT_SECRET_STAFF: 's'.repeat(40),
    JWT_SECRET_MEMBER: 'm'.repeat(40),
    CRYPTO_KEYS: JSON.stringify({ k1: KEY }),
    CRYPTO_KEY_CURRENT: 'k1',
    LOG_LEVEL: 'fatal',
    ...overrides,
  }
}

/** 替身库里的一行 `Tenant`。 */
export interface FakeTenant {
  id: string
  slug: string
  name: string
  status: string
  planId: string | null
  planExpireAt: Date | null
  trialEndAt: Date | null
  graceDays: number
}

/** 替身库里的一行 `Plan`。 */
export interface FakePlan {
  id: string
  code: string
  name: string
  quotas: unknown
  features: unknown
}

/** 造一行租户。默认 ACTIVE、套餐到 2099 年。 */
export function fakeTenant(overrides: Partial<FakeTenant> = {}): FakeTenant {
  return {
    id: TENANT,
    slug: 'demo',
    name: '示例小店',
    status: 'ACTIVE',
    planId: PLAN,
    planExpireAt: new Date('2099-12-31T15:59:59.999Z'),
    trialEndAt: null,
    graceDays: 0,
    ...overrides,
  }
}

/** 造一行套餐。默认不限量、全部功能。 */
export function fakePlan(overrides: Partial<FakePlan> = {}): FakePlan {
  return { id: PLAN, code: 'basic', name: '基础版', quotas: {}, features: null, ...overrides }
}

// ─────────────────────────── 控制器 ───────────────────────────

/** 商品：普通业务路径，闸门该拦的就是它。 */
@Controller('api/admin/goods')
export class AdminGoodsController {
  @Get()
  list(): { ok: boolean } {
    return { ok: true }
  }

  @Post()
  create(): { ok: boolean } {
    return { ok: true }
  }

  @Delete(':id')
  remove(): { ok: boolean } {
    return { ok: true }
  }
}

/** 账单：续费白名单里的路径，到期后**必须**还能写。 */
@Controller('api/admin/billing')
export class AdminBillingController {
  @Post('order')
  order(): { ok: boolean } {
    return { ok: true }
  }
}

/** 营销：功能开关 `marketing` 盖住的路径。 */
@Controller('api/admin/marketing')
export class AdminMarketingController {
  @Get('coupons')
  list(): { ok: boolean } {
    return { ok: true }
  }

  @Post('coupons')
  create(): { ok: boolean } {
    return { ok: true }
  }
}

/** 员工：`@ConsumeQuota('STAFF')` 的活体样本（拦截器要在真 app 里才跑得起来）。 */
@Controller('api/admin/staff')
export class AdminStaffController {
  @Post()
  @ConsumeQuota('STAFF')
  create(): { ok: boolean } {
    return { ok: true }
  }

  /** 业务故意失败，用来验证「先占后还」里的「还」。 */
  @Post('boom')
  @ConsumeQuota('STAFF')
  boom(): { ok: boolean } {
    throw new Error('业务炸了')
  }
}

/** C 端：闸门中间件的靶子。全部 `@Public()`——打烊要拦的正是没登录的顾客。 */
@Controller('api/client')
export class ClientController {
  @Get('goods')
  @Public()
  @RateLimited('public-read')
  goods(): { tenantId: string | null } {
    return { tenantId: currentContext()?.tenantId ?? null }
  }
}

/**
 * 把 tenantId 塞进上下文的假中间件，代替 `TenantMiddleware`。
 *
 * 真的那条要查库解析 slug，而本包要测的是**它之后**发生的事；用假的能让
 * 「租户解析不出来时闸门放行」这条也变得可测（不塞就是没解析出来）。
 */
export function makeTenantStub(tenantId: string | null) {
  return (_req: Request, _res: Response, next: NextFunction): void => {
    if (tenantId !== null) patchCurrentContext({ tenantId })
    next()
  }
}

// ─────────────────────────── 脚手架 ───────────────────────────

/** {@link createHarness} 的选项。 */
export interface HarnessOptions {
  tenants?: FakeTenant[]
  plans?: FakePlan[]
  features?: readonly FeatureDef[]
  enforce?: boolean
  /** 挂 C 端闸门中间件（默认挂）。 */
  clientGate?: boolean
  /** C 端中间件之前假装解析出来的租户；`null` = 没解析出来。 */
  clientTenantId?: string | null
  /** 闸门缓存有效期（毫秒）。 */
  cacheTtlMs?: number
}

/** 脚手架。 */
export interface Harness {
  app: INestApplication
  clock: FakeClock
  prisma: FakePrismaControls
  gateway: PrismaPlatformGateway
  quota: QuotaService
  flow: AuthFlowService
  /** 收集到的 warn 文本。 */
  warnings: string[]
  /** 签一个 staff token。 */
  staffToken(tenantId?: string): Promise<string>
  /** 内存版 `QuotaCounter` 表，断言用量用。 */
  counters: Map<string, { id: string; used: number; version: number }>
}

/** 起一个完整的 app。 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const clock = new FakeClock(Date.UTC(2026, 5, 15, 4, 0, 0))
  const redis = new InMemoryAuthRedis(() => clock.now())
  const fake = createFakePrisma()
  const memberships = new FakeMembershipProvider()
  const warnings: string[] = []

  const tenants = options.tenants ?? [fakeTenant()]
  const plans = options.plans ?? [fakePlan()]

  fake.controls.on('Tenant', 'findUnique', (call: RecordedCall) => {
    const id = (call.args as { where?: { id?: string } }).where?.id
    return tenants.find((t) => t.id === id) ?? null
  })
  fake.controls.on('Plan', 'findUnique', (call: RecordedCall) => {
    const id = (call.args as { where?: { id?: string } }).where?.id
    return plans.find((p) => p.id === id) ?? null
  })

  // 内存版 QuotaCounter 表：一个 `tenantId:kind` 一行，够本包的用例用。
  const counters = new Map<string, { id: string; used: number; version: number }>()
  const counterKey = (args: unknown): string => {
    const w = (args as { where?: { tenantId?: string; kind?: string } }).where
    return `${String(w?.tenantId)}:${String(w?.kind)}`
  }
  fake.controls.on('QuotaCounter', 'findFirst', (call: RecordedCall) => {
    const row = counters.get(counterKey(call.args))
    return row === undefined ? null : { ...row }
  })
  fake.controls.on('QuotaCounter', 'create', (call: RecordedCall) => {
    const d = (call.args as { data: { id: string; tenantId: string; kind: string; used: number } })
      .data
    const row = { id: d.id, used: d.used, version: 0 }
    counters.set(`${d.tenantId}:${d.kind}`, row)
    return row
  })
  fake.controls.on('QuotaCounter', 'updateMany', (call: RecordedCall) => {
    const a = call.args as { where: { id: string; version: number }; data: { used: number } }
    for (const [key, row] of counters) {
      if (row.id === a.where.id && row.version === a.where.version) {
        counters.set(key, { ...row, used: a.data.used, version: row.version + 1 })
        return { count: 1 }
      }
    }
    return { count: 0 }
  })

  memberships.set(ACCOUNT, TENANT, {
    staffId: 'STAFF00000000000000000001',
    status: 'ACTIVE',
    roleIds: [],
    dataScope: 'ALL',
    isOwner: true,
  })

  const clientGate = options.clientGate ?? true
  const clientTenantId = options.clientTenantId === undefined ? TENANT : options.clientTenantId
  const tenantStub = makeTenantStub(clientTenantId)

  @Module({
    imports: [
      CoreModule.forRoot({ envSource: testEnv(), registerHealthController: false }),
      PrismaModule.forRoot({
        registered: { has: () => false },
        softDeleteModels: new Set<string>(),
        client: fake.client,
        connectOnInit: false,
      }),
      AuthModule.forRoot({
        redis,
        clock,
        membershipProvider: memberships,
        // 租户解析用假中间件（见 makeTenantStub），真的那条要查库解析 slug。
        registerTenantMiddleware: false,
      }),
      BillingModule.forRoot({
        features: options.features ?? [],
        enforce: options.enforce ?? true,
        clock,
        ...(options.cacheTtlMs !== undefined
          ? { gatewayOptions: { cacheTtlMs: options.cacheTtlMs } }
          : {}),
        // BillingModule 自己挂中间件时排在 CoreModule 之后即可；
        // 假租户中间件在本模块的 configure() 里更早挂上（见下）。
        registerClientMiddleware: false,
        registerGlobalGuard: true,
      }),
    ],
    controllers: [
      AdminGoodsController,
      AdminBillingController,
      AdminMarketingController,
      AdminStaffController,
      ClientController,
    ],
  })
  class TestAppModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
      // 顺序就是生产里的顺序：ContextMiddleware（CoreModule 已挂）→ 租户解析 → 计费闸门。
      consumer.apply(tenantStub).forRoutes({ path: '*path', method: RequestMethod.ALL })
      if (clientGate) {
        consumer.apply(TenantGateMiddleware).forRoutes({ path: '*path', method: RequestMethod.ALL })
      }
    }
  }

  const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile()
  const app = moduleRef.createNestApplication({ logger: false })

  const logger = moduleRef.get(AppLogger)
  const originalWarn = logger.warn.bind(logger)
  logger.warn = (message: unknown, context?: string): void => {
    warnings.push(String(message))
    originalWarn(message, context)
  }

  await app.init()

  const flow = moduleRef.get(AuthFlowService)

  return {
    app,
    clock,
    prisma: fake.controls,
    gateway: moduleRef.get(PrismaPlatformGateway),
    quota: moduleRef.get(QuotaService),
    flow,
    warnings,
    counters,
    async staffToken(tenantId = TENANT): Promise<string> {
      const r = await flow.loginStaff(ACCOUNT, tenantId)
      return r.access
    },
  }
}
