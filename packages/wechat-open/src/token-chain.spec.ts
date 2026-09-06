/**
 * 三级 token 链路：ticket → component_access_token → authorizer_access_token。
 *
 * 用假 HttpClient 从头走一遍，重点盯四件在真实环境里「不会报错、只会诡异」的事：
 * 缓存命中、提前刷新、并发只发一次、40001 自愈。
 */

import { describe, expect, it } from 'vitest'
import { getAuthorizerInfo, queryAuth, refreshAuthorizerToken } from './authorizer'
import { ComponentClient, MemoryTokenCache, componentTokenKey } from './component'
import { WechatOpenError } from './errors'
import { MemoryTicketStore, parseComponentPush, receiveTicket } from './ticket'
import { buildEncryptedReply } from './msg-crypt'
import { FakeWechatOpenServer } from './testing'
import type { ComponentConfig } from './types'

const CONFIG: ComponentConfig = {
  appId: 'wx_component_appid',
  appSecret: 'component_secret',
  token: 'QDG6eK',
  aesKey: 'jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C',
}

/** 可拨的表：所有 TTL / 提前刷新的断言都靠它，不靠 sleep */
function fakeClock(start = 1_700_000_000_000) {
  let t = start
  return {
    now: () => t,
    advanceSec: (s: number) => {
      t += s * 1000
    },
  }
}

function setup(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now
  const http = new FakeWechatOpenServer()
  const ticketStore = new MemoryTicketStore(now)
  const tokenCache = new MemoryTokenCache(now)
  const client = new ComponentClient({ config: CONFIG, http, ticketStore, tokenCache, now })
  return { http, ticketStore, tokenCache, client }
}

describe('第一级：component_verify_ticket 是推过来的', () => {
  it('没收到 ticket 时报错要直接点名「授权事件接收 URL」', async () => {
    const { client } = setup()
    await expect(client.getComponentAccessToken()).rejects.toThrow(/授权事件接收 URL/)
  })

  it('报的是 TICKET_MISSING（1740000），不是笼统的调用失败', async () => {
    const { client } = setup()
    const err = await client.getComponentAccessToken().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WechatOpenError)
    expect((err as WechatOpenError).code).toBe(1740000)
  })

  it('推送解出来的 ticket 存得进去，永远以最新的为准', async () => {
    const clock = fakeClock()
    const { ticketStore } = setup({ now: clock.now })
    const push = (ticket: string) => {
      const xml =
        '<xml><AppId><![CDATA[wx_component_appid]]></AppId>' +
        '<CreateTime>1700000000</CreateTime>' +
        '<InfoType><![CDATA[component_verify_ticket]]></InfoType>' +
        `<ComponentVerifyTicket><![CDATA[${ticket}]]></ComponentVerifyTicket></xml>`
      const encrypted = buildEncryptedReply({
        aesKey: CONFIG.aesKey,
        token: CONFIG.token,
        message: xml,
        receiveId: CONFIG.appId,
        timestamp: '1700000000',
        nonce: 'n1',
      })
      return parseComponentPush({
        config: CONFIG,
        rawBody: encrypted,
        msgSignature:
          /<MsgSignature><!\[CDATA\[(.+?)\]\]><\/MsgSignature>/.exec(encrypted)?.[1] ?? '',
        timestamp: '1700000000',
        nonce: 'n1',
      })
    }

    const first = push('ticket_1')
    expect(first.infoType).toBe('component_verify_ticket')
    await receiveTicket(ticketStore, CONFIG.appId, first.ticket!)
    expect(await ticketStore.load(CONFIG.appId)).toBe('ticket_1')

    await receiveTicket(ticketStore, CONFIG.appId, push('ticket_2').ticket!)
    expect(await ticketStore.load(CONFIG.appId)).toBe('ticket_2')
    expect((await ticketStore.status(CONFIG.appId)).has).toBe(true)
  })
})

