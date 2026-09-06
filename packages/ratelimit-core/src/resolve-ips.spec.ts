/**
 * `resolveIps` 的行为用例。
 *
 * 这一组的核心只有一句：**攻击者往 XFF 开头塞任何东西，都不能改变 `client`**。
 * 其余用例都是围着这句话的边界。
 */

import { describe, expect, it } from 'vitest'
import { normalizeIp, resolveIps } from './resolve-ips'

/** 线上真实拓扑：客户端 → EdgeOne（追加真实客户端 IP）→ nginx（追加 EdgeOne 出口 IP）→ Node。 */
const HOPS = 2
const REAL_CLIENT = '222.137.6.155'
const EDGE = '114.66.247.140'

const at = (xff?: string, socketIp = '127.0.0.1', trustedHops = HOPS) =>
  resolveIps({ xff, socketIp, trustedHops })

describe('resolveIps 正常链路', () => {
  it('取到 EdgeOne 断言的真实客户端 IP，末段是 nginx 追加的入口 IP', () => {
    const r = at(`${REAL_CLIENT}, ${EDGE}`)
    expect(r.client).toBe(REAL_CLIENT)
    expect(r.edge).toBe(EDGE)
    expect(r.source).toBe('hops')
  })

  it('chain 原样回传，供上线后核对 TRUSTED_PROXY_HOPS 是否与真实拓扑一致', () => {
    expect(at(`${REAL_CLIENT}, ${EDGE}`).chain).toBe(`${REAL_CLIENT} | ${EDGE}`)
  })

  it('容忍多余空格与空段', () => {
    expect(at(`  ${REAL_CLIENT} ,, ${EDGE}  `).client).toBe(REAL_CLIENT)
  })

  it('同名头出现多次（express 给数组）时按顺序拼接后再解析', () => {
    const r = resolveIps({ xff: ['9.9.9.9', `${REAL_CLIENT}, ${EDGE}`], trustedHops: HOPS })
    expect(r.client).toBe(REAL_CLIENT)
    expect(r.edge).toBe(EDGE)
  })

  it('hops=1（没有 CDN，只有 nginx）时取末段', () => {
    expect(at(`9.9.9.9, 203.0.113.7`, '127.0.0.1', 1).client).toBe('203.0.113.7')
  })
})

describe('resolveIps 伪造 XFF —— 不变量 6 的正面战场', () => {
  // knowledge CLAUDE.md 第 6 条：「实测过：伪造后限流 key 直接变成伪造值，限流形同虚设」
  it('攻击者自带一段伪造 IP，client 不被带偏', () => {
    const r = at(`9.9.9.9, ${REAL_CLIENT}, ${EDGE}`)
    expect(r.client).not.toBe('9.9.9.9')
    expect(r.client).toBe(REAL_CLIENT)
    expect(r.edge).toBe(EDGE)
  })

  it('塞入大量伪造段也只是被忽略，末尾可信段的位置不变', () => {
    const r = at(`1.1.1.1, 2.2.2.2, 3.3.3.3, 4.4.4.4, 5.5.5.5, ${REAL_CLIENT}, ${EDGE}`)
    expect(r.client).toBe(REAL_CLIENT)
    expect(r.edge).toBe(EDGE)
  })

  it('无论伪造几段，解析结果与诚实请求逐字段相等（限流 key 因此不变）', () => {
    const honest = at(`${REAL_CLIENT}, ${EDGE}`)
    for (const prefix of ['9.9.9.9', '9.9.9.9, 8.8.8.8', Array(50).fill('7.7.7.7').join(', ')]) {
      const spoofed = at(`${prefix}, ${REAL_CLIENT}, ${EDGE}`)
      expect({ client: spoofed.client, edge: spoofed.edge }).toEqual({
        client: honest.client,
        edge: honest.edge,
      })
    }
  })

  it('往开头塞非法段（想把整个头搞废、退回 socketIp 共用一个桶）也不成立', () => {
    // 如果实现是「有一段非法就整个头作废」，攻击者只要写一个 `not-an-ip` 就能
    // 把所有人赶到同一个 socketIp 桶里——那正好是他要的结果。
    const r = at(`not-an-ip, <script>, 999.999.999.999, ${REAL_CLIENT}, ${EDGE}`)
    expect(r.client).toBe(REAL_CLIENT)
    expect(r.edge).toBe(EDGE)
    expect(r.rejected).toBe(3)
  })

  it('末段永远是 nginx 亲自追加的，攻击者影响不了', () => {
    expect(at(`9.9.9.9, 8.8.8.8, ${REAL_CLIENT}, ${EDGE}`).edge).toBe(
      at(`${REAL_CLIENT}, ${EDGE}`).edge,
    )
  })
})

