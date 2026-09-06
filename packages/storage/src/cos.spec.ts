import * as crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { cosAuthorization, cosPercentEncode, CosStorageProvider } from './cos'
import type { HttpClient, HttpResponse } from './http-client'

/**
 * 对照腾讯云官方文档「请求签名」(https://cloud.tencent.com/document/product/436/7778)
 * 公布的两个示例。
 *
 * 文档把 SecretId/SecretKey 都打了码（示例里干脆写"xxxxx"），所以最终 Signature
 * **是复现不出来的**——跟 TC3 的情况一样。但 HttpString 与 StringToSign 的每个
 * 输入（method/path/params/headers/KeyTime）文档都完整给出了，逐字节比对这两个
 * 才是真的在对照官方数据；断言一个记不准的最终数字只会得到一个假的"验过了"。
 */
describe('COS 签名 v5（官方文档两个示例）', () => {
  it('示例一（PUT）：HttpString 与 StringToSign 逐字节一致', () => {
    const r = cosAuthorization({
      secretId: 'x',
      secretKey: 'y',
      method: 'put',
      pathname: '/exampleobject(腾讯云)',
      headers: {
        'content-length': '13',
        'content-md5': 'mQ/fVh815F3k6TAUm8m0eg==',
        'content-type': 'text/plain',
        date: 'Thu, 16 May 2019 06:45:51 GMT',
        host: 'examplebucket-1250000000.cos.ap-beijing.myqcloud.com',
        'x-cos-acl': 'private',
        'x-cos-grant-read': 'uin="100000000011"',
      },
      startTimestamp: 1557989151,
      endTimestamp: 1557996351,
    })

    expect(r.httpString).toBe(
      'put\n/exampleobject(腾讯云)\n\n' +
        'content-length=13&content-md5=mQ%2FfVh815F3k6TAUm8m0eg%3D%3D&content-type=text%2Fplain&' +
        'date=Thu%2C%2016%20May%202019%2006%3A45%3A51%20GMT&' +
        'host=examplebucket-1250000000.cos.ap-beijing.myqcloud.com&x-cos-acl=private&' +
        'x-cos-grant-read=uin%3D%22100000000011%22\n',
    )
    expect(r.keyTime).toBe('1557989151;1557996351')
    // 官方文档公布的 sha1(HttpString) 值，独立复算应逐字一致
    expect(crypto.createHash('sha1').update(r.httpString, 'utf8').digest('hex')).toBe(
      '8b2751e77f43a0995d6e9eb9477f4b685cca4172',
    )
    expect(r.stringToSign).toBe(
      'sha1\n1557989151;1557996351\n8b2751e77f43a0995d6e9eb9477f4b685cca4172\n',
    )
  })

  it('示例二（GET，带 query）：HttpString 与 StringToSign 逐字节一致', () => {
    const r = cosAuthorization({
      secretId: 'x',
      secretKey: 'y',
      method: 'get',
      pathname: '/exampleobject(腾讯云)',
      params: {
        'response-cache-control': 'max-age=600',
        'response-content-type': 'application/octet-stream',
      },
      headers: {
        date: 'Thu, 16 May 2019 06:55:53 GMT',
        host: 'examplebucket-1250000000.cos.ap-beijing.myqcloud.com',
      },
      startTimestamp: 1557989753,
      endTimestamp: 1557996953,
    })

    expect(r.httpString).toBe(
      'get\n/exampleobject(腾讯云)\n' +
        'response-cache-control=max-age%3D600&response-content-type=application%2Foctet-stream\n' +
        'date=Thu%2C%2016%20May%202019%2006%3A55%3A53%20GMT&' +
        'host=examplebucket-1250000000.cos.ap-beijing.myqcloud.com\n',
    )
    expect(crypto.createHash('sha1').update(r.httpString, 'utf8').digest('hex')).toBe(
      '54ecfe22f59d3514fdc764b87a32d8133ea611e6',
    )
  })

  it('改一个字节签名就变——证明它真的参与了计算', () => {
    const base = cosAuthorization({
      secretId: 'x',
      secretKey: 'y',
      method: 'put',
      pathname: '/a.jpg',
      headers: { host: 'h' },
      startTimestamp: 1,
      endTimestamp: 2,
    }).signature
    const changed = cosAuthorization({
      secretId: 'x',
      secretKey: 'y',
      method: 'put',
      pathname: '/a.jpg',
      headers: { host: 'h2' },
      startTimestamp: 1,
      endTimestamp: 2,
    }).signature
    expect(changed).not.toBe(base)
  })

  it('header/param 的 key 参与签名前会被转成小写', () => {
    const lower = cosAuthorization({
      secretId: 'x',
      secretKey: 'y',
      method: 'get',
      pathname: '/a',
      headers: { host: 'h' },
      startTimestamp: 1,
      endTimestamp: 2,
    })
    const upper = cosAuthorization({
      secretId: 'x',
      secretKey: 'y',
      method: 'get',
      pathname: '/a',
      headers: { Host: 'h' },
      startTimestamp: 1,
      endTimestamp: 2,
    })
    expect(lower.signature).toBe(upper.signature)
  })
})

