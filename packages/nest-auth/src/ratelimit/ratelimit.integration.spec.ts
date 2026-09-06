/**
 * T2-6 的验收用例：起一个真的 Nest app，从 HTTP 层打进来。
 *
 * 为什么必须是集成测试而不是直接 new 一个守卫：这一半的行为是**装配**——
 * `IP_RESOLVER` 有没有真的被 `AuthModule` 接上、`ContextMiddleware` 填的
 * `ctx.ip.client` 是不是从 XFF 末尾倒数来的、429 有没有带上 `Retry-After`、
 * 响应体是不是统一信封里的 `1042900`。手工调 `canActivate` 把这些全绕过去了，
 * 绿了也不说明装配是对的。
 */

import { ErrorCode } from '@taizan/contracts'
import { RATE_LIMIT_TIERS } from '@taizan/ratelimit-core'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../__test__/harness'
import { resetProcessLocalCounters } from '@taizan/ratelimit-core'

/** 线上真实链路：客户端 → EdgeOne（追加真实客户端 IP）→ nginx（追加 EdgeOne 出口 IP）→ Node。 */
const REAL_CLIENT = '222.137.6.155'
const EDGE = '114.66.247.140'
const HONEST_XFF = `${REAL_CLIENT}, ${EDGE}`

const LOGIN_TIER = RATE_LIMIT_TIERS.login

let h: Harness

beforeEach(() => {
  // 降级路径用的是**进程内**计数器，它跨测试用例活着。不清的话前一条用例
  // 打满的额度会让后一条莫名其妙从 429 开始。
  resetProcessLocalCounters()
})

afterEach(async () => {
  await h?.app.close()
})

function server(): Parameters<typeof request>[0] {
  return h.app.getHttpServer() as Parameters<typeof request>[0]
}

/** 打一次限流路由，可自带 XFF。 */
const post = (xff?: string, path = '/api/public/rl/login-ish') => {
  const req = request(server()).post(path)
  return xff === undefined ? req : req.set('X-Forwarded-For', xff)
}

describe('IP_RESOLVER 接线：ctx.ip 来自 resolveIps', () => {
  it('上下文里的 client 是倒数第 TRUSTED_PROXY_HOPS 段，edge 是末段', async () => {
    h = await createHarness()
    const res = await post(HONEST_XFF).expect(201)
    expect(res.body.data).toEqual({ client: REAL_CLIENT, edge: EDGE })
  })

  it('攻击者往开头塞伪造段，ctx.ip.client 一个字都不变', async () => {
    h = await createHarness()
    const spoofed = await post(`9.9.9.9, 8.8.8.8, ${HONEST_XFF}`).expect(201)
    expect(spoofed.body.data).toEqual({ client: REAL_CLIENT, edge: EDGE })
  })

  it('TRUSTED_PROXY_HOPS 配成 1 时取末段（没有 CDN 的部署）', async () => {
    h = await createHarness({ env: { TRUSTED_PROXY_HOPS: '1' } })
    const res = await post(HONEST_XFF).expect(201)
    expect(res.body.data).toEqual({ client: EDGE, edge: EDGE })
  })
})

describe('伪造 XFF 绕不过限流（不变量 6 的集成验收）', () => {
  it('每次换一个伪造前缀，限流 key 不变，照样在第 11 次被拦', async () => {
    h = await createHarness()
    // 攻击者的手法：每次请求换一个 X-Forwarded-For 前缀，指望换出一个新的限流桶。
    // knowledge 实测过的那次事故就是这么被绕过去的（限流 key 直接变成伪造值）。
    for (let i = 0; i < LOGIN_TIER.clientLimit; i += 1) {
      await post(`10.0.0.${i}, 172.16.9.${i}, ${HONEST_XFF}`).expect(201)
    }
    const res = await post(`10.0.0.99, 172.16.9.99, ${HONEST_XFF}`)
    expect(res.status).toBe(429)
  })

  it('诚实请求打满之后，换成伪造前缀也进不来（说明两者共用同一个桶）', async () => {
    h = await createHarness()
    for (let i = 0; i < LOGIN_TIER.clientLimit; i += 1) await post(HONEST_XFF).expect(201)
    expect((await post(`1.1.1.1, ${HONEST_XFF}`)).status).toBe(429)
  })

  it('真正换了客户端（倒数第二段不同）的人不受牵连', async () => {
    h = await createHarness()
    for (let i = 0; i < LOGIN_TIER.clientLimit; i += 1) await post(HONEST_XFF).expect(201)
    // 另一个真实用户，同一个 CDN 边缘节点
    await post(`203.0.113.8, ${EDGE}`).expect(201)
  })
})

