/**
 * 中转站扫码登录：四态轮询 + ticket 兑换。
 *
 * 用 {@link FakeRelayServer} 造出真中转站会给的每一种回复。至少要盖住 skill 里那张清单：
 * poll_token 不下发、四态映射、token 只交一次、兑换失败不重试、中转站抖动仍 PENDING。
 */

import { describe, expect, it } from 'vitest'
import { WechatOpenError } from './errors'
import {
  MemoryRelaySessionStore,
  RELAY_CALLBACK_PATH,
  RELAY_CLIENT_ID_RE,
  RELAY_DEFAULT_URL,
  RelayLoginClient,
  buildRelayStartUrl,
  createRelaySession,
  exchangeRelayCode,
  parseRelayExchange,
  pollRelay,
  relayCallbackUrl,
  relayErrorMessage,
  toRelayStatus,
} from './relay-login'
import { FakeRelayServer } from './testing'

const CLIENT_ID = 'cli_9b77b1d59932c1b8'

function client(relay = new FakeRelayServer(), now = () => 1_700_000_000_000) {
  return {
    relay,
    login: new RelayLoginClient({
      http: relay,
      clientId: CLIENT_ID,
      clientSecret: 'sec_only_on_server',
      sessions: new MemoryRelaySessionStore(now),
      now,
    }),
  }
}

describe('状态映射写死四种', () => {
  it('pending / scanned / confirmed / expired 各映一个', () => {
    expect(toRelayStatus('pending')).toBe('PENDING')
    expect(toRelayStatus('scanned')).toBe('SCANNED')
    expect(toRelayStatus('confirmed')).toBe('CONFIRMED')
    expect(toRelayStatus('expired')).toBe('EXPIRED')
  })

  it('认不出的状态当 PENDING（下一轮再问），不当失败', () => {
    for (const v of [undefined, null, '', 'WHATEVER', 42]) {
      expect(toRelayStatus(v), String(v)).toBe('PENDING')
    }
  })
})

