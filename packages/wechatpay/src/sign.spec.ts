import * as crypto from 'node:crypto'

import { beforeAll, describe, expect, it } from 'vitest'

import {
  SIGNATURE_MAX_SKEW_SECONDS,
  buildAuthorization,
  buildSignMessage,
  generateNonce,
  isTimestampFresh,
  rsaSha256Sign,
  rsaSha256Verify,
  selectVerifyPem,
  signJsapi,
  verifyResponseSignature,
} from './sign'
import type { WechatPayCredentials } from './types'

/** 自签一对 RSA 密钥当作「微信的」和「商户的」，验证签名链路自洽（搬自 knowledge v3-sign.spec.ts）。 */
let priv: string
let pub: string

beforeAll(() => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  pub = publicKey.export({ type: 'spki', format: 'pem' }).toString()
})

describe('buildSignMessage：官方文档样例逐字节比对', () => {
  /**
   * 微信支付 V3「签名生成」文档给的样例就是下面这一组（GET /v3/certificates）。
   * **这条断言是整个包的地基**：待签名串错一个字节，所有接口都是 401 SIGN_ERROR，
   * 而错误信息不会告诉你是哪一段拼错了。
   */
  it('官方样例：GET /v3/certificates 的待签名串一字节不差', () => {
    expect(
      buildSignMessage({
        method: 'GET',
        urlPath: '/v3/certificates',
        timestamp: '1554208460',
        nonce: '593BEC0C930BF1AFEB40B4A08C8FB242',
        body: '',
      }),
    ).toBe('GET\n/v3/certificates\n1554208460\n593BEC0C930BF1AFEB40B4A08C8FB242\n\n')
  })

  it('按「方法\\n路径\\n时间戳\\n随机串\\n报文\\n」拼接，末尾必须有换行', () => {
    expect(
      buildSignMessage({
        method: 'POST',
        urlPath: '/v3/pay/partner/transactions/jsapi',
        timestamp: '1700000000',
        nonce: 'ABC',
        body: '{"a":1}',
      }),
    ).toBe('POST\n/v3/pay/partner/transactions/jsapi\n1700000000\nABC\n{"a":1}\n')
  })

  it('GET 请求的报文体为空串，但那个换行不能少（少了就是 4 个换行，验签必挂）', () => {
    const msg = buildSignMessage({
      method: 'GET',
      urlPath: '/v3/certificates',
      timestamp: '1',
      nonce: 'N',
      body: '',
    })
    expect(msg).toBe('GET\n/v3/certificates\n1\nN\n\n')
    expect([...msg].filter((c) => c === '\n')).toHaveLength(5)
  })

  it('urlPath 必须含 query：少带 query 的待签名串与带 query 的不同', () => {
    const base = { method: 'GET', timestamp: '1', nonce: 'N', body: '' }
    expect(buildSignMessage({ ...base, urlPath: '/v3/x?mchid=1' })).not.toBe(
      buildSignMessage({ ...base, urlPath: '/v3/x' }),
    )
  })
})

