/**
 * 四级来源优先级。纯函数，用例就是一张真值表。
 *
 * 这套判定分叉时不会报错，表现是「渠道页显示用平台的号、学员却登不进来」，
 * 所以每一档、每一种「有但不可用」都要有一条用例。
 */

import { describe, expect, it } from 'vitest'
import {
  MP_SOURCE_PRIORITY,
  canIssueAccessToken,
  explainNoMpSource,
  mpUnavailableMessage,
  resolveMpSource,
} from './mp-source'
import type { MpSource } from './types'

const tenantOwn: MpSource = {
  kind: 'TENANT_OWN',
  appId: 'wx_tenant_own',
  appSecret: 'own_secret',
  tenantId: 't1',
}
const tenantAuthorized: MpSource = {
  kind: 'TENANT_AUTHORIZED',
  appId: 'wx_tenant_auth',
  appSecret: null,
  authorizerRefreshToken: 'ART_1',
  tenantId: 't1',
}
const platformAuthorized: MpSource = {
  kind: 'PLATFORM_AUTHORIZED',
  appId: 'wx_platform_auth',
  appSecret: null,
  authorizerRefreshToken: 'ART_P',
}
const platformOwn: MpSource = {
  kind: 'PLATFORM_OWN',
  appId: 'wx_platform_own',
  appSecret: 'platform_secret',
  enabled: true,
}

const ALL = [platformOwn, platformAuthorized, tenantAuthorized, tenantOwn]

describe('四级优先级', () => {
  it('优先级表就是蓝图里那四级，顺序不能改', () => {
    expect(MP_SOURCE_PRIORITY).toEqual([
      'TENANT_OWN',
      'TENANT_AUTHORIZED',
      'PLATFORM_AUTHORIZED',
      'PLATFORM_OWN',
    ])
  })

  it('四条都在时用租户自有号——商家自己填了密钥是最明确的表态', () => {
    // 候选顺序刻意打乱，证明选的是优先级不是数组顺序
    expect(resolveMpSource(ALL)?.kind).toBe('TENANT_OWN')
  })

  it('没有自有号时用租户授权给平台的号', () => {
    expect(resolveMpSource([platformOwn, platformAuthorized, tenantAuthorized])?.kind).toBe(
      'TENANT_AUTHORIZED',
    )
  })

  it('租户两条都没有时用平台代运营的号', () => {
    expect(resolveMpSource([platformOwn, platformAuthorized])?.kind).toBe('PLATFORM_AUTHORIZED')
  })

  it('最后才轮到平台自有号', () => {
    expect(resolveMpSource([platformOwn])?.appId).toBe('wx_platform_own')
  })

  it('**全空时返回 null**，不是随便挑一个', () => {
    expect(resolveMpSource([])).toBeNull()
  })
})

describe('「有这条但不可用」的几种情况', () => {
  it('自有号缺 appSecret 不算数——空密钥发出去只会换回一句 invalid appsecret', () => {
    const broken: MpSource = { kind: 'TENANT_OWN', appId: 'wx_x', appSecret: '' }
    expect(resolveMpSource([broken, tenantAuthorized])?.kind).toBe('TENANT_AUTHORIZED')
  })

  it('缺 appId 的候选一律跳过', () => {
    expect(resolveMpSource([{ kind: 'TENANT_OWN', appId: '', appSecret: 's' }])).toBeNull()
  })

  it('平台自有号的闸门关着时跳过它，而不是「反正有就用」', () => {
    expect(resolveMpSource([{ ...platformOwn, enabled: false }])).toBeNull()
  })

  it('enabled 不传时视为可用（自有 / 授权类天然可用）', () => {
    expect(resolveMpSource([{ kind: 'TENANT_OWN', appId: 'wx_a', appSecret: 's' }])?.appId).toBe(
      'wx_a',
    )
  })

  it('授权类不需要 appSecret——那条路上本来就没有', () => {
    expect(resolveMpSource([tenantAuthorized])?.kind).toBe('TENANT_AUTHORIZED')
  })

  it('同一档有多条时取第一条，顺序由调用方决定', () => {
    const a = { ...tenantAuthorized, appId: 'wx_first' }
    const b = { ...tenantAuthorized, appId: 'wx_second' }
    expect(resolveMpSource([a, b])?.appId).toBe('wx_first')
  })
})

describe('挑不出来时说清该谁去做事', () => {
  it('一条都没配 → NOT_CONFIGURED', () => {
    expect(explainNoMpSource([])).toBe('NOT_CONFIGURED')
  })

  it('只剩平台自有号但没开通 → PLATFORM_NOT_PERMITTED（该做事的人在平台那一侧）', () => {
    expect(explainNoMpSource([{ ...platformOwn, enabled: false }])).toBe('PLATFORM_NOT_PERMITTED')
  })

  it('平台自有号本身就没配（没有 appSecret）时仍是 NOT_CONFIGURED', () => {
    expect(explainNoMpSource([{ kind: 'PLATFORM_OWN', appId: 'wx_p', enabled: false }])).toBe(
      'NOT_CONFIGURED',
    )
  })

  it('两句话分得清是找商家还是找平台', () => {
    expect(mpUnavailableMessage('PLATFORM_NOT_PERMITTED')).toContain('联系平台')
    expect(mpUnavailableMessage('NOT_CONFIGURED')).toBe('尚未配置微信公众号，无法完成微信登录')
  })
})

describe('能不能拿 access_token（模板消息 / JS-SDK 要用）', () => {
  it('中转站那条路只做登录，**必须先排除**', () => {
    const relay: MpSource = {
      kind: 'TENANT_OWN',
      appId: 'wx_relay',
      appSecret: 's',
      relay: { clientId: 'cli_0123456789abcdef', clientSecret: 'x' },
    }
    expect(canIssueAccessToken(relay)).toBe(false)
  })

  it('自有号有密钥就能，授权类有 refresh_token 就能', () => {
    expect(canIssueAccessToken(tenantOwn)).toBe(true)
    expect(canIssueAccessToken(platformOwn)).toBe(true)
    expect(canIssueAccessToken(tenantAuthorized)).toBe(true)
    expect(canIssueAccessToken(platformAuthorized)).toBe(true)
  })

  it('授权类缺 refresh_token 就不能——那时只能让商家重新授权', () => {
    expect(canIssueAccessToken({ ...tenantAuthorized, authorizerRefreshToken: null })).toBe(false)
  })
})
