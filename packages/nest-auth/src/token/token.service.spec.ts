/**
 * `TokenService` 单测：三套密钥、kind 校验、refresh 一次性轮换（用例⑪）。
 *
 * 这一层不起 Nest——被测的是纯粹的签发/校验逻辑，起 app 只会让失败信息变难读。
 */

import { ConfigService } from '@taizan/nest-core'
import { beforeEach, describe, expect, it } from 'vitest'
import { InMemoryAuthRedis } from '../redis'
import { DEFAULT_CONCURRENCY, SessionService } from '../session/session.service'
import { FakeClock } from '../testing/fake-clock'
import { TOKEN_PAYLOAD_VERSION } from './jwt-payload'
import { refreshKey, TokenService } from './token.service'
import { DEFAULT_TTL, resolveTtl } from './ttl'

const ENV = {
  NODE_ENV: 'test',
  JWT_SECRET_PLATFORM: 'p'.repeat(40),
  JWT_SECRET_STAFF: 's'.repeat(40),
  JWT_SECRET_MEMBER: 'm'.repeat(40),
} as unknown as Parameters<typeof ConfigService.prototype.get> extends never ? never : never

let clock: FakeClock
let redis: InMemoryAuthRedis
let sessions: SessionService
let tokens: TokenService

function build(ttlOverrides?: Parameters<typeof resolveTtl>[0]): void {
  clock = new FakeClock()
  redis = new InMemoryAuthRedis(() => clock.now())
  sessions = new SessionService(redis, DEFAULT_CONCURRENCY, clock)
  const config = new ConfigService({
    NODE_ENV: 'test',
    JWT_SECRET_PLATFORM: 'p'.repeat(40),
    JWT_SECRET_STAFF: 's'.repeat(40),
    JWT_SECRET_MEMBER: 'm'.repeat(40),
    // ConfigService 只按 key 取值，其余字段本测试用不到。
  } as unknown as ConstructorParameters<typeof ConfigService>[0])
  tokens = new TokenService(config, resolveTtl(ttlOverrides), redis, sessions, clock)
}

beforeEach(() => {
  build()
  void ENV
})

describe('三套密钥互不通用', () => {
  it('member 签的 token 用 staff 密钥验 → 1140100（签名对不上）', async () => {
    const token = await tokens.sign('member', { sub: 'M1', tenantId: 'T1', ver: 1 })
    await expect(tokens.verify('staff', token)).rejects.toMatchObject({ code: 1140100 })
  })

  it('同一把密钥、payload.kind 不符也拒（第二道防线，防三个 env 被填成同一个值）', async () => {
    // 手工构造一个「用 staff 密钥签、但 payload 里写着 member」的串。
    const { SignJWT } = await import('jose')
    const forged = await new SignJWT({ kind: 'member', sub: 'X', jti: 'J', ver: 1 })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(clock.now() / 1000))
      .setExpirationTime(Math.floor(clock.now() / 1000) + 600)
      .sign(new TextEncoder().encode('s'.repeat(40)))

    await expect(tokens.verify('staff', forged)).rejects.toMatchObject({ code: 1140102 })
  })

  it('alg 被改成 none 的串不认（算法白名单只有 HS256）', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
    const body = Buffer.from(
      JSON.stringify({ kind: 'staff', sub: 'X', jti: 'J', ver: 1, exp: 9_999_999_999 }),
    ).toString('base64url')
    await expect(tokens.verify('staff', `${header}.${body}.`)).rejects.toMatchObject({
      code: 1140100,
    })
  })
})