describe('buildAuthorization', () => {
  const args = {
    mchId: '1900009191',
    serialNo: '1DDE55AD98ED71D6EDD4A4A16996DE7B9C1',
    method: 'GET',
    urlPath: '/v3/certificates',
    body: '',
  }

  it('头的形状与官方文档逐字符一致（字段顺序、引号、逗号都不能变）', () => {
    const auth = buildAuthorization({
      ...args,
      privateKeyPem: priv,
      nonce: '593BEC0C930BF1AFEB40B4A08C8FB242',
      now: new Date(1554208460_000),
    })
    const signature = rsaSha256Sign(
      'GET\n/v3/certificates\n1554208460\n593BEC0C930BF1AFEB40B4A08C8FB242\n\n',
      priv,
    )
    expect(auth).toBe(
      'WECHATPAY2-SHA256-RSA2048 mchid="1900009191",' +
        `nonce_str="593BEC0C930BF1AFEB40B4A08C8FB242",signature="${signature}",` +
        'timestamp="1554208460",serial_no="1DDE55AD98ED71D6EDD4A4A16996DE7B9C1"',
    )
  })

  it('生成的头包含协议要求的全部字段', () => {
    const auth = buildAuthorization({ ...args, privateKeyPem: priv })
    expect(auth).toMatch(/^WECHATPAY2-SHA256-RSA2048 /)
    for (const field of ['mchid', 'nonce_str', 'signature', 'timestamp', 'serial_no']) {
      expect(auth).toContain(`${field}="`)
    }
  })

  it('签名可用对应公钥验证通过', () => {
    const auth = buildAuthorization({ ...args, privateKeyPem: priv, now: new Date(1700000000000) })
    const nonce = /nonce_str="([^"]+)"/.exec(auth)?.[1] ?? ''
    const signature = /signature="([^"]+)"/.exec(auth)?.[1] ?? ''
    const timestamp = /timestamp="([^"]+)"/.exec(auth)?.[1] ?? ''
    expect(rsaSha256Verify(buildSignMessage({ ...args, timestamp, nonce }), signature, pub)).toBe(
      true,
    )
  })

  it('每次调用的随机串不同，签名也不同（防重放）', () => {
    expect(buildAuthorization({ ...args, privateKeyPem: priv })).not.toBe(
      buildAuthorization({ ...args, privateKeyPem: priv }),
    )
  })

  it('method 自动大写：小写的 post 与大写的 POST 签出同一串', () => {
    const common = { ...args, privateKeyPem: priv, nonce: 'N', now: new Date(0) }
    expect(buildAuthorization({ ...common, method: 'post' })).toBe(
      buildAuthorization({ ...common, method: 'POST' }),
    )
  })
})

describe('generateNonce', () => {
  it('默认 32 位大写 hex，符合微信 ≤32 位的要求', () => {
    const n = generateNonce()
    expect(n).toHaveLength(32)
    expect(n).toMatch(/^[0-9A-F]{32}$/)
  })

  it('两次调用不重复', () => {
    expect(generateNonce()).not.toBe(generateNonce())
  })
})

describe('rsaSha256Verify', () => {
  const timestamp = '1700000000'
  const nonce = 'NONCE123'
  const body = '{"event_type":"TRANSACTION.SUCCESS"}'
  const msg = () => `${timestamp}\n${nonce}\n${body}\n`

  it('正确签名验证通过', () => {
    expect(rsaSha256Verify(msg(), rsaSha256Sign(msg(), priv), pub)).toBe(true)
  })

  it('报文被篡改则验签失败——这正是只解密不验签挡不住的攻击', () => {
    const sig = rsaSha256Sign(msg(), priv)
    expect(
      rsaSha256Verify(`${timestamp}\n${nonce}\n{"event_type":"REFUND.SUCCESS"}\n`, sig, pub),
    ).toBe(false)
  })

  it('用别的私钥签的报文验不过', () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const sig = rsaSha256Sign(
      msg(),
      other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    )
    expect(rsaSha256Verify(msg(), sig, pub)).toBe(false)
  })

  it('签名是乱码时返回 false 而不是抛异常', () => {
    expect(rsaSha256Verify(msg(), '!!!not-base64', pub)).toBe(false)
  })

  it('PEM 本身是垃圾时也返回 false，不把异常甩给调用方', () => {
    expect(rsaSha256Verify(msg(), rsaSha256Sign(msg(), priv), 'not a pem')).toBe(false)
  })
})

describe('selectVerifyPem：平台证书 / 微信支付公钥双模式', () => {
  const cred = {
    publicKeyId: 'PUB_KEY_ID_0117',
    publicKeyPem: 'PUBKEY_PEM',
    platformSerialNo: 'CERT_SERIAL',
    platformCertPem: 'CERT_PEM',
  }

  it('serial 是公钥 ID 时用微信支付公钥', () => {
    expect(selectVerifyPem({ serial: 'PUB_KEY_ID_0117', ...cred })).toBe('PUBKEY_PEM')
  })

  it('serial 是平台证书序列号时用平台证书', () => {
    expect(selectVerifyPem({ serial: 'CERT_SERIAL', ...cred })).toBe('CERT_PEM')
  })

  it('两边都对不上返回 null——调用方必须当成验签失败，不能放行', () => {
    expect(selectVerifyPem({ serial: 'SOMETHING_ELSE', ...cred })).toBeNull()
  })

  it('serial 带不可见空白时 trim 兜底：否则「看着一样却不相等」根本查不出来', () => {
    expect(selectVerifyPem({ serial: '  PUB_KEY_ID_0117\n', ...cred })).toBe('PUBKEY_PEM')
  })

  it('只配了一套时不会误用另一套', () => {
    expect(
      selectVerifyPem({ serial: 'CERT_SERIAL', publicKeyId: 'X', publicKeyPem: 'Y' }),
    ).toBeNull()
  })

  it('extraCerts 作为混签过渡期的兜底', () => {
    expect(
      selectVerifyPem({
        serial: 'DOWNLOADED',
        extraCerts: [{ serialNo: 'DOWNLOADED', certPem: 'DL_PEM' }],
      }),
    ).toBe('DL_PEM')
  })
})

