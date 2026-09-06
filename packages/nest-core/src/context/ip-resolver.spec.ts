import { describe, expect, it } from 'vitest'
import { ContextMiddleware } from './context.middleware'
import {
  PlaceholderIpResolver,
  readIpSource,
  type IpBearingRequest,
  type IpResolver,
  type IpSource,
} from './ip-resolver'
import { currentContext } from './als'
import type { Request, Response } from 'express'

const fakeRes = (): Response => ({ setHeader: () => undefined }) as unknown as Response

const fakeReq = (headers: Record<string, string | string[] | undefined>, socketIp?: string) =>
  ({ headers, socket: { remoteAddress: socketIp } }) as unknown as Request

describe('readIpSource', () => {
  it('原样取出 XFF 与连接层地址，不做任何取段判断', () => {
    const req: IpBearingRequest = {
      headers: { 'x-forwarded-for': '9.9.9.9, 1.2.3.4' },
      socket: { remoteAddress: '127.0.0.1' },
    }
    expect(readIpSource(req)).toEqual({ xff: '9.9.9.9, 1.2.3.4', socketIp: '127.0.0.1' })
  })

  it('同名头出现多次时把数组原样带走（判断留给 resolveIps）', () => {
    const req: IpBearingRequest = { headers: { 'x-forwarded-for': ['a', 'b'] } }
    expect(readIpSource(req).xff).toEqual(['a', 'b'])
  })

  it('什么都没有时两个字段都是 undefined，不抛', () => {
    expect(readIpSource({})).toEqual({ xff: undefined, socketIp: undefined })
  })
})

describe('PlaceholderIpResolver', () => {
  const resolver = new PlaceholderIpResolver()

  it('client 与 edge 都用连接层地址——**刻意不碰 XFF**', () => {
    // 不知道 TRUSTED_PROXY_HOPS 的情况下，任何一种取段方式都可能取到攻击者写的那段。
    // 粗到没用（看得见的误伤）好过细到可伪造（看不见的失效）。
    const source: IpSource = { xff: '9.9.9.9, 1.2.3.4', socketIp: '10.0.0.1' }
    expect(resolver.resolve(source)).toEqual({ client: '10.0.0.1', edge: '10.0.0.1' })
  })

  it('连接层地址也没有时回 unknown（而不是空串）', () => {
    expect(resolver.resolve({ xff: undefined, socketIp: undefined }).client).toBe('unknown')
  })
})

describe('ContextMiddleware 的 ip 注入点', () => {
  it('不注入解析器时走占位实现', () => {
    const mw = new ContextMiddleware()
    let seen: { client: string; edge: string } | undefined
    mw.use(fakeReq({ 'x-forwarded-for': '9.9.9.9' }, '10.0.0.1'), fakeRes(), () => {
      seen = currentContext()?.ip
    })
    expect(seen).toEqual({ client: '10.0.0.1', edge: '10.0.0.1' })
  })

  it('注入的解析器会被用上，且拿到的是原始 XFF（T2-6 把 resolveIps 接在这里）', () => {
    const captured: IpSource[] = []
    const resolver: IpResolver = {
      resolve(source) {
        captured.push(source)
        return { client: '222.137.6.155', edge: '114.66.247.140' }
      },
    }
    const mw = new ContextMiddleware(resolver)
    let seen: { client: string; edge: string } | undefined
    mw.use(
      fakeReq({ 'x-forwarded-for': '9.9.9.9, 222.137.6.155, 114.66.247.140' }, '127.0.0.1'),
      fakeRes(),
      () => {
        seen = currentContext()?.ip
      },
    )
    expect(captured).toEqual([
      { xff: '9.9.9.9, 222.137.6.155, 114.66.247.140', socketIp: '127.0.0.1' },
    ])
    expect(seen).toEqual({ client: '222.137.6.155', edge: '114.66.247.140' })
  })
})
