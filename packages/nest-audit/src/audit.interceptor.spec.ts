import 'reflect-metadata'
import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  type INestApplication,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common'
import { APP_INTERCEPTOR } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import {
  AppLogger,
  ContextMiddleware,
  HealthCounters,
  patchCurrentContext,
} from '@taizan/nest-core'
import type { RequestContext } from '@taizan/nest-core'
import { isUlid } from '@taizan/contracts'
import { PrismaService } from '@taizan/nest-prisma'
import { createFakePrisma, type FakePrismaControls } from '@taizan/nest-prisma/testing'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { Audit } from './audit.decorator'
import { AuditInterceptor } from './audit.interceptor'
import { AuditService } from './audit.service'
import type { AuditSnapshot } from './types'

/** 只取字符串形态的 route param——Express 5 的 `ParamsDictionary` 允许值是 `string[]`。 */
function stringParam(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * 记下每一次 error/warn 调用，供断言「审计写失败不能吞」。
 *
 * 直接继承 `AppLogger`（而不是 `NoopAppLogger`）：`NoopAppLogger` 把各方法的重写签名
 * 收窄成零参数，再在它之上覆写回 `AppLogger` 原本的参数列表会被 TS 判定为不兼容的
 * override。构造函数传的假 pino 实例本身不会被调用——本类覆写了全部会被
 * `AuditInterceptor` 用到的方法（`error` / `warn`）。
 */
class RecordingLogger extends AppLogger {
  readonly errors: Array<{ message: unknown; stack?: string; context?: string }> = []
  readonly warns: Array<{ message: unknown; context?: string }> = []

  constructor() {
    super({} as ConstructorParameters<typeof AppLogger>[0])
  }

  override error(message: unknown, stack?: string, context?: string): void {
    this.errors.push({ message, stack, context })
  }

  override warn(message: unknown, context?: string): void {
    this.warns.push({ message, context })
  }
}

/** 测试用的「登录态」注入中间件：从请求头读一段 JSON，模拟守卫认证成功后补的上下文。 */
@Injectable()
class TestIdentityMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const header = req.headers['x-test-identity']
    if (typeof header === 'string') {
      const json = Buffer.from(header, 'base64').toString('utf8')
      const parsed = JSON.parse(json) as {
        kind: 'platform' | 'staff' | 'member'
        id: string
        tenantId?: string
        name?: string
      }
      const patch: Partial<RequestContext> = { identity: { kind: parsed.kind, id: parsed.id } }
      if (parsed.tenantId) patch.tenantId = parsed.tenantId
      patchCurrentContext(patch)
      if (parsed.name) {
        ;(req as unknown as { user?: unknown }).user = { name: parsed.name }
      }
    }
    next()
  }
}

/** 被 `captureBefore` 快照的业务状态：一个极简的「商品」内存表。 */
@Injectable()
class GoodsService {
  private readonly rows = new Map<string, { name: string }>([['g1', { name: 'old-name' }]])

  async snapshotForAudit(id: string): Promise<unknown> {
    return this.rows.get(id) ?? null
  }

  update(id: string, name: string): void {
    this.rows.set(id, { name })
  }
}

class DomainError extends Error {}

@Controller('t')
class TestController implements AuditSnapshot {
  constructor(@Inject(GoodsService) private readonly goods: GoodsService) {}

  async snapshotForAudit(targetId: string): Promise<unknown> {
    return this.goods.snapshotForAudit(targetId)
  }

  @Get('plain')
  plain(): { ok: true } {
    return { ok: true }
  }

  @Post('login')
  @Audit({ action: 'platform-admin.login' })
  login(@Body() _body: { username: string; password: string }): { ok: true } {
    return { ok: true }
  }

  @Post('tenant/:tenantId/suspend')
  @Audit({
    action: 'tenant.suspend',
    targetType: 'Tenant',
    targetId: (req) => stringParam(req.params.tenantId),
  })
  suspendTenant(@Param('tenantId') _tenantId: string): { ok: true } {
    return { ok: true }
  }

  @Post('goods/:id')
  @Audit({
    action: 'goods.update',
    targetType: 'Goods',
    targetId: (req) => stringParam(req.params.id),
    captureBefore: true,
  })
  updateGoods(@Param('id') id: string, @Body() body: { name: string }): { ok: true } {
    this.goods.update(id, body.name)
    return { ok: true }
  }

  @Post('fail')
  @Audit({ action: 'goods.delete', targetType: 'Goods', targetId: () => 'g1' })
  fail(): never {
    throw new DomainError('boom')
  }
}

interface Harness {
  app: INestApplication
  controls: FakePrismaControls
  logger: RecordingLogger
  counters: HealthCounters
}

async function createApp(): Promise<Harness> {
  const fake = createFakePrisma()
  const prisma = new PrismaService(fake.client, {
    registered: new Set(['AuditLog']),
    softDeleteModels: new Set(),
    client: fake.client,
    connectOnInit: false,
  })
  const logger = new RecordingLogger()
  const counters = new HealthCounters()

  @Module({
    controllers: [TestController],
    providers: [
      GoodsService,
      { provide: PrismaService, useValue: prisma },
      { provide: AppLogger, useValue: logger },
      { provide: HealthCounters, useValue: counters },
      AuditService,
      { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    ],
  })
  class TestAppModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
      consumer.apply(ContextMiddleware, TestIdentityMiddleware).forRoutes('*')
    }
  }

  const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await app.init()
  return { app, controls: fake.controls, logger, counters }
}

// HTTP 头只能装 ASCII 内容，中文名字这类字段要先转 base64 才能塞进 header——
// 中间件那边对应做 base64 解码。
function identityHeader(value: {
  kind: 'platform' | 'staff' | 'member'
  id: string
  tenantId?: string
  name?: string
}): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}

