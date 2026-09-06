import * as crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildVodUploadSignature, signVodPlayUrl } from './vod-sign'

describe('signVodPlayUrl（官方文档示例）', () => {
  const KEY = '24FEQmTzro4V5u3D5epW'

  it('与官方文档示例的签名一致', () => {
    // 文档示例：md5("24FEQmTzro4V5u3D5epW" + "/dir1/dir2/" + "5a71afc0" + "300" + "" + "72d4cd1101")
    //          = 547d98c4b91e81b5ea55c95cef63223f
    const expected = crypto
      .createHash('md5')
      .update('24FEQmTzro4V5u3D5epW/dir1/dir2/5a71afc030072d4cd1101')
      .digest('hex')
    expect(expected).toBe('547d98c4b91e81b5ea55c95cef63223f')

    const url = signVodPlayUrl('http://example.com/dir1/dir2/myVideo.mp4', KEY, {
      expireSeconds: 60,
      previewSeconds: 300,
      now: new Date(1517400000 * 1000 - 60 * 1000), // 使 t 恰好为 5a71afc0
    })
    const u = new URL(url)
    expect(u.searchParams.get('t')).toBe('5a71afc0')
    expect(u.searchParams.get('exper')).toBe('300')

    const us = u.searchParams.get('us')!
    const recomputed = crypto
      .createHash('md5')
      .update(`${KEY}/dir1/dir2/5a71afc0300${us}`)
      .digest('hex')
    expect(u.searchParams.get('sign')).toBe(recomputed)
  })

  it('Dir 取路径中去掉文件名的部分，含首尾斜杠', () => {
    const url = signVodPlayUrl('https://x.vod-qcloud.com/a/b/c/v.mp4', KEY, { expireSeconds: 60 })
    const u = new URL(url)
    const us = u.searchParams.get('us')!
    const t = u.searchParams.get('t')!
    const expected = crypto.createHash('md5').update(`${KEY}/a/b/c/${t}${us}`).digest('hex')
    expect(u.searchParams.get('sign')).toBe(expected)
  })

  it('根目录下的文件 Dir 为单个斜杠', () => {
    const url = signVodPlayUrl('https://x.vod-qcloud.com/v.mp4', KEY, { expireSeconds: 60 })
    const u = new URL(url)
    const expected = crypto
      .createHash('md5')
      .update(`${KEY}/${u.searchParams.get('t')}${u.searchParams.get('us')}`)
      .digest('hex')
    expect(u.searchParams.get('sign')).toBe(expected)
  })

  it('t 是十六进制小写', () => {
    const url = signVodPlayUrl('https://x.com/a/v.mp4', KEY, {
      expireSeconds: 3600,
      now: new Date(1700000000 * 1000),
    })
    expect(new URL(url).searchParams.get('t')).toBe((1700000000 + 3600).toString(16))
    expect(new URL(url).searchParams.get('t')).toMatch(/^[0-9a-f]+$/)
  })

  it('不传试看与 IP 限制时，两个参数都不出现在 URL 上', () => {
    const u = new URL(signVodPlayUrl('https://x.com/a/v.mp4', KEY, { expireSeconds: 60 }))
    expect(u.searchParams.get('exper')).toBeNull()
    expect(u.searchParams.get('rlimit')).toBeNull()
  })

  it('参数顺序必须是 t、exper、rlimit、us、sign', () => {
    const url = signVodPlayUrl('https://x.com/a/v.mp4', KEY, {
      expireSeconds: 60,
      previewSeconds: 120,
      ipLimit: 3,
    })
    const query = url.split('?')[1]
    expect(query).toMatch(/^t=[^&]+&exper=120&rlimit=3&us=[^&]+&sign=[0-9a-f]{32}$/)
  })

  it('每次生成的随机串不同，签名也随之不同', () => {
    const a = signVodPlayUrl('https://x.com/a/v.mp4', KEY, { expireSeconds: 60 })
    const b = signVodPlayUrl('https://x.com/a/v.mp4', KEY, { expireSeconds: 60 })
    expect(a).not.toBe(b)
  })
})

describe('buildVodUploadSignature', () => {
  const base = { secretId: 'AKIDxxxx', secretKey: 'secretyyyy', expireSeconds: 3600 }

  it('结构为 HMAC-SHA1 原始字节 ++ original，整体 base64', () => {
    const sig = buildVodUploadSignature({ ...base, now: new Date(1700000000 * 1000) })
    const buf = Buffer.from(sig, 'base64')

    const hmacBytes = buf.subarray(0, 20)
    const original = buf.subarray(20).toString('utf8')

    expect(original).toContain('secretId=AKIDxxxx')
    expect(original).toContain('currentTimeStamp=1700000000')
    expect(original).toContain('expireTime=1700003600')

    const expected = crypto.createHmac('sha1', base.secretKey).update(original, 'utf8').digest()
    expect(hmacBytes.equals(expected)).toBe(true)
  })

  it('必选字段按 secretId、currentTimeStamp、expireTime、random 的顺序排列', () => {
    const sig = buildVodUploadSignature({ ...base, now: new Date(1700000000 * 1000) })
    const original = Buffer.from(sig, 'base64').subarray(20).toString('utf8')
    expect(original).toMatch(/^secretId=[^&]+&currentTimeStamp=\d+&expireTime=\d+&random=\d+/)
  })

  it('带子应用与任务流时追加对应参数', () => {
    const sig = buildVodUploadSignature({
      ...base,
      subAppId: 1500067142,
      procedure: 'LongVideoPreset',
    })
    const original = Buffer.from(sig, 'base64').subarray(20).toString('utf8')
    expect(original).toContain('vodSubAppId=1500067142')
    expect(original).toContain('procedure=LongVideoPreset')
  })

  it('不带子应用时不出现 vodSubAppId', () => {
    const sig = buildVodUploadSignature(base)
    const original = Buffer.from(sig, 'base64').subarray(20).toString('utf8')
    expect(original).not.toContain('vodSubAppId')
  })

  it('random 在 32 位无符号范围内', () => {
    for (let i = 0; i < 20; i++) {
      const original = Buffer.from(buildVodUploadSignature(base), 'base64')
        .subarray(20)
        .toString('utf8')
      const random = Number(/random=(\d+)/.exec(original)![1])
      expect(random).toBeGreaterThanOrEqual(0)
      expect(random).toBeLessThanOrEqual(4294967295)
    }
  })
})
