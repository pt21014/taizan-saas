/**
 * spec 12（蓝图 §8 / 不变量 7）：网页授权 state 与 `redirect_uri` 的安全性。
 *
 * 这一套用例挡的都是「不写也不会报错」的东西：state 能重复用、跨租户能用、
 * `redirect_uri` 被调用方指定成站外——三样在功能测试里全是绿的。
 */

import { describe, expect, it } from 'vitest'
import { WechatOpenError } from './errors'
import {
  DEFAULT_STATE_TTL_SEC,
  MemoryOneTimeStore,
  assertStateTenant,
  buildAuthorizeUrl,
  buildOAuthUrl,
  consumeState,
  issueState,
  safeHost,
  safeRedirectPath,
} from './oauth-state'

function fakeClock(start = 1_700_000_000_000) {
  let t = start
  return {
    now: () => t,
    advanceSec: (s: number) => {
      t += s * 1000
    },
  }
}

describe('state 服务端签发', () => {
  it('随机 32 字节 → base64url，两次签发不会撞', async () => {
    const store = new MemoryOneTimeStore()
    const a = await issueState({ tenantId: 't1', redirectPath: '/', store })
    const b = await issueState({ tenantId: 't1', redirectPath: '/', store })
    expect(a).not.toBe(b)
    // base64url 编码 32 字节 = 43 个字符，且不含 + / =
    expect(a).toHaveLength(43)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('缺省 TTL 是 5 分钟——留给「人在微信里点一下同意」', () => {
    expect(DEFAULT_STATE_TTL_SEC).toBe(300)
  })

  it('签发时就把回跳路径洗过一遍，站外地址进不了库', async () => {
    const store = new MemoryOneTimeStore()
    await expect(
      issueState({ tenantId: 't1', redirectPath: 'https://evil.com/x', store }),
    ).rejects.toThrow(WechatOpenError)
  })
})

describe('state 一次性核销', () => {
  it('第一次核销拿到绑定的租户与回跳路径', async () => {
    const store = new MemoryOneTimeStore()
    const state = await issueState({ tenantId: 't1', redirectPath: '/pages/my?tab=1', store })
    expect(await consumeState(state, store)).toEqual({
      tenantId: 't1',
      redirectPath: '/pages/my?tab=1',
    })
  })

  it('**第二次核销返回 null**——重复可用就等于别人的号能被挂到攻击者的店下', async () => {
    const store = new MemoryOneTimeStore()
    const state = await issueState({ tenantId: 't1', redirectPath: '/', store })
    expect(await consumeState(state, store)).not.toBeNull()
    expect(await consumeState(state, store)).toBeNull()
    expect(await consumeState(state, store)).toBeNull()
  })

  it('核销后存储里不留残留（takeOnce 是取一次就删）', async () => {
    const store = new MemoryOneTimeStore()
    const state = await issueState({ tenantId: 't1', redirectPath: '/', store })
    expect(store.size).toBe(1)
    await consumeState(state, store)
    expect(store.size).toBe(0)
  })

  it('没见过的 state、空串、undefined 一律 null，不抛错', async () => {
    const store = new MemoryOneTimeStore()
    expect(await consumeState('从没签发过', store)).toBeNull()
    expect(await consumeState('', store)).toBeNull()
    expect(await consumeState(undefined, store)).toBeNull()
  })

  it('TTL 过期后核销返回 null，且和「已被用过」是同一个结果', async () => {
    const clock = fakeClock()
    const store = new MemoryOneTimeStore(clock.now)
    const state = await issueState({ tenantId: 't1', redirectPath: '/', store, ttlSec: 300 })
    clock.advanceSec(299)
    const alive = await issueState({ tenantId: 't1', redirectPath: '/', store, ttlSec: 300 })
    clock.advanceSec(2)
    expect(await consumeState(state, store)).toBeNull()
    // 同一时刻签发得晚的那个还活着，证明过期判定不是「全清空」
    expect(await consumeState(alive, store)).not.toBeNull()
  })

  it('存储里被人塞了非本函数写的内容时当无效，不猜不兜底', async () => {
    const store = new MemoryOneTimeStore()
    await store.put('wxoauth:state:X', '不是 JSON', 300)
    expect(await consumeState('X', store)).toBeNull()
    await store.put('wxoauth:state:Y', JSON.stringify({ tenantId: 't1' }), 300)
    expect(await consumeState('Y', store)).toBeNull()
  })
})

describe('跨租户的 state 不能用于另一个租户', () => {
  it('assertStateTenant 在租户一致时原样放行', async () => {
    const store = new MemoryOneTimeStore()
    const state = await issueState({ tenantId: 'shopA', redirectPath: '/', store })
    const payload = await consumeState(state, store)
    expect(assertStateTenant(payload!, 'shopA')).toBe(payload)
  })

  it('**拿 A 店的 state 去 B 店换登录一律拒绝**——核销成功不等于是给这家店发的', async () => {
    const store = new MemoryOneTimeStore()
    const state = await issueState({ tenantId: 'shopA', redirectPath: '/', store })
    const payload = await consumeState(state, store)
    expect(payload!.tenantId).toBe('shopA')
    const err = (() => {
      try {
        assertStateTenant(payload!, 'shopB')
      } catch (e) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(WechatOpenError)
    expect((err as WechatOpenError).code).toBe(1740300)
  })

  it('即便 B 店拒绝了，这个 state 也已经被核销掉，不能再拿回 A 店用', async () => {
    const store = new MemoryOneTimeStore()
    const state = await issueState({ tenantId: 'shopA', redirectPath: '/', store })
    await consumeState(state, store)
    expect(await consumeState(state, store)).toBeNull()
  })
})

describe('safeRedirectPath：只取 path+query', () => {
  it('正常站内路径原样保留（query 保留、hash 丢掉）', () => {
    expect(safeRedirectPath('/pages/my/index?tab=1&x=2')).toBe('/pages/my/index?tab=1&x=2')
    expect(safeRedirectPath('/a#frag')).toBe('/a')
    expect(safeRedirectPath('')).toBe('/')
    expect(safeRedirectPath(undefined)).toBe('/')
  })

  it.each([
    ['https://evil.com/x', '带 scheme 的绝对地址'],
    ['http://evil.com', '带 scheme 的绝对地址'],
    ['//evil.com', '协议相对地址'],
    ['//evil.com/path?a=1', '协议相对地址'],
    ['/\\evil.com', '反斜杠变体'],
    ['/\\/evil.com', '反斜杠变体'],
    ['evil.com/x', '不以 / 开头'],
    ['javascript:alert(1)', '伪协议'],
    ['/ok\r\nSet-Cookie: a=b', '响应头注入'],
  ])('拒绝 %s（%s）', (input) => {
    let caught: unknown
    try {
      safeRedirectPath(input)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(WechatOpenError)
    expect((caught as WechatOpenError).code).toBe(1740007)
  })
})

describe('safeHost：Host 只能是 host[:port]', () => {
  it('正常 host 通过', () => {
    expect(safeHost('know.taizan.vip')).toBe('know.taizan.vip')
    expect(safeHost('localhost:3000')).toBe('localhost:3000')
  })

  it.each(['https://know.taizan.vip', 'evil.com/x', 'evil.com@good.com', 'a b', ''])(
    '拒绝 %s',
    (host) => {
      expect(() => safeHost(host)).toThrow(WechatOpenError)
    },
  )
})

describe('buildOAuthUrl：host 一律用当前请求的 Host 重建', () => {
  const base = { appId: 'wx_biz', state: 'S1', requestHost: 'know.taizan.vip' }

  it('拼出来的 redirect_uri 的 host 就是 requestHost', () => {
    const url = new URL(buildOAuthUrl({ ...base, redirectPath: '/pages/my?tab=1' }))
    expect(url.origin + url.pathname).toBe('https://open.weixin.qq.com/connect/oauth2/authorize')
    expect(url.searchParams.get('redirect_uri')).toBe('https://know.taizan.vip/pages/my?tab=1')
    expect(url.searchParams.get('appid')).toBe('wx_biz')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe('snsapi_userinfo')
    expect(url.searchParams.get('state')).toBe('S1')
    expect(url.hash).toBe('#wechat_redirect')
  })

  it.each(['https://evil.com/x', '//evil.com', '/\\evil.com', 'http://evil.com/'])(
    '**开放重定向不可能**：redirectPath=%s 直接抛，绝不会出现在 redirect_uri 里',
    (bad) => {
      expect(() => buildOAuthUrl({ ...base, redirectPath: bad })).toThrow(WechatOpenError)
    },
  )

  it('调用方就算把整条 URL 塞进 requestHost 也没用', () => {
    expect(() =>
      buildOAuthUrl({ ...base, requestHost: 'https://evil.com', redirectPath: '/' }),
    ).toThrow(WechatOpenError)
  })

  it('无论怎么拼，redirect_uri 的 host 都不会是站外域名', () => {
    for (const p of ['/', '/a?next=https://evil.com', '/b?x=%2F%2Fevil.com']) {
      const u = new URL(buildOAuthUrl({ ...base, redirectPath: p }))
      const redirect = new URL(u.searchParams.get('redirect_uri') as string)
      expect(redirect.host).toBe('know.taizan.vip')
    }
  })

  it('第三方平台代授权时要带 component_appid，否则微信不认', () => {
    const u = new URL(buildOAuthUrl({ ...base, redirectPath: '/', componentAppId: 'wx_component' }))
    expect(u.searchParams.get('component_appid')).toBe('wx_component')
  })

  it('scope 可以降到 snsapi_base（只要 openid 的场景）', () => {
    const u = new URL(buildOAuthUrl({ ...base, redirectPath: '/', scope: 'snsapi_base' }))
    expect(u.searchParams.get('scope')).toBe('snsapi_base')
  })
})

describe('buildAuthorizeUrl：开放平台代授权页', () => {
  it('带齐 component_appid / pre_auth_code / redirect_uri / auth_type', () => {
    const u = new URL(
      buildAuthorizeUrl({
        componentAppId: 'wx_component',
        preAuthCode: 'PAC_1',
        requestHost: 'admin.taizan.vip',
        redirectPath: '/wx/authorized?from=channel',
      }),
    )
    expect(u.origin + u.pathname).toBe('https://mp.weixin.qq.com/cgi-bin/componentloginpage')
    expect(u.searchParams.get('component_appid')).toBe('wx_component')
    expect(u.searchParams.get('pre_auth_code')).toBe('PAC_1')
    expect(u.searchParams.get('redirect_uri')).toBe(
      'https://admin.taizan.vip/wx/authorized?from=channel',
    )
    expect(u.searchParams.get('auth_type')).toBe('3')
  })

  it('这里的 redirect_uri 同样只用当前 Host 重建', () => {
    expect(() =>
      buildAuthorizeUrl({
        componentAppId: 'c',
        preAuthCode: 'p',
        requestHost: 'admin.taizan.vip',
        redirectPath: '//evil.com',
      }),
    ).toThrow(WechatOpenError)
  })
})
