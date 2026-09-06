/**
 * 官方文档给出的加解密样例，逐字节比对（搬自 knowledge `infra/wechat-open/msg-crypt.spec.ts`）。
 *
 * 自己加密再自己解密是**测不出错的**——把 IV 取错、把长度写成小端、把填充块长写成 16，
 * 往返都自洽，只有真的对上微信才会失败。所以这里必须有一条用官方密文的用例，
 * 它是唯一能提前暴露这些错误的。
 */

import { describe, expect, it } from 'vitest'
import {
  aesKeyOf,
  assertMsgSignature,
  buildEncryptedReply,
  decryptMsg,
  encryptMsg,
  openMsg,
  signMatches,
  signMsg,
  xmlField,
} from './msg-crypt'
import { WechatOpenError } from './errors'

const OFFICIAL = {
  token: 'QDG6eK',
  receiveId: 'wx5823bf96d3bd56c7',
  aesKey: 'jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C',
  timestamp: '1409659813',
  nonce: '1372623149',
  signature: '477715d11cdb4164915debcba66cb864d751f3e6',
  encrypt:
    'RypEvHKD8QQKFhvQ6QleEB4J58tiPdvo+rtK1I9qca6aM/wvqnLSV5zEPeusUiX5L5X/0lWfrf0QADHHhGd3QczcdCUpj911L3vg3W/sYYvuJTs3TUUkSUXxaccAS0qhxchrRYt66wiSpGLYL42aM6A8dTT+6k4aSknmPj48kzJs8qLjvd4Xgpue06DOdnLxAUHzM6+kDZ+HMZfJYuR+LtwGc2hgf5gsijff0ekUNXZiqATP7PF5mZxZ3Izoun1s4zG4LUMnvw2r+KqCKIw+3IQH03v+BCA9nMELNqbSf6tiWSrXJB3LAVGUcallcrw8V2t9EL4EhzJWrQUax5wLVMNS0+rUPA3k22Ncx4XXZS9o0MBH27Bo6BpNelZpS+/uh9KsNlY6bHCmJU9p8g7m3fVKn28H3KDYA5Pl/T8Z1ptDAVe0lXdQ2YoyyH2uyPIGHBZZIs2pDBS8R07+qN+E7Q==',
}

const CONFIG = { appId: OFFICIAL.receiveId, token: OFFICIAL.token, aesKey: OFFICIAL.aesKey }

describe('EncodingAESKey 解析', () => {
  it('43 位 base64 补一个等号后是 32 字节密钥，IV 取前 16 字节', () => {
    const { key, iv } = aesKeyOf(OFFICIAL.aesKey)
    expect(key.length).toBe(32)
    expect(iv.length).toBe(16)
    expect(iv.equals(key.subarray(0, 16))).toBe(true)
  })

  it('长度不对时直接报错，而不是解出乱码', () => {
    expect(() => aesKeyOf('太短了')).toThrow(/43 位/)
  })
})

describe('消息签名', () => {
  it('与官方样例逐字符一致', () => {
    expect(signMsg(OFFICIAL.token, OFFICIAL.timestamp, OFFICIAL.nonce, OFFICIAL.encrypt)).toBe(
      OFFICIAL.signature,
    )
  })

  it('四个参数是**排序后**拼接，换个顺序算出来必须一样', () => {
    // 交换 timestamp 与 nonce 的传参位置，结果不变才说明确实排了序
    expect(signMsg(OFFICIAL.token, OFFICIAL.nonce, OFFICIAL.timestamp, OFFICIAL.encrypt)).toBe(
      OFFICIAL.signature,
    )
  })

  it('密文改一个字符，签名就对不上', () => {
    const tampered = `A${OFFICIAL.encrypt.slice(1)}`
    expect(signMsg(OFFICIAL.token, OFFICIAL.timestamp, OFFICIAL.nonce, tampered)).not.toBe(
      OFFICIAL.signature,
    )
  })

  it('比对是定长的，长度不同直接 false 而不抛错', () => {
    expect(signMatches(OFFICIAL.signature, OFFICIAL.signature)).toBe(true)
    expect(signMatches(OFFICIAL.signature, 'short')).toBe(false)
    expect(signMatches(OFFICIAL.signature, undefined)).toBe(false)
  })
})

describe('解密', () => {
  it('官方密文能解出官方明文', () => {
    const { message } = decryptMsg(OFFICIAL.aesKey, OFFICIAL.encrypt, OFFICIAL.receiveId)
    expect(message).toContain('<Content><![CDATA[hello]]></Content>')
    expect(xmlField(message, 'FromUserName')).toBe('mycreate')
    expect(xmlField(message, 'CreateTime')).toBe(OFFICIAL.timestamp)
  })

  it('receiveId 不符时拒绝处理——只解密不比对等于收别人家的报文', () => {
    expect(() => decryptMsg(OFFICIAL.aesKey, OFFICIAL.encrypt, 'wx0000000000000000')).toThrow(
      /不符/,
    )
  })

  it('用错的 AESKey 解会报错，不会静默返回乱码', () => {
    const wrong = 'a'.repeat(43)
    expect(() => decryptMsg(wrong, OFFICIAL.encrypt, OFFICIAL.receiveId)).toThrow()
  })
})