describe('第二级：component_access_token 的缓存与刷新', () => {
  it('第一次去换，第二次命中缓存——不再打微信', async () => {
    const { http, ticketStore, client } = setup()
    await ticketStore.save(CONFIG.appId, 'tk')
    http.on('api_component_token', { component_access_token: 'CAT_1', expires_in: 7200 })

    expect(await client.getComponentAccessToken()).toBe('CAT_1')
    expect(await client.getComponentAccessToken()).toBe('CAT_1')
    expect(http.countOf('api_component_token')).toBe(1)
  })

  it('**提前 5 分钟**换新的：卡在最后一秒刷新，并发请求里会有几个用到刚过期的 token', async () => {
    const clock = fakeClock()
    const { http, ticketStore, client } = setup({ now: clock.now })
    await ticketStore.save(CONFIG.appId, 'tk')
    http.on(
      'api_component_token',
      { component_access_token: 'CAT_1', expires_in: 7200 },
      { component_access_token: 'CAT_2', expires_in: 7200 },
    )

    expect(await client.getComponentAccessToken()).toBe('CAT_1')
    // 还剩 5 分零 1 秒：仍在有效期内，继续用旧的
    clock.advanceSec(7200 - 301)
    expect(await client.getComponentAccessToken()).toBe('CAT_1')
    // 剩不到 5 分钟：提前换掉
    clock.advanceSec(2)
    expect(await client.getComponentAccessToken()).toBe('CAT_2')
    expect(http.countOf('api_component_token')).toBe(2)
  })

  it('缓存 TTL 也比微信那边短：过期后取不到，会重新换一份', async () => {
    const clock = fakeClock()
    const { http, ticketStore, tokenCache, client } = setup({ now: clock.now })
    await ticketStore.save(CONFIG.appId, 'tk')
    http.on(
      'api_component_token',
      { component_access_token: 'CAT_1', expires_in: 7200 },
      { component_access_token: 'CAT_2', expires_in: 7200 },
    )
    await client.getComponentAccessToken()
    clock.advanceSec(7200)
    expect(await tokenCache.get(componentTokenKey(CONFIG.appId))).toBeNull()
    expect(await client.getComponentAccessToken()).toBe('CAT_2')
  })

  it('并发取只发一次请求——各发一次的话微信会让先发的失效', async () => {
    const { http, ticketStore, client } = setup()
    await ticketStore.save(CONFIG.appId, 'tk')
    http.on('api_component_token', { component_access_token: 'CAT_1', expires_in: 7200 })

    const all = await Promise.all([
      client.getComponentAccessToken(),
      client.getComponentAccessToken(),
      client.getComponentAccessToken(),
    ])
    expect(all).toEqual(['CAT_1', 'CAT_1', 'CAT_1'])
    expect(http.countOf('api_component_token')).toBe(1)
  })

  it('强刷丢掉缓存重新换一个，并记得住「上一个是我们的」（40001 重试要靠它）', async () => {
    const { http, ticketStore, client } = setup()
    await ticketStore.save(CONFIG.appId, 'tk')
    http.on(
      'api_component_token',
      { component_access_token: 'CAT_1', expires_in: 7200 },
      { component_access_token: 'CAT_2', expires_in: 7200 },
    )
    expect(await client.getComponentAccessToken()).toBe('CAT_1')
    expect(await client.getComponentAccessToken(true)).toBe('CAT_2')
    // 被换掉的那份仍要认得出来，否则重试时会被误判成商家的 token 而放弃
    expect(await client.wasMine('CAT_1')).toBe(true)
    expect(await client.wasMine('CAT_2')).toBe(true)
    expect(await client.wasMine('别人的_token')).toBe(false)
  })

  it('并发强刷搭同一趟车——各换各的会互相拆台，后换的把先换的换废', async () => {
    const { http, ticketStore, client } = setup()
    await ticketStore.save(CONFIG.appId, 'tk')
    http.on(
      'api_component_token',
      { component_access_token: 'CAT_1', expires_in: 7200 },
      { component_access_token: 'CAT_2', expires_in: 7200 },
    )
    await client.getComponentAccessToken()
    const [a, b] = await Promise.all([
      client.getComponentAccessToken(true),
      client.getComponentAccessToken(true),
    ])
    expect(a).toBe(b)
    expect(http.countOf('api_component_token')).toBe(2)
  })

  it('40001 抛的是 TOKEN_INVALID（可自愈），普通 errcode 抛 API_FAILED', async () => {
    const { http, ticketStore, client } = setup()
    await ticketStore.save(CONFIG.appId, 'tk')
    http.on('api_component_token', { component_access_token: 'CAT_1', expires_in: 7200 })
    http.on('api_create_preauthcode', { errcode: 40001, errmsg: 'invalid credential' })
    const err = await client.preAuthCode().catch((e: unknown) => e)
    expect((err as WechatOpenError).code).toBe(1740002)
    expect((err as WechatOpenError).errcode).toBe(40001)

    const http2 = setup()
    await http2.ticketStore.save(CONFIG.appId, 'tk')
    http2.http.on('api_component_token', { component_access_token: 'CAT_1', expires_in: 7200 })
    http2.http.on('api_create_preauthcode', { errcode: 61004, errmsg: 'ip not in whitelist' })
    const err2 = await http2.client.preAuthCode().catch((e: unknown) => e)
    expect((err2 as WechatOpenError).code).toBe(1740001)
    expect((err2 as WechatOpenError).message).toContain('61004')
  })

  it('预授权码不缓存——缓存下来第二个商家点进去就是一个已被用掉的码', async () => {
    const { http, ticketStore, client } = setup()
    await ticketStore.save(CONFIG.appId, 'tk')
    http.on('api_component_token', { component_access_token: 'CAT_1', expires_in: 7200 })
    http.on('api_create_preauthcode', { pre_auth_code: 'PAC_1' }, { pre_auth_code: 'PAC_2' })
    expect(await client.preAuthCode()).toBe('PAC_1')
    expect(await client.preAuthCode()).toBe('PAC_2')
  })

  it('每个请求都自动带上 component_appid——漏传时微信只回一句 invalid appid', async () => {
    const { http, ticketStore, client } = setup()
    await ticketStore.save(CONFIG.appId, 'tk')
    http.on('api_component_token', { component_access_token: 'CAT_1', expires_in: 7200 })
    http.on('api_create_preauthcode', { pre_auth_code: 'PAC_1' })
    await client.preAuthCode()
    for (const call of http.calls) {
      expect((call.body as Record<string, unknown>).component_appid).toBe(CONFIG.appId)
    }
    // 带 token 的调用把它放在 query 上
    expect(http.calls.at(-1)!.url).toContain('component_access_token=CAT_1')
  })
})