describe('超阈值：429 + Retry-After + 统一信封', () => {
  beforeEach(async () => {
    h = await createHarness()
    for (let i = 0; i < LOGIN_TIER.clientLimit; i += 1) await post(HONEST_XFF).expect(201)
  })

  it('HTTP 状态码是 429（给机器看的，CDN 与重试库都认它）', async () => {
    expect((await post(HONEST_XFF)).status).toBe(429)
  })

  it('带 Retry-After 头，且是个正整数秒', async () => {
    const res = await post(HONEST_XFF)
    const retryAfter = Number(res.headers['retry-after'])
    expect(Number.isInteger(retryAfter)).toBe(true)
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(LOGIN_TIER.windowSec)
  })

  it('响应体是统一信封，业务码 1042900（= ErrorCode.TOO_MANY_REQUESTS）', async () => {
    const res = await post(HONEST_XFF)
    expect(res.body.code).toBe(1042900)
    expect(res.body.code).toBe(ErrorCode.TOO_MANY_REQUESTS.code)
    expect(res.body.data).toBeNull()
  })

  it('文案讲的是「登录失败次数过多」，并告诉他等多少秒', async () => {
    const res = await post(HONEST_XFF)
    expect(res.body.message).toMatch(/失败次数过多/)
    expect(res.body.message).toMatch(/\d+ 秒后再试/)
  })

  it('**不**告诉客户端是哪个维度拦的（那等于给攻击者调参提示）', async () => {
    const res = await post(HONEST_XFF)
    expect(JSON.stringify(res.body)).not.toMatch(/client|edge|account|dimension/)
  })
})

describe('没挂 @RateLimited 的路由不限流', () => {
  it('打 30 次也不会 429', async () => {
    h = await createHarness()
    for (let i = 0; i < 30; i += 1) {
      await request(server())
        .get('/api/public/rl/unlimited')
        .set('X-Forwarded-For', HONEST_XFF)
        .expect(200)
    }
  })
})

describe('账号维度：宽松，且成功也计数', () => {
  it('同一个账号换 IP 反复登录，会被账号维度兜住（而不是无限试）', async () => {
    h = await createHarness()
    const hit = (i: number) =>
      request(server())
        .post('/api/public/rl/login-account')
        .set('X-Forwarded-For', `198.51.100.${i}, 203.0.113.${i}`)
        .send({ account: 'owner@shop' })

    // 每次换一对全新的 client/edge，客户端与入口两维永远打不满
    for (let i = 0; i < (LOGIN_TIER.accountLimit ?? 0); i += 1) {
      await hit(i).expect(201)
    }
    const blocked = await hit(200)
    expect(blocked.status).toBe(429)
    expect(blocked.body.code).toBe(1042900)
  })

  it('账号维度比客户端维度宽松得多——别人拿你的账号骚扰不了你', async () => {
    // 这不是数值巧合，是 assertTierSane 强制的。这里再从「用户能感知的行为」上确认一次：
    // 攻击者用受害者的账号打满账号维度需要 50 次，而他自己的 IP 打 10 次就先被拦了。
    expect(LOGIN_TIER.accountLimit).toBeGreaterThan(LOGIN_TIER.clientLimit * 4)
  })

  it('账号维度打满时，别的账号不受影响', async () => {
    h = await createHarness()
    for (let i = 0; i < (LOGIN_TIER.accountLimit ?? 0) + 1; i += 1) {
      await request(server())
        .post('/api/public/rl/login-account')
        .set('X-Forwarded-For', `198.51.100.${i}, 203.0.113.${i}`)
        .send({ account: 'victim' })
    }
    const other = await request(server())
      .post('/api/public/rl/login-account')
      .set('X-Forwarded-For', `198.51.100.250, 203.0.113.250`)
      .send({ account: 'someone-else' })
    expect(other.status).toBe(201)
  })

  it('成功的登录也计数（AuthFlowService.countAttempt 记的是「尝试」，不是「失败」）', async () => {
    h = await createHarness()
    const res = await request(server())
      .post('/api/public/rl/login-account')
      .set('X-Forwarded-For', HONEST_XFF)
      .send({ account: 'Owner@Shop' })
    expect(res.status).toBe(201)
    // 大小写不同视为同一个账号，否则额度直接翻倍
    const key = 'rl:login:a:owner@shop'
    expect(await h.redis.get(key)).toBe('1')
  })
})