describe('resolveIps hops 边界与降级', () => {
  it('段数比 hops 少时退回末段（入口 IP），绝不退回到可伪造的开头段', () => {
    const r = at('9.9.9.9')
    expect(r.client).toBe('9.9.9.9') // 只有一段时它就是 nginx 追加的那段
    expect(r.edge).toBe('9.9.9.9')
    expect(r.source).toBe('edge')
  })

  it('hops 配得比真实链路长（比如 5 层）时也只会退到末段，不会越界取到伪造段', () => {
    const r = at(`9.9.9.9, 8.8.8.8, ${REAL_CLIENT}, ${EDGE}`, '127.0.0.1', 5)
    expect(r.client).toBe(EDGE)
    expect(r.source).toBe('edge')
  })

  it('hops 恰好等于段数时取第一段（此时整条链都是基础设施写的）', () => {
    const r = at(`${REAL_CLIENT}, ${EDGE}`, '127.0.0.1', 2)
    expect(r.client).toBe(REAL_CLIENT)
    expect(r.source).toBe('hops')
  })

  it('hops=0（Node 直接对外，没有任何反代）时整个 XFF 都不可信，只认连接层地址', () => {
    const r = at(`9.9.9.9, 8.8.8.8`, '203.0.113.9', 0)
    expect(r.client).toBe('203.0.113.9')
    expect(r.edge).toBe('203.0.113.9')
    expect(r.source).toBe('socket')
  })

  it.each([
    ['负数', -3],
    ['小数', 1.5],
    ['NaN', Number.NaN],
  ])('hops 是%s时按 0 处理（宁可粒度粗，不可取到伪造段）', (_label, hops) => {
    const r = at(`9.9.9.9, ${EDGE}`, '203.0.113.9', hops as number)
    expect(r.client).not.toBe('9.9.9.9')
  })

  it('没有 XFF 头时用连接层对端地址', () => {
    const r = at(undefined, '10.0.0.5')
    expect(r).toMatchObject({ client: '10.0.0.5', edge: '10.0.0.5', source: 'socket' })
  })

  it('XFF 全是非法段且没有 socketIp 时回 unknown（而不是空串或 undefined）', () => {
    const r = resolveIps({ xff: 'garbage, also-garbage', trustedHops: 2 })
    expect(r.client).toBe('unknown')
    expect(r.edge).toBe('unknown')
  })
})

describe('normalizeIp 归一化 —— 同一个人不要落进两个桶', () => {
  it.each([
    ['带端口的 IPv4', '1.2.3.4:5678', '1.2.3.4'],
    ['带端口的 IPv6', '[2001:db8::1]:443', '2001:db8::1'],
    ['方括号 IPv6', '[::1]', '::1'],
    ['IPv4-mapped IPv6（Node 双栈监听给的形状）', '::ffff:1.2.3.4', '1.2.3.4'],
    ['IPv6 大写', '2001:DB8::AB', '2001:db8::ab'],
    ['普通 IPv4', '203.0.113.7', '203.0.113.7'],
  ])('%s → %s', (_label, input, expected) => {
    expect(normalizeIp(input)).toBe(expected)
  })

  it.each([
    ['空串', ''],
    ['随便一个词', 'unknown'],
    ['八卦域名', 'evil.example.com'],
    ['越界的段', '999.1.1.1'],
    ['前导零（会变成两个 key）', '01.2.3.4'],
    ['注入尝试', "1.2.3.4'; DROP TABLE"],
    ['三个连续冒号', '::: '],
  ])('%s 判为非法', (_label, input) => {
    expect(normalizeIp(input)).toBeUndefined()
  })

  it('前导零的两种写法不会变成两个限流 key', () => {
    // `01.2.3.4` 被判非法而丢弃，于是不会有第二个桶
    expect(resolveIps({ xff: '01.2.3.4, 5.6.7.8', trustedHops: 2 }).client).toBe('5.6.7.8')
  })
})