describe('verifyResponseSignature', () => {
  const base = (): WechatPayCredentials => ({
    mchId: '1900009191',
    serialNo: 'MCH_SERIAL',
    privateKeyPem: priv,
    apiV3Key: 'A'.repeat(32),
    publicKeyId: 'PUB_KEY_ID_0117',
    publicKeyPem: pub,
  })

  it('公钥模式下验签通过', () => {
    const body = '{"code":"OK"}'
    const signature = rsaSha256Sign(`1700000000\nNONCE\n${body}\n`, priv)
    expect(
      verifyResponseSignature({
        credentials: base(),
        serial: 'PUB_KEY_ID_0117',
        timestamp: '1700000000',
        nonce: 'NONCE',
        body,
        signature,
      }),
    ).toEqual({ ok: true, pem: pub })
  })

  it('序列号对不上时 pem 为 null——与「验签算错了」是两种故障，要能分开', () => {
    const res = verifyResponseSignature({
      credentials: base(),
      serial: 'UNKNOWN',
      timestamp: '1',
      nonce: 'N',
      body: '{}',
      signature: 'x',
    })
    expect(res).toEqual({ ok: false, pem: null })
  })

  it('报文被改过时 ok=false 但 pem 有值', () => {
    const signature = rsaSha256Sign('1\nN\n{"a":1}\n', priv)
    const res = verifyResponseSignature({
      credentials: base(),
      serial: 'PUB_KEY_ID_0117',
      timestamp: '1',
      nonce: 'N',
      body: '{"a":2}',
      signature,
    })
    expect(res.ok).toBe(false)
    expect(res.pem).toBe(pub)
  })
})

describe('isTimestampFresh', () => {
  const now = 1700000000_000

  it('窗口内通过', () => {
    expect(isTimestampFresh('1700000000', now)).toBe(true)
    expect(isTimestampFresh(String(1700000000 - (SIGNATURE_MAX_SKEW_SECONDS - 1)), now)).toBe(true)
  })

  it('超出 5 分钟视为重放', () => {
    expect(isTimestampFresh(String(1700000000 - SIGNATURE_MAX_SKEW_SECONDS - 1), now)).toBe(false)
    expect(isTimestampFresh(String(1700000000 + SIGNATURE_MAX_SKEW_SECONDS + 1), now)).toBe(false)
  })

  it('非数字时间戳直接拒绝', () => {
    expect(isTimestampFresh('abc', now)).toBe(false)
    expect(isTimestampFresh('', now)).toBe(false)
  })
})

describe('signJsapi：二次签名', () => {
  it('待签名串是「appId\\ntimeStamp\\nnonceStr\\npackage\\n」，签名可被公钥验证', () => {
    const p = signJsapi({
      appId: 'wx05cb3fabb19e3e2e',
      prepayId: 'wx201410272009395522657a690389285100',
      privateKeyPem: priv,
      now: new Date(1700000000000),
    })
    expect(p.package).toBe('prepay_id=wx201410272009395522657a690389285100')
    expect(p.signType).toBe('RSA')
    expect(p.timeStamp).toBe('1700000000')
    const message = `${p.appId}\n${p.timeStamp}\n${p.nonceStr}\n${p.package}\n`
    expect(rsaSha256Verify(message, p.paySign, pub)).toBe(true)
  })

  it('appId 变了签名就变——这正是前端「支付验证签名失败」的成因', () => {
    const common = { prepayId: 'p1', privateKeyPem: priv, nonceStr: 'N', now: new Date(0) }
    expect(signJsapi({ ...common, appId: 'wx_a' }).paySign).not.toBe(
      signJsapi({ ...common, appId: 'wx_b' }).paySign,
    )
  })
})
