import * as crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  aliyunPercentEncode,
  aliyunRpcSignature,
  aliyunStringToSign,
  aliyunTimestamp,
  AliyunRpcSmsProvider,
  canonicalizedQuery,
  nonce,
} from './aliyun-rpc'
import type { HttpClient, HttpResponse } from '../http-client'

describe('阿里云 RPC 签名（官方样例，完全可复现）', () => {
  const OFFICIAL: Record<string, string> = {
    AccessKeyId: 'testid',
    Action: 'DescribeDedicatedHosts',
    Format: 'JSON',
    RegionId: 'cn-beijing',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: 'edb2b34af0af9a6d14deaf7c1a5315eb',
    SignatureVersion: '1.0',
    Timestamp: '2023-03-13T08:34:30Z',
    Version: '2014-05-26',
  }
  const OFFICIAL_CQS =
    'AccessKeyId=testid&Action=DescribeDedicatedHosts&Format=JSON&RegionId=cn-beijing&' +
    'SignatureMethod=HMAC-SHA1&SignatureNonce=edb2b34af0af9a6d14deaf7c1a5315eb&' +
    'SignatureVersion=1.0&Timestamp=2023-03-13T08%3A34%3A30Z&Version=2014-05-26'
  const OFFICIAL_STS =
    'GET&%2F&AccessKeyId%3Dtestid%26Action%3DDescribeDedicatedHosts%26Format%3DJSON%26' +
    'RegionId%3Dcn-beijing%26SignatureMethod%3DHMAC-SHA1%26' +
    'SignatureNonce%3Dedb2b34af0af9a6d14deaf7c1a5315eb%26SignatureVersion%3D1.0%26' +
    'Timestamp%3D2023-03-13T08%253A34%253A30Z%26Version%3D2014-05-26'
  const OFFICIAL_SIG = '9NaGiOspFP5UPcwX8Iwt2YJXXuk='

  it('规范化查询串与官方逐字一致', () => {
    expect(canonicalizedQuery(OFFICIAL)).toBe(OFFICIAL_CQS)
  })

  it('待签名串与官方逐字一致（注意 Timestamp 被编码了两次）', () => {
    expect(aliyunStringToSign(OFFICIAL, 'GET')).toBe(OFFICIAL_STS)
  })

  it('最终签名与官方样例完全一致', () => {
    expect(aliyunRpcSignature(OFFICIAL, 'testsecret', 'GET')).toBe(OFFICIAL_SIG)
  })

  it('HTTP 方法参与签名，用错就恒不通过', () => {
    expect(aliyunRpcSignature(OFFICIAL, 'testsecret', 'POST')).not.toBe(OFFICIAL_SIG)
  })

  it('参数顺序无关——内部会先按 key 排序', () => {
    const shuffled: Record<string, string> = {}
    for (const k of Object.keys(OFFICIAL).reverse()) shuffled[k] = OFFICIAL[k]!
    expect(aliyunRpcSignature(shuffled, 'testsecret', 'GET')).toBe(OFFICIAL_SIG)
  })

  it('密钥末尾要加 &——不是笔误，是阿里云的规定', () => {
    const without = crypto
      .createHmac('sha1', 'testsecret')
      .update(aliyunStringToSign(OFFICIAL, 'GET'))
      .digest('base64')
    expect(without).not.toBe(OFFICIAL_SIG)
  })
})

describe('阿里云百分号编码', () => {
  it('三处特例都要改，否则带空格或星号的短信签不过', () => {
    expect(aliyunPercentEncode('a b')).toBe('a%20b')
    expect(aliyunPercentEncode('a*b')).toBe('a%2Ab')
    expect(aliyunPercentEncode('a~b')).toBe('a~b')
  })

  it('冒号要编码——时间戳里就有，这一处错了签名就废', () => {
    expect(aliyunPercentEncode('2023-03-13T08:34:30Z')).toBe('2023-03-13T08%3A34%3A30Z')
  })
})

describe('辅助函数', () => {
  it('时间戳是 ISO8601 UTC 且带 Z', () => {
    expect(aliyunTimestamp(new Date('2016-02-23T12:46:24.123Z'))).toBe('2016-02-23T12:46:24Z')
  })

  it('随机串每次都不同', () => {
    expect(nonce()).not.toBe(nonce())
    expect(nonce()).toHaveLength(32)
  })
})

function fakeHttp(handler: (body: string) => HttpResponse): HttpClient {
  return { post: async (_url, body) => handler(body) }
}

describe('AliyunRpcSmsProvider', () => {
  const cfg = {
    accessKeyId: 'ak',
    accessKeySecret: 'sk',
    signName: '泰赞',
    templates: { 'sms.login-code': { providerTemplateId: 'SMS_001', paramOrder: ['code'] } },
  }

  it('Code === "OK" 才算成功', async () => {
    const http = fakeHttp(() => ({
      status: 200,
      body: JSON.stringify({ Code: 'OK', BizId: 'biz-1', RequestId: 'r1' }),
    }))
    const provider = new AliyunRpcSmsProvider(http)
    const result = await provider.send(
      { phone: '13800000000', templateKey: 'sms.login-code', params: { code: '1234' } },
      cfg,
    )
    expect(result.ok).toBe(true)
    expect(result.vendorRef).toBe('biz-1')
  })

  it('非 OK 的 Code 算失败', async () => {
    const http = fakeHttp(() => ({
      status: 200,
      body: JSON.stringify({ Code: 'isv.BUSINESS_LIMIT_CONTROL', Message: '触发流控' }),
    }))
    const provider = new AliyunRpcSmsProvider(http)
    const result = await provider.send(
      { phone: '13800000000', templateKey: 'sms.login-code', params: { code: '1234' } },
      cfg,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('触发流控')
  })

  it('网络异常归一成失败返回值', async () => {
    const provider = new AliyunRpcSmsProvider({
      post: async () => {
        throw new Error('timeout')
      },
    })
    const result = await provider.send(
      { phone: '13800000000', templateKey: 'sms.login-code', params: { code: '1234' } },
      cfg,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('timeout')
  })
})
