/** `SessionService` 单测：key 形状、踢最旧、全撤、死成员惰性 GC。 */

import { beforeEach, describe, expect, it } from 'vitest'
import { InMemoryAuthRedis } from '../redis'
import { FakeClock } from '../testing/fake-clock'
import {
  DEFAULT_CONCURRENCY,
  SessionService,
  sessionKey,
  sessionSetKey,
  type ConcurrencyLimits,
} from './session.service'

let clock: FakeClock
let redis: InMemoryAuthRedis
let sessions: SessionService

function build(limits: Partial<ConcurrencyLimits> = {}): void {
  clock = new FakeClock()
  redis = new InMemoryAuthRedis(() => clock.now())
  sessions = new SessionService(redis, { ...DEFAULT_CONCURRENCY, ...limits }, clock)
}

beforeEach(() => build())

describe('key 形状（跨包契约，改了要同步运维脚本）', () => {
  it('集合与单会话各一把', () => {
    expect(sessionSetKey('staff', 'S1')).toBe('auth:session:staff:S1')
    expect(sessionKey('staff', 'S1', 'J1')).toBe('auth:session:staff:S1:J1')
  })
})

describe('add / isAlive', () => {
  it('登记后判活为真，TTL 到点自动死（不需要谁去删）', async () => {
    await sessions.add('member', 'M1', 'J1', 60)
    expect(await sessions.isAlive('member', 'M1', 'J1')).toBe(true)
    clock.advanceSeconds(61)
    expect(await sessions.isAlive('member', 'M1', 'J1')).toBe(false)
  })

  it('没登记过的 jti 判活为假（默认拒绝，不是默认放行）', async () => {
    expect(await sessions.isAlive('member', 'M1', 'never')).toBe(false)
  })
})

describe('并发端数', () => {
  it('staff 默认 8 端，第 9 端把最旧的踢掉', async () => {
    for (let i = 1; i <= 8; i += 1) {
      clock.advanceSeconds(1)
      await sessions.add('staff', 'S1', `J${i}`, 3600)
    }
    expect((await sessions.list('staff', 'S1')).map((e) => e.jti)).toHaveLength(8)

    clock.advanceSeconds(1)
    const evicted = await sessions.add('staff', 'S1', 'J9', 3600)

    expect(evicted).toEqual(['J1'])
    expect(await sessions.isAlive('staff', 'S1', 'J1')).toBe(false)
    expect(await sessions.isAlive('staff', 'S1', 'J2')).toBe(true)
    expect(await sessions.isAlive('staff', 'S1', 'J9')).toBe(true)
  })

  it('一次超出多个也全踢掉（改配置调小上限之后的第一次登录）', async () => {
    build({ staff: 8 })
    for (let i = 1; i <= 8; i += 1) {
      clock.advanceSeconds(1)
      await sessions.add('staff', 'S1', `J${i}`, 3600)
    }
    // 换一个上限更小的服务实例（模拟改配置后重启）。
    const tighter = new SessionService(redis, { ...DEFAULT_CONCURRENCY, staff: 3 }, clock)
    clock.advanceSeconds(1)
    const evicted = await tighter.add('staff', 'S1', 'J9', 3600)
    expect(evicted).toEqual(['J1', 'J2', 'J3', 'J4', 'J5', 'J6'])
    expect((await tighter.list('staff', 'S1')).map((e) => e.jti)).toEqual(['J7', 'J8', 'J9'])
  })

  it('platform / member 默认单会话', async () => {
    await sessions.add('platform', 'A1', 'J1', 3600)
    clock.advanceSeconds(1)
    const evicted = await sessions.add('platform', 'A1', 'J2', 3600)
    expect(evicted).toEqual(['J1'])
  })

  it('上限设成 0 / 负数视为不限制（而不是把人全踢光）', async () => {
    build({ member: 0 })
    await sessions.add('member', 'M1', 'J1', 3600)
    clock.advanceSeconds(1)
    expect(await sessions.add('member', 'M1', 'J2', 3600)).toEqual([])
    expect(await sessions.isAlive('member', 'M1', 'J1')).toBe(true)
  })
})

describe('吊销', () => {
  it('revokeOne 只动一条', async () => {
    await sessions.add('staff', 'S1', 'J1', 3600)
    await sessions.add('staff', 'S1', 'J2', 3600)
    await sessions.revokeOne('staff', 'S1', 'J1')
    expect(await sessions.isAlive('staff', 'S1', 'J1')).toBe(false)
    expect(await sessions.isAlive('staff', 'S1', 'J2')).toBe(true)
  })

  it('revokeAll 清光，连集合 key 都不留', async () => {
    await sessions.add('staff', 'S1', 'J1', 3600)
    await sessions.add('staff', 'S1', 'J2', 3600)
    await sessions.revokeAll('staff', 'S1')

    expect(await sessions.isAlive('staff', 'S1', 'J1')).toBe(false)
    expect(await sessions.isAlive('staff', 'S1', 'J2')).toBe(false)
    expect(await redis.smembers(sessionSetKey('staff', 'S1'))).toEqual([])
  })

  it('revokeAll 不误伤别人', async () => {
    await sessions.add('staff', 'S1', 'J1', 3600)
    await sessions.add('staff', 'S2', 'J2', 3600)
    await sessions.revokeAll('staff', 'S1')
    expect(await sessions.isAlive('staff', 'S2', 'J2')).toBe(true)
  })

  it('revokeAll 对一个没登录过的人是空操作，不抛错', async () => {
    await expect(sessions.revokeAll('member', 'nobody')).resolves.toBeUndefined()
  })
})

describe('惰性 GC', () => {
  it('list 会把集合里已过期的死成员 SREM 掉', async () => {
    await sessions.add('staff', 'S1', 'J1', 10)
    clock.advanceSeconds(5)
    await sessions.add('staff', 'S1', 'J2', 3600)

    clock.advanceSeconds(6) // J1 到点了，J2 还活着
    const alive = await sessions.list('staff', 'S1')
    expect(alive.map((e) => e.jti)).toEqual(['J2'])
    // 集合里也不该再留着 J1，否则登录一年就攒出一坨死 jti。
    expect(await redis.smembers(sessionSetKey('staff', 'S1'))).toEqual(['J2'])
  })

  it('list 按签发时间从旧到新排序（踢最旧靠它）', async () => {
    clock.advanceSeconds(3)
    await sessions.add('staff', 'S1', 'later', 3600)
    clock.setTo(clock.now() - 2000)
    await sessions.add('staff', 'S1', 'earlier', 3600)
    expect((await sessions.list('staff', 'S1')).map((e) => e.jti)).toEqual(['earlier', 'later'])
  })
})
