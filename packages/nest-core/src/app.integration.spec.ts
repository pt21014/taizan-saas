import 'reflect-metadata'
import { Controller, Get, Inject, Module, NotFoundException } from '@nestjs/common'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { ErrorCode, isUlid, ulid } from '@taizan/contracts'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { CoreModule, type CoreModuleOptions } from './core.module'
import type { HealthIndicator } from './health/indicators'
import { BizException } from './http/biz.exception'
import { RawResponse } from './http/raw-response.decorator'
import { AppLogger } from './logging/logger.service'
import { applyCors } from './security/cors'

const KEY = 'a'.repeat(64)

function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/taizan',
    REDIS_URL: 'redis://127.0.0.1:6379/0',
    JWT_SECRET_PLATFORM: 'p'.repeat(40),
    JWT_SECRET_STAFF: 's'.repeat(40),
    JWT_SECRET_MEMBER: 'm'.repeat(40),
    CRYPTO_KEYS: JSON.stringify({ k1: KEY }),
    CRYPTO_KEY_CURRENT: 'k1',
    LOG_LEVEL: 'debug',
    ...overrides,
  }
}

/** 把 pino 输出收进内存，供断言日志内容。 */
class MemorySink {
  readonly lines: Record<string, unknown>[] = []

  write(chunk: string): void {
    for (const line of chunk.split('\n')) {
      if (line.trim()) {
        this.lines.push(JSON.parse(line) as Record<string, unknown>)
      }
    }
  }

  find(predicate: (line: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
    return this.lines.find(predicate)
  }
}

@Controller('t')
class TestController {
  constructor(@Inject(AppLogger) private readonly logger: AppLogger) {}

  @Get('plain')
  plain(): { hello: string } {
    return { hello: 'world' }
  }

  @Get('void')
  void(): undefined {
    return undefined
  }

  @Get('logged')
  logged(): { ok: boolean } {
    this.logger.log('handler-hit', 'TestController')
    return { ok: true }
  }

  @Get('raw')
  @RawResponse()
  raw(): { code: string; message: string } {
    // 微信支付回调期望的报文：顶层 code 是字符串 SUCCESS
    return { code: 'SUCCESS', message: 'OK' }
  }

  @Get('biz')
  biz(): never {
    throw new BizException(ErrorCode.QUOTA_EXCEEDED, undefined, { used: 100, limit: 100 })
  }

  @Get('biz-custom')
  bizCustom(): never {
    throw new BizException(2040001, '商品已售罄')
  }

  @Get('not-found')
  notFound(): never {
    throw new NotFoundException('没有这个东西')
  }

  @Get('boom')
  boom(): never {
    throw new Error('数据库连接串 postgresql://user:hunter2@10.0.0.1/db 挂了')
  }

