import * as crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { tc3Authorization, TencentTc3SmsProvider } from './tencent-tc3'
import type { HttpClient, HttpResponse } from '../http-client'

/**
 * 对照官方文档「签名方法 v3」的样例。自己签自己验测不出错——把日期取成本地
 * 时区、把 header 顺序写反、少编码一次，往返都自洽，只有真发给云厂商才会
 * 失败，而那时报错只有一句「签名验证失败」，指不出是哪一处。
 */
describe('腾讯云 TC3 签名（官方样例）', () => {
  const OFFICIAL = {
    secretId: 'AKIDz8krbsJ5yKBZQpn74WFkmLPx3EXAMPLE',
    secretKey: 'Gu5t9xGARNpq86cd98joQYCN3EXAMPLE',
    service: 'cvm',
    host: 'cvm.tencentcloudapi.com',
    action: 'DescribeInstances',
    version: '2017-03-12',
    // \u 必须是反斜杠加 u 两个字符，不是解码后的中文——文档给的就是转义写法
    payload:
      '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}',
    timestamp: 1551113065,
  }
  const OFFICIAL_PAYLOAD_HASH = '35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064'
  const OFFICIAL_CR_HASH = '7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84'

  const sha256hex = (s: string): string => crypto.createHash('sha256').update(s).digest('hex')

  it('请求体的哈希与官方一致（转义写法，不是解码后的中文）', () => {
    expect(sha256hex(OFFICIAL.payload)).toBe(OFFICIAL_PAYLOAD_HASH)
  })

  it('CanonicalRequest 的哈希与官方一致', () => {
    const { canonicalRequest } = tc3Authorization(OFFICIAL)
    expect(sha256hex(canonicalRequest)).toBe(OFFICIAL_CR_HASH)
  })

  it('StringToSign 与官方公布的四行逐字一致', () => {
    const { stringToSign } = tc3Authorization(OFFICIAL)
    expect(stringToSign).toBe(
      ['TC3-HMAC-SHA256', '1551113065', '2019-02-25/cvm/tc3_request', OFFICIAL_CR_HASH].join('\n'),
    )
  })

  it('Credential 里的日期取 UTC，不是本地时区', () => {
    // 1551113065 = 2019-02-25T18:04:25Z；东八区已是 26 日。
    // 取本地时区会在每天有 8 小时签不对，而那 8 小时里的报错和平时一模一样。
    expect(tc3Authorization(OFFICIAL).authorization).toContain(
      `Credential=${OFFICIAL.secretId}/2019-02-25/cvm/tc3_request`,
    )
  })

  it('SignedHeaders 是固定的三个，小写有序', () => {
    expect(tc3Authorization(OFFICIAL).authorization).toContain(
      'SignedHeaders=content-type;host;x-tc-action',
    )
  })

  it('CanonicalHeaders 每行都以换行结尾，且 action 小写', () => {
    const { canonicalRequest } = tc3Authorization(OFFICIAL)
    expect(canonicalRequest).toContain('x-tc-action:describeinstances\n')
    expect(canonicalRequest).toContain('content-type:application/json; charset=utf-8\n')
  })

  it('改一个字节签名就变——证明它真的参与了计算', () => {
    const base = tc3Authorization(OFFICIAL).authorization
    expect(tc3Authorization({ ...OFFICIAL, payload: '{}' }).authorization).not.toBe(base)
    expect(
      tc3Authorization({ ...OFFICIAL, timestamp: OFFICIAL.timestamp + 1 }).authorization,
    ).not.toBe(base)
    expect(tc3Authorization({ ...OFFICIAL, action: 'SendSms' }).authorization).not.toBe(base)
    expect(tc3Authorization({ ...OFFICIAL, secretKey: 'other' }).authorization).not.toBe(base)
  })
})

function fakeHttp(
  handler: (url: string, body: string, headers: Record<string, string>) => HttpResponse,
): HttpClient {
  return {
    post: async (url, body, headers) => handler(url, body, headers),
  }
}

describe('TencentTc3SmsProvider', () => {
  const cfg = {
    secretId: 'id',
    secretKey: 'key',
    sdkAppId: '140000000',
    signName: '泰赞',
    templates: { 'sms.login-code': { providerTemplateId: '123456', paramOrder: ['code'] } },
  }

  it('逐号码状态 Ok 才算成功', async () => {
    const http = fakeHttp(() => ({
      status: 200,
      body: JSON.stringify({
        Response: { SendStatusSet: [{ Code: 'Ok', SerialNo: 'abc' }], RequestId: 'r1' },
      }),
    }))
    const provider = new TencentTc3SmsProvider(http)
    const result = await provider.send(
      { phone: '13800000000', templateKey: 'sms.login-code', params: { code: '1234' } },
      cfg,
    )
    expect(result.ok).toBe(true)
    expect(result.vendorRef).toBe('abc')
  })

  it('整体 200 但逐号码状态非 Ok 时算失败', async () => {
    const http = fakeHttp(() => ({
      status: 200,
      body: JSON.stringify({
        Response: { SendStatusSet: [{ Code: 'LimitExceeded.PhoneNumberDaily', Message: '超限' }] },
      }),
    }))
    const provider = new TencentTc3SmsProvider(http)
    const result = await provider.send(
      { phone: '13800000000', templateKey: 'sms.login-code', params: { code: '1234' } },
      cfg,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('超限')
  })

  it('网络异常归一成失败返回值，不抛出去', async () => {
    const provider = new TencentTc3SmsProvider({
      post: async () => {
        throw new Error('ECONNRESET')
      },
    })
    const result = await provider.send(
      { phone: '13800000000', templateKey: 'sms.login-code', params: { code: '1234' } },
      cfg,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('ECONNRESET')
  })

  it('模板参数缺失时抛错，不发出去残缺内容', async () => {
    const provider = new TencentTc3SmsProvider(fakeHttp(() => ({ status: 200, body: '{}' })))
    await expect(
      provider.send({ phone: '13800000000', templateKey: 'sms.login-code', params: {} }, cfg),
    ).rejects.toThrow('模板参数缺失')
  })
})