describe('签发与校验', () => {
  it('往返一致，且 platform token 里根本没有 tenantId 这个键', async () => {
    const token = await tokens.sign('platform', { sub: 'A1', ver: TOKEN_PAYLOAD_VERSION })
    const payload = await tokens.verify('platform', token)
    expect(payload.kind).toBe('platform')
    expect(payload.sub).toBe('A1')
    expect(payload).not.toHaveProperty('tenantId')
    expect(payload.jti).toHaveLength(26)
  })

  it('默认 TTL 按 kind 各不相同（platform 4h / staff 8h / member 7d）', () => {
    expect(DEFAULT_TTL.access.platform).toBe(4 * 60 * 60)
    expect(DEFAULT_TTL.access.staff).toBe(8 * 60 * 60)
    expect(DEFAULT_TTL.access.member).toBe(7 * 24 * 60 * 60)
    expect(DEFAULT_TTL.refresh).toBe(30 * 24 * 60 * 60)
  })

  it('TTL 可逐项覆盖，未覆盖的仍取默认值', () => {
    const merged = resolveTtl({ access: { staff: 60 } })
    expect(merged.access.staff).toBe(60)
    expect(merged.access.platform).toBe(DEFAULT_TTL.access.platform)
    expect(merged.refresh).toBe(DEFAULT_TTL.refresh)
  })

  it('过期报 1140101，与「签名不对」的 1140100 分开', async () => {
    build({ access: { staff: 10 } })
    const token = await tokens.sign('staff', { sub: 'S1', tenantId: 'T1', ver: 1 })
    clock.advanceSeconds(11)
    await expect(tokens.verify('staff', token)).rejects.toMatchObject({ code: 1140101 })
  })
})

describe('refresh 轮换（用例⑪）', () => {
  it('一次性：同一个 refresh 换第二次直接失败', async () => {
    const refresh = await tokens.issueRefresh('staff', 'S1', { tenantId: 'T1', accountId: 'A1' })

    const first = await tokens.rotateRefresh(refresh)
    expect(first.access).toBeTruthy()
    expect(first.refresh).not.toBe(refresh)

    await expect(tokens.rotateRefresh(refresh)).rejects.toMatchObject({ code: 1140100 })
  })

  it('并发换两次，只有一个成功（GETDEL 的原子性）', async () => {
    const refresh = await tokens.issueRefresh('member', 'M1', { tenantId: 'T1' })
    const results = await Promise.allSettled([
      tokens.rotateRefresh(refresh),
      tokens.rotateRefresh(refresh),
    ])
    const ok = results.filter((r) => r.status === 'fulfilled')
    expect(ok).toHaveLength(1)
  })

  it('轮换出来的新 refresh 可以接着用（链式刷新）', async () => {
    const r0 = await tokens.issueRefresh('staff', 'S1', { tenantId: 'T1', accountId: 'A1' })
    const r1 = await tokens.rotateRefresh(r0)
    const r2 = await tokens.rotateRefresh(r1.refresh)
    expect(r2.access).toBeTruthy()
    // 上一环已经被核销。
    await expect(tokens.rotateRefresh(r1.refresh)).rejects.toMatchObject({ code: 1140100 })
  })

  it('轮换带过 tenantId / accountId，新 access 上仍然有', async () => {
    const refresh = await tokens.issueRefresh('staff', 'S1', { tenantId: 'T9', accountId: 'A9' })
    const { access } = await tokens.rotateRefresh(refresh)
    const payload = await tokens.verify('staff', access)
    expect(payload.tenantId).toBe('T9')
    expect(payload.accountId).toBe('A9')
  })

  it('轮换出的新 access 已经进了会话集合（否则守卫会立刻判它死）', async () => {
    const refresh = await tokens.issueRefresh('staff', 'S1', { tenantId: 'T1', accountId: 'A1' })
    const { access } = await tokens.rotateRefresh(refresh)
    const payload = await tokens.verify('staff', access)
    expect(await sessions.isAlive('staff', 'S1', payload.jti)).toBe(true)
  })

  it('refresh 落在约定的 Redis key 上（key 形状是跨包契约，改了要同步运维脚本）', async () => {
    const refresh = await tokens.issueRefresh('platform', 'A1')
    const payload = await tokens.verifyRefresh(refresh)
    expect(await redis.get(refreshKey('platform', 'A1', payload.rid))).not.toBeNull()
    expect(refreshKey('platform', 'A1', 'R1')).toBe('auth:refresh:platform:A1:R1')
  })

  it('revokeRefresh 之后不能再换', async () => {
    const refresh = await tokens.issueRefresh('member', 'M1', { tenantId: 'T1' })
    const payload = await tokens.verifyRefresh(refresh)
    await tokens.revokeRefresh('member', 'M1', payload.rid)
    await expect(tokens.rotateRefresh(refresh)).rejects.toMatchObject({ code: 1140100 })
  })

  it('access token 不能拿去当 refresh 换', async () => {
    const access = await tokens.sign('staff', { sub: 'S1', tenantId: 'T1', ver: 1 })
    await expect(tokens.rotateRefresh(access)).rejects.toMatchObject({ code: 1140100 })
  })
})