  @Get('sensitive-log')
  sensitiveLog(): null {
    this.logger.raw.info(
      { password: 'hunter2', user: { phone: '13812345678', name: '张三' } },
      '写一条含敏感字段的日志',
    )
    return null
  }
}

interface Harness {
  app: INestApplication
  sink: MemorySink
}

async function createApp(
  options: Partial<CoreModuleOptions> & { env?: Record<string, string>; cors?: string[] } = {},
): Promise<Harness> {
  const sink = new MemorySink()
  const { env, cors, ...coreOptions } = options

  @Module({
    imports: [
      CoreModule.forRoot({
        envSource: baseEnv(env),
        logDestination: sink,
        version: '9.9.9',
        ...coreOptions,
      }),
    ],
    controllers: [TestController],
  })
  class TestAppModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  if (cors) {
    applyCors(app, cors, { isProduction: true })
  }
  await app.init()
  return { app, sink }
}

describe('nest-core 集成', () => {
  let harness: Harness

  afterEach(async () => {
    await harness?.app.close()
  })

  // 用例③
  it('响应头 X-Trace-Id 存在且是 26 位 ULID，日志行带同一个 traceId', async () => {
    harness = await createApp()
    const res = await request(harness.app.getHttpServer()).get('/t/logged').expect(200)

    const traceId = res.headers['x-trace-id'] as string
    expect(traceId).toBeDefined()
    expect(traceId).toHaveLength(26)
    expect(isUlid(traceId)).toBe(true)

    const line = harness.sink.find((l) => l.msg === 'handler-hit')
    expect(line, '没有捕获到业务日志行').toBeDefined()
    expect(line?.traceId).toBe(traceId)
    expect(line?.context).toBe('TestController')
  })

  it('两次请求的 traceId 不同', async () => {
    harness = await createApp()
    const server = harness.app.getHttpServer()
    const a = await request(server).get('/t/plain')
    const b = await request(server).get('/t/plain')
    expect(a.headers['x-trace-id']).not.toBe(b.headers['x-trace-id'])
  })

  it('合法入站 X-Trace-Id 被接续（跨服务链路串起来）', async () => {
    harness = await createApp()
    const inbound = ulid()
    const res = await request(harness.app.getHttpServer())
      .get('/t/plain')
      .set('X-Trace-Id', inbound)
    expect(res.headers['x-trace-id']).toBe(inbound)
  })

  // 用例④
  it('伪造的非法 X-Trace-Id 被丢弃并换成新生成的 ULID', async () => {
    harness = await createApp()
    const forged = 'not-a-ulid-injected-line'
    const res = await request(harness.app.getHttpServer())
      .get('/t/logged')
      .set('X-Trace-Id', forged)

    const traceId = res.headers['x-trace-id'] as string
    expect(traceId).not.toBe(forged)
    expect(isUlid(traceId)).toBe(true)
    // 伪造内容不能出现在任何日志行里
    expect(JSON.stringify(harness.sink.lines)).not.toContain('injected-line')
  })

  // 用例⑤
  it('普通路由包信封，@RawResponse() 路由原样输出', async () => {
    harness = await createApp()
    const server = harness.app.getHttpServer()

    const wrapped = await request(server).get('/t/plain').expect(200)
    expect(wrapped.body).toEqual({ code: 0, message: 'ok', data: { hello: 'world' } })

    const raw = await request(server).get('/t/raw').expect(200)
    // 微信读的是顶层 code，被包一层就会判定失败并持续重投
    expect(raw.body).toEqual({ code: 'SUCCESS', message: 'OK' })
  })

  it('控制器返回 undefined 时 data 落成 null 而不是消失', async () => {
    harness = await createApp()
    const res = await request(harness.app.getHttpServer()).get('/t/void').expect(200)
    expect(res.body).toEqual({ code: 0, message: 'ok', data: null })
    expect(Object.keys(res.body as object)).toContain('data')
  })

  // 用例⑥
  it('BizException → HTTP 200 + 业务码，附加 data 原样回传', async () => {
    harness = await createApp()
    const res = await request(harness.app.getHttpServer()).get('/t/biz').expect(200)
    expect(res.body.code).toBe(ErrorCode.QUOTA_EXCEEDED.code)
    expect(res.body.code).toBe(1540301)
    expect(res.body.message).toBe(ErrorCode.QUOTA_EXCEEDED.message)
    expect(res.body.data).toEqual({ used: 100, limit: 100 })
  })

  it('业务自定义码（20–89 段）也走 200', async () => {
    harness = await createApp()
    const res = await request(harness.app.getHttpServer()).get('/t/biz-custom').expect(200)
    expect(res.body).toEqual({ code: 2040001, message: '商品已售罄', data: null })
  })

  // 用例⑦
  it('NotFoundException → HTTP 404 + 信封 code 1040400', async () => {
    harness = await createApp()
    const res = await request(harness.app.getHttpServer()).get('/t/not-found').expect(404)
    expect(res.body).toEqual({ code: 1040400, message: '没有这个东西', data: null })
    expect(res.headers['x-trace-id']).toBeDefined()
  })

  it('不存在的路由 → 404 + 信封（Nest 自己抛的 NotFoundException 也被包）', async () => {
    harness = await createApp()
    const res = await request(harness.app.getHttpServer()).get('/nope').expect(404)
    expect(res.body.code).toBe(1040400)
    expect(res.body.data).toBeNull()
  })

  // 用例⑧
  it('未知异常 → 500 + 9050000；非生产回传原始 message 便于本地排查', async () => {
    harness = await createApp()
    const res = await request(harness.app.getHttpServer()).get('/t/boom').expect(500)
    expect(res.body.code).toBe(9050000)
    expect(res.body.code).toBe(ErrorCode.INTERNAL_ERROR.code)
    expect(res.body.message).toContain('数据库连接串')
  })

  it('production 下 500 的 message 不含原始错误文本与堆栈，但日志记全', async () => {
    harness = await createApp({ env: { NODE_ENV: 'production' } })
    const res = await request(harness.app.getHttpServer()).get('/t/boom').expect(500)

    expect(res.body.code).toBe(9050000)
    expect(res.body.message).toBe('系统内部错误')
    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain('postgresql://')
    expect(serialized).not.toContain('hunter2')
    expect(serialized).not.toContain('数据库连接串')
    expect(serialized).not.toMatch(/at .*\.ts:/)

    // 日志里必须有完整信息，否则线上就查不了
    const errorLine = harness.sink.find((l) => l.level === 'error')
    expect(String(errorLine?.msg)).toContain('数据库连接串')
    expect(typeof errorLine?.stack).toBe('string')
  })

  // 用例⑨
  it('任一 indicator 返回 down 时 /health 返回 503', async () => {
    const up: HealthIndicator = { name: 'db', check: async () => 'up' }
    const down: HealthIndicator = { name: 'redis', check: async () => 'down' }
    harness = await createApp({ healthIndicators: [up, down] })

    const res = await request(harness.app.getHttpServer()).get('/health').expect(503)
    expect(res.body.status).toBe('down')
    expect(res.body.checks).toEqual({ db: 'up', redis: 'down' })
    expect(res.body.version).toBe('9.9.9')
    expect(typeof res.body.uptime).toBe('number')
    expect(res.body.counters.auditFailures).toBe(0)
    // @RawResponse()：探活方读的是顶层字段，不能被包成 data.status
    expect(res.body.code).toBeUndefined()
  })

  it('全部 indicator up 时 /health 返回 200', async () => {
    harness = await createApp({
      healthIndicators: [
        { name: 'db', check: async () => 'up' },
        { name: 'redis', check: async () => 'up' },
      ],
    })
    const res = await request(harness.app.getHttpServer()).get('/health').expect(200)
    expect(res.body.status).toBe('up')
  })

  it('indicator 自己抛错算 down，而不是让 /health 整个 500', async () => {
    harness = await createApp({
      healthIndicators: [
        {
          name: 'queue',
          check: () => Promise.reject(new Error('connection refused')),
        },
      ],
    })
    const res = await request(harness.app.getHttpServer()).get('/health').expect(503)
    expect(res.body.checks).toEqual({ queue: 'down' })
  })

  it('没有任何 indicator 时 /health 返回 200（探针由下游包注册）', async () => {
    harness = await createApp()
    const res = await request(harness.app.getHttpServer()).get('/health').expect(200)
    expect(res.body).toMatchObject({ status: 'up', checks: {} })
  })

  // 用例⑩
  it('CORS：白名单内的 Origin 拿到 Access-Control-Allow-Origin，白名单外拿不到', async () => {
    harness = await createApp({ cors: ['https://admin.example.com', 'https://*.shop.example.com'] })
    const server = harness.app.getHttpServer()

    const allowed = await request(server)
      .get('/t/plain')
      .set('Origin', 'https://admin.example.com')
      .expect(200)
    expect(allowed.headers['access-control-allow-origin']).toBe('https://admin.example.com')

    const wildcard = await request(server)
      .get('/t/plain')
      .set('Origin', 'https://a.shop.example.com')
      .expect(200)
    expect(wildcard.headers['access-control-allow-origin']).toBe('https://a.shop.example.com')

    const denied = await request(server)
      .get('/t/plain')
      .set('Origin', 'https://evil.com')
      .expect(200)
    expect(denied.headers['access-control-allow-origin']).toBeUndefined()
  })

  // 用例⑫
  it('日志脱敏：password 被抹掉，手机号中间打码', async () => {
    harness = await createApp()
    await request(harness.app.getHttpServer()).get('/t/sensitive-log').expect(200)

    const line = harness.sink.find((l) => l.msg === '写一条含敏感字段的日志')
    expect(line).toBeDefined()
    expect(line?.password).toBe('[REDACTED]')
    expect(line?.user).toEqual({ phone: '138****5678', name: '张三' })

    const serialized = JSON.stringify(harness.sink.lines)
    expect(serialized).not.toContain('hunter2')
    expect(serialized).not.toContain('13812345678')
    // traceId 仍然在，脱敏不能把排查线索也一起抹了
    expect(line?.traceId).toBeDefined()
  })
})

describe('CoreModule 启动期硬检查', () => {
  it('env 缺字段时 forRoot 直接抛，模块根本装配不起来', () => {
    expect(() => CoreModule.forRoot({ envSource: { NODE_ENV: 'test' } })).toThrow(
      /环境变量校验失败/,
    )
  })

  it('production + SMS_RETURN_DEV_CODE=1 时 forRoot 拒启', () => {
    expect(() =>
      CoreModule.forRoot({
        envSource: baseEnv({ NODE_ENV: 'production', SMS_RETURN_DEV_CODE: '1' }),
      }),
    ).toThrow(/禁止开启以下开关/)
  })
})