describe('出码', () => {
  it('拿到 scene / poll_token / qr_url / expires_in', async () => {
    const relay = new FakeRelayServer()
    const s = await createRelaySession({ http: relay, clientId: CLIENT_ID })
    expect(s.scene).toBe('scene_1')
    expect(s.pollToken).toBe('pt_1')
    expect(s.qrUrl).toContain('mp.weixin.qq.com/cgi-bin/showqrcode')
    expect(s.expiresIn).toBe(300)
    expect(relay.calls[0]?.url).toBe(`${RELAY_DEFAULT_URL}/oauth/qr/create`)
  })

  it('出码失败翻成人话，并带上原始错误码', async () => {
    const relay = new FakeRelayServer()
    relay.failNext('UNKNOWN_CLIENT')
    const err = await createRelaySession({ http: relay, clientId: CLIENT_ID }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(WechatOpenError)
    expect((err as WechatOpenError).errcode).toBe('UNKNOWN_CLIENT')
    expect((err as WechatOpenError).message).toContain('联系商家')
  })

  it('**poll_token 与 scene 不下发前端**——只给我方自己发的 sessionId', async () => {
    const { login } = client()
    const res = await login.createRelaySession()
    expect(Object.keys(res).sort()).toEqual(['expiresIn', 'qrUrl', 'sessionId'])
    expect(JSON.stringify(res)).not.toContain('pt_1')
    expect(JSON.stringify(res)).not.toContain('scene_1')
  })
})

describe('四态轮询', () => {
  it('PENDING → SCANNED → CONFIRMED，走完一次完整登录', async () => {
    const { relay, login } = client()
    const { sessionId } = await login.createRelaySession()

    expect((await login.pollRelay(sessionId)).status).toBe('PENDING')
    relay.scan()
    expect((await login.pollRelay(sessionId)).status).toBe('SCANNED')
    relay.confirm()

    const done = await login.pollRelay(sessionId)
    expect(done.status).toBe('CONFIRMED')
    expect(done.identity).toEqual({
      openId: 'o_fake_openid',
      unionId: 'u_fake_unionid',
      nickname: '钛赞测试',
      avatar: 'https://example.test/a.png',
    })
  })

  it('二维码过期 → EXPIRED，且会话被删掉', async () => {
    const { relay, login } = client()
    const { sessionId } = await login.createRelaySession()
    relay.expire()
    expect((await login.pollRelay(sessionId)).status).toBe('EXPIRED')
    expect((await login.pollRelay(sessionId)).status).toBe('EXPIRED')
  })

  it('**中转站抖动（超时/连接断）仍返回 PENDING**，别把一次网络抖动报成失败', async () => {
    const { relay, login } = client()
    const { sessionId } = await login.createRelaySession()
    relay.flaky = true
    expect((await login.pollRelay(sessionId)).status).toBe('PENDING')
    relay.flaky = false
    relay.scan()
    expect((await login.pollRelay(sessionId)).status).toBe('SCANNED')
  })

  it('中转站回一个陌生错误码时也当抖动——这个接口每 2 秒打一次', async () => {
    const { relay, login } = client()
    const { sessionId } = await login.createRelaySession()
    relay.failNext('SOME_TRANSIENT_THING')
    expect((await login.pollRelay(sessionId)).status).toBe('PENDING')
  })

  it('BAD_POLL_TOKEN 是终态：scene 与 poll_token 对不上，重问一百次也一样', async () => {
    const relay = new FakeRelayServer()
    await createRelaySession({ http: relay, clientId: CLIENT_ID })
    relay.failNext('BAD_POLL_TOKEN')
    const res = await pollRelay({ http: relay, scene: 'scene_1', pollToken: '错的' })
    expect(res.status).toBe('EXPIRED')
  })

  it('**token 只交一次**：终态交付后同一个 sessionId 再问就是 EXPIRED', async () => {
    const { relay, login } = client()
    const { sessionId } = await login.createRelaySession()
    relay.confirm()
    expect((await login.pollRelay(sessionId)).status).toBe('CONFIRMED')
    expect((await login.pollRelay(sessionId)).status).toBe('EXPIRED')
  })

  it('本地没这个 sessionId 就直接 EXPIRED，不去问中转站', async () => {
    const { relay, login } = client()
    const before = relay.calls.length
    expect((await login.pollRelay('从没发过的 sid')).status).toBe('EXPIRED')
    expect(relay.calls.length).toBe(before)
  })

  it('会话本地过期后不再轮询——会话是我方发的，我方说没有就是没有', async () => {
    let t = 1_700_000_000_000
    const relay = new FakeRelayServer()
    const login = new RelayLoginClient({
      http: relay,
      clientId: CLIENT_ID,
      clientSecret: 's',
      sessions: new MemoryRelaySessionStore(() => t),
      now: () => t,
    })
    const { sessionId } = await login.createRelaySession()
    t += 301_000
    const before = relay.calls.length
    expect((await login.pollRelay(sessionId)).status).toBe('EXPIRED')
    expect(relay.calls.length).toBe(before)
  })
})

describe('ticket 兑换', () => {
  it('兑换成功回身份，且 client_secret 只出现在这一个请求体里', async () => {
    const relay = new FakeRelayServer()
    relay.confirm('tk_1')
    const id = await exchangeRelayCode({
      http: relay,
      clientId: CLIENT_ID,
      clientSecret: 'sec',
      ticket: 'tk_1',
    })
    expect(id.openId).toBe('o_fake_openid')
    const exchanges = relay.calls.filter((c) => c.url.includes('/oauth/exchange'))
    expect(exchanges).toHaveLength(1)
    expect(relay.calls.filter((c) => c.url.includes('sec'))).toHaveLength(0)
  })

  it('**ticket 一次性**：同一个 ticket 兑换第二次一律 TICKET_INVALID', async () => {
    const relay = new FakeRelayServer()
    relay.confirm('tk_1')
    const args = { http: relay, clientId: CLIENT_ID, clientSecret: 'sec', ticket: 'tk_1' }
    await exchangeRelayCode(args)
    const err = await exchangeRelayCode(args).catch((e: unknown) => e)
    expect((err as WechatOpenError).errcode).toBe('TICKET_INVALID')
    expect((err as WechatOpenError).message).toContain('重新发起微信登录')
  })

  it('**兑换失败不重试**：只发一次请求，然后让用户重扫', async () => {
    const { relay, login } = client()
    const { sessionId } = await login.createRelaySession()
    relay.confirm('tk_good')
    relay.failNext('TICKET_INVALID', 'exchange')
    const res = await login.pollRelay(sessionId)
    expect(res.status).toBe('EXPIRED')
    expect(res.note).toContain('重新发起微信登录')
    expect(relay.calls.filter((c) => c.url.includes('/oauth/exchange'))).toHaveLength(1)
  })

  it('响应里没有 openid 时报错，不返回一个空身份', async () => {
    const relay = new FakeRelayServer()
    relay.confirm('tk_1')
    relay.identity = { unionid: 'u1', user: { nickname: 'N' } }
    await expect(
      exchangeRelayCode({ http: relay, clientId: CLIENT_ID, clientSecret: 's', ticket: 'tk_1' }),
    ).rejects.toThrow(/没有返回微信身份/)
  })
})

describe('exchange 响应整理', () => {
  it('openid 是唯一必填；user 为 null、unionid 缺失都不是错', () => {
    expect(
      parseRelayExchange({ openid: 'o1', unionid: 'u1', user: { nickname: 'N', headimgurl: 'H' } }),
    ).toEqual({ openId: 'o1', unionId: 'u1', nickname: 'N', avatar: 'H' })
    expect(
      parseRelayExchange({ openid: 'o1', unionid: null, scope: 'snsapi_base', user: null }),
    ).toEqual({ openId: 'o1', unionId: null, nickname: null, avatar: null })
    expect(parseRelayExchange({ user: { nickname: 'N' } })).toBeNull()
    expect(parseRelayExchange(null)).toBeNull()
  })
})

describe('H5 那条路的地址', () => {
  it('client_id 的形状：cli_ + 16 位十六进制', () => {
    expect(RELAY_CLIENT_ID_RE.test(CLIENT_ID)).toBe(true)
    expect(RELAY_CLIENT_ID_RE.test('wx9b77b1d59932c1b8')).toBe(false)
    expect(RELAY_CLIENT_ID_RE.test('cli_9b77')).toBe(false)
  })

  it('要填进白名单的地址就是 H5 域名 + 固定路径，末尾斜杠不重复', () => {
    expect(relayCallbackUrl('https://know.taizan.vip/')).toBe(
      'https://know.taizan.vip/auth/callback',
    )
    expect(relayCallbackUrl('https://know.taizan.vip')).toBe(
      'https://know.taizan.vip/auth/callback',
    )
  })

  it('发起地址带齐四个参数，回跳被搬到固定 pathname 上、query 原样保留', () => {
    const u = new URL(
      buildRelayStartUrl({
        clientId: CLIENT_ID,
        redirectUri: 'https://know.taizan.vip/pages/my?shop=demo#x',
        state: 'S1',
      }),
    )
    expect(u.origin + u.pathname).toBe(`${RELAY_DEFAULT_URL}/oauth/start`)
    expect(u.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(u.searchParams.get('scope')).toBe('snsapi_userinfo')
    expect(u.searchParams.get('state')).toBe('S1')
    const back = new URL(u.searchParams.get('redirect_uri') as string)
    expect(back.pathname).toBe(RELAY_CALLBACK_PATH)
    expect(back.searchParams.get('shop')).toBe('demo')
    expect(back.hash).toBe('')
    expect(back.host).toBe('know.taizan.vip')
  })
})

describe('错误码翻成人话', () => {
  it('分得清「学员重来」与「找商家」', () => {
    expect(relayErrorMessage('TICKET_INVALID')).toContain('重新')
    for (const code of [
      'QUOTA_EXCEEDED',
      'TENANT_EXPIRED',
      'NO_REDIRECT_URI',
      'REDIRECT_URI_NOT_ALLOWED',
      'UNKNOWN_CLIENT',
      'INVALID_CLIENT_SECRET',
      'IP_NOT_ALLOWED',
      'SCOPE_NOT_ALLOWED',
    ]) {
      expect(relayErrorMessage(code), code).toContain('商家')
    }
    expect(relayErrorMessage('WHATEVER', 'x')).toContain('x')
    expect(relayErrorMessage(undefined)).toContain('稍后重试')
  })
})