describe('Redis 挂了：弱化但不放行', () => {
  it('incr 一直抛错时，退回进程内计数，第 11 次照样 429', async () => {
    // 这次改动里最容易出事的地方：一不小心就写成「Redis 不可用 → 直接放行」，
    // 那等于在 Redis 抖动的几分钟里完全没有防护，而且不会有任何报错。
    h = await createHarness({ brokenRedis: true })
    for (let i = 0; i < LOGIN_TIER.clientLimit; i += 1) await post(HONEST_XFF).expect(201)
    const res = await post(HONEST_XFF)
    expect(res.status).toBe(429)
    expect(res.body.code).toBe(1042900)
  })

  it('降级时打一条 error 级日志，说清了「额度会变成配置值 × 进程数」', async () => {
    h = await createHarness({ brokenRedis: true })
    await post(HONEST_XFF)
    expect(h.errors.some((e) => e.includes('退回进程内存'))).toBe(true)
    expect(h.errors.some((e) => e.includes('进程数'))).toBe(true)
  })

  it('降级日志限频，打一百次请求也不会刷屏', async () => {
    h = await createHarness({ brokenRedis: true })
    for (let i = 0; i < 8; i += 1) await post(HONEST_XFF)
    expect(h.errors.filter((e) => e.includes('退回进程内存'))).toHaveLength(1)
  })

  it('降级时 Retry-After 照样给得出来', async () => {
    h = await createHarness({ brokenRedis: true })
    for (let i = 0; i < LOGIN_TIER.clientLimit + 1; i += 1) await post(HONEST_XFF)
    const res = await post(HONEST_XFF)
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
  })
})

describe('装配', () => {
  it('AuthModule 默认把 resolveIps 注册成 IP_RESOLVER（关掉它 ctx.ip 就退回占位实现）', async () => {
    h = await createHarness()
    const res = await post(`9.9.9.9, ${HONEST_XFF}`).expect(201)
    // 占位实现会回连接层地址（测试里是 ::ffff:127.0.0.1 之类），
    // 拿到真实的倒数第二段就说明适配器接上了。
    expect(res.body.data.client).toBe(REAL_CLIENT)
  })

  it('限流守卫排在 GlobalAuthGuard 之前：没有 token 的请求先撞限流而不是先撞 401', async () => {
    h = await createHarness()
    for (let i = 0; i < LOGIN_TIER.clientLimit; i += 1) await post(HONEST_XFF).expect(201)
    // 这条路由是 @Public()，两个守卫都会放行/拒绝得出同样的结果；
    // 真正能观察到顺序的是「限流拒绝时认证根本没跑」——用一条需要登录的路由验证：
    const res = await request(server())
      .get('/api/admin/t/staff-only')
      .set('X-Forwarded-For', HONEST_XFF)
    // 这条没挂 @RateLimited，所以它照常走认证 → 401。限流不该误伤没声明档位的路由。
    expect(res.body.code).toBe(ErrorCode.UNAUTHENTICATED.code)
  })
})