describe('AuditInterceptor', () => {
  let harness: Harness

  afterEach(async () => {
    await harness?.app.close()
  })

  // 用例①
  it('platform 身份调用 @Audit 路由 → PlatformAuditLog 一条，含 actor/ip/traceId/targetTenantId', async () => {
    harness = await createApp()
    const res = await request(harness.app.getHttpServer())
      .post('/t/tenant/tenant-9/suspend')
      .set('x-test-identity', identityHeader({ kind: 'platform', id: 'admin1', name: '超管张三' }))
      .expect(201)

    expect(res.body).toEqual({ ok: true })

    const calls = harness.controls.callsOf('PlatformAuditLog', 'create')
    expect(calls).toHaveLength(1)
    const data = (calls[0]?.args as { data: Record<string, unknown> }).data
    expect(data.actorType).toBe('PLATFORM_ADMIN')
    expect(data.actorId).toBe('admin1')
    expect(data.actorName).toBe('超管张三')
    expect(data.action).toBe('tenant.suspend')
    expect(data.targetTenantId).toBe('tenant-9')
    expect(typeof data.ip).toBe('string')
    expect((data.ip as string).length).toBeGreaterThan(0)
    expect(isUlid(String(data.traceId))).toBe(true)
    expect(data.result).toBe('SUCCESS')
    expect(harness.controls.callsOf('AuditLog', 'create')).toHaveLength(0)
  })

  // 用例②
  it('staff 身份调用 → AuditLog 一条，tenantId 来自上下文', async () => {
    harness = await createApp()
    await request(harness.app.getHttpServer())
      .post('/t/goods/g1')
      .set(
        'x-test-identity',
        identityHeader({ kind: 'staff', id: 'staff1', tenantId: 't1', name: '员工李四' }),
      )
      .send({ name: 'new-name' })
      .expect(201)

    const calls = harness.controls.callsOf('AuditLog', 'create')
    expect(calls).toHaveLength(1)
    const data = (calls[0]?.args as { data: Record<string, unknown> }).data
    expect(data.tenantId).toBe('t1')
    expect(data.actorType).toBe('STAFF')
    expect(data.actorId).toBe('staff1')
    expect(data.actorName).toBe('员工李四')
    expect(harness.controls.callsOf('PlatformAuditLog', 'create')).toHaveLength(0)
  })

  // 用例③
  it('请求体里的 password 字段被脱敏', async () => {
    harness = await createApp()
    await request(harness.app.getHttpServer())
      .post('/t/login')
      .set('x-test-identity', identityHeader({ kind: 'platform', id: 'admin1', name: '超管' }))
      .send({ username: 'admin', password: 'hunter2' })
      .expect(201)

    const calls = harness.controls.callsOf('PlatformAuditLog', 'create')
    expect(calls).toHaveLength(1)
    const data = (calls[0]?.args as { data: Record<string, unknown> }).data
    const after = data.after as { username: string; password: string }
    expect(after.username).toBe('admin')
    expect(after.password).toBe('[REDACTED]')
  })

  // 用例④
  it('captureBefore 取到 before/after（处理器执行前后各拍一张快照）', async () => {
    harness = await createApp()
    await request(harness.app.getHttpServer())
      .post('/t/goods/g1')
      .set('x-test-identity', identityHeader({ kind: 'staff', id: 'staff1', tenantId: 't1' }))
      .send({ name: 'renamed' })
      .expect(201)

    const calls = harness.controls.callsOf('AuditLog', 'create')
    expect(calls).toHaveLength(1)
    const data = (calls[0]?.args as { data: Record<string, unknown> }).data
    expect(data.before).toEqual({ name: 'old-name' })
    expect(data.after).toEqual({ name: 'renamed' })
  })

  // 用例⑤
  it('handler 抛错 → 记 FAIL 且异常照抛', async () => {
    harness = await createApp()
    await request(harness.app.getHttpServer())
      .post('/t/fail')
      .set('x-test-identity', identityHeader({ kind: 'staff', id: 'staff1', tenantId: 't1' }))
      .expect(500)

    const calls = harness.controls.callsOf('AuditLog', 'create')
    expect(calls).toHaveLength(1)
    const data = (calls[0]?.args as { data: Record<string, unknown> }).data
    expect(data.result).toBe('FAIL')
    expect(data.action).toBe('goods.delete')
  })

  // 用例⑥
  it('fake prisma 写入抛错 → 主响应仍成功、logger.error 被调、auditFailures +1', async () => {
    harness = await createApp()
    harness.controls.on('AuditLog', 'create', () => {
      throw new Error('数据库连接串挂了')
    })

    const res = await request(harness.app.getHttpServer())
      .post('/t/goods/g1')
      .set('x-test-identity', identityHeader({ kind: 'staff', id: 'staff1', tenantId: 't1' }))
      .send({ name: 'x' })

    expect(res.status).toBe(201)
    expect(res.body).toEqual({ ok: true })
    expect(harness.logger.errors).toHaveLength(1)
    expect(String(harness.logger.errors[0]?.message)).toContain('审计写入失败')
    expect(harness.counters.get('auditFailures')).toBe(1)
  })

  // 用例⑦
  it('无 @Audit 的路由不写任何审计表', async () => {
    harness = await createApp()
    await request(harness.app.getHttpServer()).get('/t/plain').expect(200)

    expect(harness.controls.callsOf('AuditLog', 'create')).toHaveLength(0)
    expect(harness.controls.callsOf('PlatformAuditLog', 'create')).toHaveLength(0)
  })
})