describe('加密（全网发布检测要用）', () => {
  it('加密后能自己解回来', () => {
    const msg = '<xml><Content><![CDATA[测试回复]]></Content></xml>'
    const enc = encryptMsg(OFFICIAL.aesKey, msg, OFFICIAL.receiveId)
    expect(decryptMsg(OFFICIAL.aesKey, enc, OFFICIAL.receiveId).message).toBe(msg)
  })

  it('内容长度正好是 32 的倍数时也不会被截断', () => {
    // 填充必须再补一整块，少补就会把真实内容当填充切掉
    for (let n = 1; n <= 64; n++) {
      const msg = 'x'.repeat(n)
      const enc = encryptMsg(OFFICIAL.aesKey, msg, OFFICIAL.receiveId)
      expect(decryptMsg(OFFICIAL.aesKey, enc, OFFICIAL.receiveId).message, `长度 ${n}`).toBe(msg)
    }
  })

  it('中文按 utf8 字节数算长度，不是字符数', () => {
    const msg = '一二三四五'
    const enc = encryptMsg(OFFICIAL.aesKey, msg, OFFICIAL.receiveId)
    expect(decryptMsg(OFFICIAL.aesKey, enc, OFFICIAL.receiveId).message).toBe(msg)
  })

  it('每次加密的密文都不同（前 16 字节是随机数），但解出来一样', () => {
    const a = encryptMsg(OFFICIAL.aesKey, 'same', OFFICIAL.receiveId)
    const b = encryptMsg(OFFICIAL.aesKey, 'same', OFFICIAL.receiveId)
    expect(a).not.toBe(b)
    expect(decryptMsg(OFFICIAL.aesKey, a, OFFICIAL.receiveId).message).toBe('same')
  })

  it('回复报文自带的签名能被同一套算法验过', () => {
    const xml = buildEncryptedReply({
      aesKey: OFFICIAL.aesKey,
      token: OFFICIAL.token,
      message: 'success',
      receiveId: OFFICIAL.receiveId,
      timestamp: OFFICIAL.timestamp,
      nonce: OFFICIAL.nonce,
    })
    const encrypt = xmlField(xml, 'Encrypt')
    const sign = xmlField(xml, 'MsgSignature')
    expect(encrypt).toBeTruthy()
    expect(signMsg(OFFICIAL.token, OFFICIAL.timestamp, OFFICIAL.nonce, encrypt as string)).toBe(
      sign,
    )
  })
})

describe('篡改签名一律拒绝', () => {
  const base = {
    token: OFFICIAL.token,
    timestamp: OFFICIAL.timestamp,
    nonce: OFFICIAL.nonce,
    encrypt: OFFICIAL.encrypt,
  }

  it('官方样例的签名验得过', () => {
    expect(() => assertMsgSignature({ ...base, msgSignature: OFFICIAL.signature })).not.toThrow()
  })

  it('签名改一个字符就拒绝', () => {
    const tampered = `0${OFFICIAL.signature.slice(1)}`
    expect(() => assertMsgSignature({ ...base, msgSignature: tampered })).toThrow(WechatOpenError)
  })

  it('密文被改过（签名还是原来那个）也拒绝——这正是签名要挡的攻击', () => {
    const tamperedCipher = `A${OFFICIAL.encrypt.slice(1)}`
    expect(() =>
      assertMsgSignature({ ...base, encrypt: tamperedCipher, msgSignature: OFFICIAL.signature }),
    ).toThrow(/签名校验失败/)
  })

  it('timestamp / nonce 被改过也拒绝', () => {
    expect(() =>
      assertMsgSignature({ ...base, timestamp: '1409659814', msgSignature: OFFICIAL.signature }),
    ).toThrow(WechatOpenError)
    expect(() =>
      assertMsgSignature({ ...base, nonce: 'x', msgSignature: OFFICIAL.signature }),
    ).toThrow(WechatOpenError)
  })

  it('空签名不是「跳过校验」', () => {
    expect(() => assertMsgSignature({ ...base, msgSignature: '' })).toThrow(WechatOpenError)
  })
})

describe('openMsg：验签 + 解密 + 校验 receiveId 一步到位', () => {
  it('官方样例走得通', () => {
    const xml = openMsg({
      config: CONFIG,
      encrypt: OFFICIAL.encrypt,
      msgSignature: OFFICIAL.signature,
      timestamp: OFFICIAL.timestamp,
      nonce: OFFICIAL.nonce,
    })
    expect(xmlField(xml, 'FromUserName')).toBe('mycreate')
  })

  it('**先验签再解密**：签名不对时连解密都不该发生', () => {
    // 用官方密文 + 错签名。如果实现是「先解密后验签」，这里会解出明文再报错，
    // 表现一样但攻击面不同——所以断言错误码是签名类而不是解密类
    let caught: unknown
    try {
      openMsg({
        config: CONFIG,
        encrypt: OFFICIAL.encrypt,
        msgSignature: 'deadbeef',
        timestamp: OFFICIAL.timestamp,
        nonce: OFFICIAL.nonce,
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(WechatOpenError)
    expect((caught as WechatOpenError).code).toBe(1740006)
  })
})

describe('取 XML 字段', () => {
  const xml =
    '<xml><AppId><![CDATA[wx123]]></AppId><CreateTime>1700000000</CreateTime>' +
    '<InfoType><![CDATA[component_verify_ticket]]></InfoType>' +
    '<ComponentVerifyTicket><![CDATA[ticket@@@abc]]></ComponentVerifyTicket></xml>'

  it('CDATA 包着的与裸值都能取到', () => {
    expect(xmlField(xml, 'AppId')).toBe('wx123')
    expect(xmlField(xml, 'CreateTime')).toBe('1700000000')
    expect(xmlField(xml, 'ComponentVerifyTicket')).toBe('ticket@@@abc')
  })

  it('取不到就是 null，不是空串——调用方要能区分「没这个字段」和「字段是空的」', () => {
    expect(xmlField(xml, 'NotExist')).toBeNull()
  })

  it('不会把相似标签名认错（AppId 不该匹配到 AuthorizerAppid）', () => {
    const x = '<xml><AuthorizerAppid><![CDATA[wx999]]></AuthorizerAppid></xml>'
    expect(xmlField(x, 'AppId')).toBeNull()
  })
})