describe('第三级：authorizer_access_token', () => {
  async function ready() {
    const clock = fakeClock()
    const s = setup({ now: clock.now })
    await s.ticketStore.save(CONFIG.appId, 'tk')
    s.http.on('api_component_token', { component_access_token: 'CAT_1', expires_in: 7200 })
    return { ...s, clock }
  }

  it('queryAuth 换回 appid + refresh_token + 权限集', async () => {
    const { http, client } = await ready()
    http.on('api_query_auth', {
      authorization_info: {
        authorizer_appid: 'wx_biz',
        authorizer_access_token: 'AAT_1',
        authorizer_refresh_token: 'ART_1',
        expires_in: 7200,
        func_info: [{ funcscope_category: { id: 1 } }, { funcscope_category: { id: 15 } }],
      },
    })
    const res = await queryAuth(client, 'auth_code_1')
    expect(res).toEqual({
      authorizerAppId: 'wx_biz',
      authorizerAccessToken: 'AAT_1',
      authorizerRefreshToken: 'ART_1',
      expiresIn: 7200,
      funcInfo: [1, 15],
    })
  })

  it('缺 refresh_token 就是授权码失效，不能当成成功', async () => {
    const { http, client } = await ready()
    http.on('api_query_auth', { authorization_info: { authorizer_appid: 'wx_biz' } })
    await expect(queryAuth(client, 'bad')).rejects.toThrow(/重新发起授权/)
  })

  it('getAuthorizerInfo 用 MiniProgramInfo 的有无区分公众号与小程序', async () => {
    const { http, client } = await ready()
    http.on('api_get_authorizer_info', {
      authorizer_info: {
        nick_name: '某某书店',
        head_img: 'h',
        principal_name: 'P',
        user_name: 'gh_1',
      },
    })
    expect((await getAuthorizerInfo(client, 'wx_biz')).kind).toBe('MP')

    const s2 = await ready()
    s2.http.on('api_get_authorizer_info', {
      authorizer_info: { nick_name: '某某小程序', MiniProgramInfo: { network: {} } },
    })
    expect((await getAuthorizerInfo(s2.client, 'wx_mini')).kind).toBe('MINI')
  })

  it('token 缓存命中，过期后重新刷', async () => {
    const { http, client, clock } = await ready()
    http.on(
      'api_authorizer_token',
      { authorizer_access_token: 'AAT_1', expires_in: 7200 },
      { authorizer_access_token: 'AAT_2', expires_in: 7200 },
    )
    expect(await client.authorizerAccessToken('wx_biz', 'ART_1')).toBe('AAT_1')
    expect(await client.authorizerAccessToken('wx_biz', 'ART_1')).toBe('AAT_1')
    expect(http.countOf('api_authorizer_token')).toBe(1)

    clock.advanceSec(7200 - 299)
    expect(await client.authorizerAccessToken('wx_biz', 'ART_1')).toBe('AAT_2')
    expect(http.countOf('api_authorizer_token')).toBe(2)
  })

  it('**微信下发新的 refresh_token 就必须回调出去存**——漏了会「用了很久突然全部失败」', async () => {
    const { http, client } = await ready()
    http.on('api_authorizer_token', {
      authorizer_access_token: 'AAT_1',
      authorizer_refresh_token: 'ART_2',
      expires_in: 7200,
    })
    const saved: string[] = []
    await client.authorizerAccessToken('wx_biz', 'ART_1', (next) => {
      saved.push(next)
    })
    expect(saved).toEqual(['ART_2'])
  })

  it('refresh_token 没换新的就不回调，免得每次都白写一遍库', async () => {
    const { http, client } = await ready()
    http.on('api_authorizer_token', {
      authorizer_access_token: 'AAT_1',
      authorizer_refresh_token: 'ART_1',
      expires_in: 7200,
    })
    const saved: string[] = []
    await client.authorizerAccessToken('wx_biz', 'ART_1', (n) => void saved.push(n))
    expect(saved).toEqual([])
  })

  it('取消/重新授权后 forgetAuthorizer 丢掉缓存，下次拿到的是新的', async () => {
    const { http, client } = await ready()
    http.on(
      'api_authorizer_token',
      { authorizer_access_token: 'AAT_1', expires_in: 7200 },
      { authorizer_access_token: 'AAT_2', expires_in: 7200 },
    )
    expect(await client.authorizerAccessToken('wx_biz', 'ART_1')).toBe('AAT_1')
    await client.forgetAuthorizer('wx_biz')
    expect(await client.authorizerAccessToken('wx_biz', 'ART_1')).toBe('AAT_2')
  })

  it('两个授权方各缓存各的，不会串号', async () => {
    const { http, client } = await ready()
    http.on(
      'api_authorizer_token',
      { authorizer_access_token: 'A_ONE', expires_in: 7200 },
      { authorizer_access_token: 'A_TWO', expires_in: 7200 },
    )
    expect(await client.authorizerAccessToken('wx_one', 'r1')).toBe('A_ONE')
    expect(await client.authorizerAccessToken('wx_two', 'r2')).toBe('A_TWO')
    expect(await client.authorizerAccessToken('wx_one', 'r1')).toBe('A_ONE')
  })

  it('拿不到 access_token 时要让商家重新授权，不能返回空串', async () => {
    const { http, client } = await ready()
    http.on('api_authorizer_token', { errmsg: 'ok' })
    await expect(
      refreshAuthorizerToken(client, { authorizerAppId: 'wx_biz', refreshToken: 'r' }),
    ).rejects.toThrow(/重新授权/)
  })
})