describe('cosPercentEncode', () => {
  it("比 encodeURIComponent 更严格：额外编码 ! * ' ( )", () => {
    expect(cosPercentEncode("a!b*c'd(e)f")).toBe('a%21b%2Ac%27d%28e%29f')
  })

  it('常规字符按 encodeURIComponent 处理', () => {
    expect(cosPercentEncode('a=b&c')).toBe('a%3Db%26c')
    expect(cosPercentEncode('中文')).toBe('%E4%B8%AD%E6%96%87')
  })
})

function fakeHttp(handler: (method: string, url: string) => HttpResponse): HttpClient {
  return { request: async (method, url) => handler(method, url) }
}

describe('CosStorageProvider', () => {
  const cfg = { secretId: 'id', secretKey: 'key', bucket: 'b', region: 'ap-guangzhou' }

  it('getPublicUrl 优先用 cdnDomain，其次源站域名', () => {
    const provider = new CosStorageProvider(fakeHttp(() => ({ status: 200, body: '' })))
    expect(provider.getPublicUrl('t/a/b.jpg', cfg)).toBe(
      'https://b.cos.ap-guangzhou.myqcloud.com/t/a/b.jpg',
    )
    expect(
      provider.getPublicUrl('t/a/b.jpg', { ...cfg, cdnDomain: 'https://cdn.example.com' }),
    ).toBe('https://cdn.example.com/t/a/b.jpg')
  })

  it('presignGet 只用源站域名，不用 CDN 域名——CDN 验不过这个签名', () => {
    const provider = new CosStorageProvider(fakeHttp(() => ({ status: 200, body: '' })))
    const url = provider.presignGet(
      't/a/b.mp3',
      { expireSeconds: 3600 },
      {
        ...cfg,
        cdnDomain: 'https://cdn.example.com',
      },
    )
    expect(url.startsWith('https://b.cos.ap-guangzhou.myqcloud.com/')).toBe(true)
    expect(url).toContain('q-sign-algorithm=sha1')
    expect(url).toContain('q-signature=')
  })

  it('presignGet 的过期时间越界时抛错（复用 presign.ts 的边界校验）', () => {
    const provider = new CosStorageProvider(fakeHttp(() => ({ status: 200, body: '' })))
    expect(() => provider.presignGet('t/a/b.mp3', { expireSeconds: 1 }, cfg)).toThrow('太短')
    expect(() => provider.presignGet('t/a/b.mp3', { expireSeconds: 999_999_999 }, cfg)).toThrow(
      '太长',
    )
  })

  it('presignPut 返回 PUT 方法与 Content-Type 头，供前端直传', () => {
    const provider = new CosStorageProvider(fakeHttp(() => ({ status: 200, body: '' })))
    const result = provider.presignPut('t/a/b.jpg', { expireSeconds: 600 }, cfg)
    expect(result.method).toBe('PUT')
    expect(result.headers['Content-Type']).toBe('image/jpeg')
    expect(result.url).toContain('q-signature=')
  })

  it('putObject 把 ACL 与签名一起发给注入的 HttpClient', async () => {
    let seenHeaders: Record<string, string> | undefined
    const provider = new CosStorageProvider({
      request: async (method, url, _body, headers) => {
        seenHeaders = headers
        expect(method).toBe('PUT')
        expect(url).toContain('t/a/b.jpg')
        return { status: 200, body: '', headers: { etag: '"abc"' } }
      },
    })
    const result = await provider.putObject(
      { key: 't/a/b.jpg', body: Buffer.from('x'), ext: '.jpg', public: true },
      cfg,
    )
    expect(result.etag).toBe('"abc"')
    expect(seenHeaders?.['x-cos-acl']).toBe('public-read')
    expect(seenHeaders?.Authorization).toContain('q-sign-algorithm=sha1')
  })

  it('putObject 非 2xx 时抛错', async () => {
    const provider = new CosStorageProvider(fakeHttp(() => ({ status: 403, body: 'denied' })))
    await expect(
      provider.putObject(
        { key: 't/a/b.jpg', body: Buffer.from('x'), ext: '.jpg', public: false },
        cfg,
      ),
    ).rejects.toThrow('HTTP 403')
  })

  it('deleteObject 把 404 当成"已经不存在"，不抛错', async () => {
    const provider = new CosStorageProvider(fakeHttp(() => ({ status: 404, body: '' })))
    await expect(provider.deleteObject('t/a/b.jpg', cfg)).resolves.toBeUndefined()
  })

  it('deleteObject 真正的错误状态码会抛', async () => {
    const provider = new CosStorageProvider(fakeHttp(() => ({ status: 500, body: '' })))
    await expect(provider.deleteObject('t/a/b.jpg', cfg)).rejects.toThrow('HTTP 500')
  })
})
