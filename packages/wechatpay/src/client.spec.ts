import { SignatureError, splitAmount, type ProviderConfig } from '@taizan/payment-core'
import * as crypto from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  APPLYMENT_PENDING_STATES,
  buildApplymentBody,
  buildMediaUploadMultipart,
} from './applyment'
import { WechatPayClient } from './client'
import { calcCommissionCents, requestProfitSharing } from './profit-sharing'
import { rsaSha256Sign } from './sign'
import {
  MIN_TRANSFER_CENTS,
  NO_REAL_NAME_LIMIT_CENTS,
  TRANSFER_PATH,
  buildTransferBill,
  checkTransfer,
  createTransferBill,
  mapTransferState,
  needsPolling,
  queryTransferBill,
} from './transfer'
import {
  createFetchHttpClient,
  narrowWechatPayConfig,
  type HttpRequest,
  type HttpResponse,
} from './types'

let priv: string
let pub: string

beforeAll(() => {
  const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  priv = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  pub = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString()
})

const cfgRaw = (mode: 'DIRECT' | 'PARTNER' = 'DIRECT'): ProviderConfig => ({
  ...(mode === 'DIRECT'
    ? { mode, appId: 'wx_app' }
    : { mode, spAppId: 'wx_sp', subMchId: '1666666666' }),
  credentials: {
    mchId: '1900009191',
    serialNo: 'MCH_SERIAL',
    privateKeyPem: priv,
    apiV3Key: 'A'.repeat(32),
    publicKeyId: 'PUB_KEY_ID_0117',
    publicKeyPem: pub,
  },
})

/** 记录请求并按脚本回应答的假 HttpClient。 */
function stub(handler: (req: HttpRequest) => Partial<HttpResponse>): {
  http: { request: (req: HttpRequest) => Promise<HttpResponse> }
  requests: HttpRequest[]
} {
  const requests: HttpRequest[] = []
  return {
    requests,
    http: {
      async request(req: HttpRequest): Promise<HttpResponse> {
        requests.push(req)
        const r = handler(req)
        return { status: r.status ?? 200, headers: r.headers ?? {}, body: r.body ?? '{}' }
      },
    },
  }
}

/** 用「微信的」私钥给一份应答签名，模拟真实响应头。 */
function signedResponse(body: string): HttpResponse {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const nonce = 'RESPNONCE'
  return {
    status: 200,
    headers: {
      'wechatpay-timestamp': timestamp,
      'wechatpay-nonce': nonce,
      'wechatpay-serial': 'PUB_KEY_ID_0117',
      'wechatpay-signature': rsaSha256Sign(`${timestamp}\n${nonce}\n${body}\n`, priv),
    },
    body,
  }
}

describe('WechatPayClient.call：签名与发送', () => {
  it('Authorization 里的签名对得上「实际发出去的那串字节」', async () => {
    const body = '{"prepay_id":"wx1"}'
    const s = stub(() => signedResponse(body))
    const client = new WechatPayClient({ http: s.http })
    await client.jsapi(narrowWechatPayConfig(cfgRaw()), {
      outTradeNo: 'PLAN-1',
      amountCents: 100,
      description: 'x',
      notifyUrl: 'https://e/n',
      openId: 'o_1',
    })
    const req = s.requests[0]
    expect(req?.url).toBe('https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi')
    const auth = req?.headers['Authorization'] ?? ''
    const nonce = /nonce_str="([^"]+)"/.exec(auth)?.[1] ?? ''
    const timestamp = /timestamp="([^"]+)"/.exec(auth)?.[1] ?? ''
    const signature = /signature="([^"]+)"/.exec(auth)?.[1] ?? ''
    const message = `POST\n/v3/pay/transactions/jsapi\n${timestamp}\n${nonce}\n${String(req?.body)}\n`
    expect(crypto.createVerify('RSA-SHA256').update(message).verify(pub, signature, 'base64')).toBe(
      true,
    )
  })

  it('POST 的 body 原样发出，不做二次序列化', async () => {
    const s = stub(() => ({ body: '{}' }))
    const client = new WechatPayClient({ http: s.http })
    await client.call(narrowWechatPayConfig(cfgRaw()), {
      method: 'POST',
      path: '/v3/x',
      body: { a: 1 },
      verifyResponse: false,
    })
    expect(s.requests[0]?.body).toBe('{"a":1}')
    expect(s.requests[0]?.headers['Content-Type']).toBe('application/json')
  })

  it('GET 不带 body，签名串的报文段是空串', async () => {
    const s = stub(() => ({ body: '{}' }))
    const client = new WechatPayClient({ http: s.http })
    await client.call(narrowWechatPayConfig(cfgRaw()), { method: 'GET', path: '/v3/certificates' })
    expect(s.requests[0]?.body).toBeUndefined()
  })

  it('signBody 覆盖签名正文（进件图片上传：签 meta、发 multipart）', async () => {
    const s = stub(() => ({ body: '{"media_id":"m1"}' }))
    const client = new WechatPayClient({ http: s.http })
    await client.call(narrowWechatPayConfig(cfgRaw()), {
      method: 'POST',
      path: '/v3/merchant/media/upload',
      body: new Uint8Array([1, 2, 3]),
      signBody: '{"filename":"a.jpg","sha256":"abc"}',
      extraHeaders: { 'Content-Type': 'multipart/form-data;boundary=b' },
      verifyResponse: false,
    })
    // extraHeaders 必须能覆盖默认的 application/json
    expect(s.requests[0]?.headers['Content-Type']).toBe('multipart/form-data;boundary=b')
    expect(s.requests[0]?.body).toBeInstanceOf(Uint8Array)
  })

  it('应答验签失败时抛 SignatureError——这时不能信任响应内容', async () => {
    const s = stub(() => {
      const good = signedResponse('{"prepay_id":"wx1"}')
      return { ...good, body: '{"prepay_id":"HACKED"}' }
    })
    const client = new WechatPayClient({ http: s.http })
    await expect(
      client.call(narrowWechatPayConfig(cfgRaw()), { method: 'GET', path: '/v3/x' }),
    ).rejects.toBeInstanceOf(SignatureError)
  })

  it('应答没带签名头时跳过验签（过渡期里有的租户还没配公钥）', async () => {
    const s = stub(() => ({ body: '{"ok":1}' }))
    const client = new WechatPayClient({ http: s.http })
    await expect(
      client.call(narrowWechatPayConfig(cfgRaw()), { method: 'GET', path: '/v3/x' }),
    ).resolves.toEqual({ ok: 1 })
  })

  it('4xx 的 code/message/request-id 必须带进错误里，否则日志什么也查不出来', async () => {
    const s = stub(() => ({
      status: 403,
      headers: { 'request-id': 'REQ-123' },
      body: '{"code":"NO_AUTH","message":"商户无权限"}',
    }))
    const client = new WechatPayClient({ http: s.http })
    try {
      await client.call(narrowWechatPayConfig(cfgRaw()), { method: 'GET', path: '/v3/x' })
      expect.unreachable('应该抛错')
    } catch (e) {
      expect((e as Error).message).toContain('NO_AUTH')
      expect((e as Error).message).toContain('商户无权限')
      expect((e as { detail?: { requestId?: string } }).detail?.requestId).toBe('REQ-123')
    }
  })

  it('allowNotFound 时 4xx 返回 null（查单「查无此单」不是错误）', async () => {
    const s = stub(() => ({ status: 404, body: '{"code":"ORDERNOTEXIST"}' }))
    const client = new WechatPayClient({ http: s.http })
    expect(await client.queryByOutTradeNo(narrowWechatPayConfig(cfgRaw()), 'PLAN-X')).toBeNull()
  })

  it('allowNotFound 不吞 5xx——上游挂了必须让上层知道', async () => {
    const s = stub(() => ({ status: 500, body: '{"code":"SYSTEM_ERROR"}' }))
    const client = new WechatPayClient({ http: s.http })
    await expect(
      client.queryByOutTradeNo(narrowWechatPayConfig(cfgRaw()), 'PLAN-X'),
    ).rejects.toThrow(/SYSTEM_ERROR/)
  })

  it('退款状态归一化', async () => {
    const s = stub(() => ({
      body: '{"refund_id":"R1","status":"PROCESSING","amount":{"refund":50}}',
    }))
    const client = new WechatPayClient({ http: s.http })
    const res = await client.refund(narrowWechatPayConfig(cfgRaw('PARTNER')), {
      outTradeNo: 'PLAN-1',
      outRefundNo: 'RF-1',
      totalCents: 100,
      refundCents: 50,
    })
    expect(res).toMatchObject({ refundId: 'R1', status: 'PROCESSING', refundCents: 50 })
    // 服务商退款只带 sub_mchid
    const body = JSON.parse(String(s.requests[0]?.body)) as Record<string, unknown>
    expect(body['sub_mchid']).toBe('1666666666')
    expect(body).not.toHaveProperty('sp_mchid')
  })
})

describe('createFetchHttpClient', () => {
  it('把 fetch 的响应头统一转成小写键', async () => {
    const http = createFetchHttpClient(
      async () => new Response('{"ok":1}', { status: 200, headers: { 'Wechatpay-Nonce': 'N' } }),
    )
    const res = await http.request({ method: 'GET', url: 'https://example.com', headers: {} })
    expect(res.headers['wechatpay-nonce']).toBe('N')
    expect(res.body).toBe('{"ok":1}')
  })
})

describe('分账', () => {
  it('抽佣向下取整、30% 封顶（搬自 knowledge profit-sharing.rules）', () => {
    expect(calcCommissionCents(999, 1000)).toBe(99)
    expect(calcCommissionCents(10_000, 9999)).toBe(3000)
  })

  it('多接收方按比例拆分，总和恒等于抽佣总额', () => {
    const commission = calcCommissionCents(99_99, 1000)
    const parts = splitAmount(commission, [2, 1])
    expect(parts.reduce((a, b) => a + b, 0)).toBe(commission)
  })

  it('分账报文带 unfreeze_unsplit，默认解冻剩余资金', async () => {
    const s = stub(() => ({ body: '{"order_id":"O1"}' }))
    const client = new WechatPayClient({ http: s.http })
    await requestProfitSharing(client, narrowWechatPayConfig(cfgRaw('PARTNER')), {
      transactionId: 'T1',
      outOrderNo: 'PS1',
      receivers: [
        { type: 'MERCHANT_ID', account: '1900009191', amountCents: 100, description: '平台服务费' },
      ],
    })
    const body = JSON.parse(String(s.requests[0]?.body)) as Record<string, unknown>
    expect(body['unfreeze_unsplit']).toBe(true)
    expect(body['sub_mchid']).toBe('1666666666')
    expect(body['receivers']).toEqual([
      { type: 'MERCHANT_ID', account: '1900009191', amount: 100, description: '平台服务费' },
    ])
  })

  it('直连模式下调分账接口直接抛——分账只有服务商模式有', async () => {
    const s = stub(() => ({ body: '{}' }))
    const client = new WechatPayClient({ http: s.http })
    await expect(
      requestProfitSharing(client, narrowWechatPayConfig(cfgRaw()), {
        transactionId: 'T1',
        outOrderNo: 'PS1',
        receivers: [{ type: 'MERCHANT_ID', account: 'x', amountCents: 1, description: 'd' }],
      }),
    ).rejects.toThrow(/服务商/)
    expect(s.requests).toHaveLength(0)
  })

  it('接收方为空或金额为 0 时不发请求', async () => {
    const s = stub(() => ({ body: '{}' }))
    const client = new WechatPayClient({ http: s.http })
    await expect(
      requestProfitSharing(client, narrowWechatPayConfig(cfgRaw('PARTNER')), {
        transactionId: 'T1',
        outOrderNo: 'PS1',
        receivers: [],
      }),
    ).rejects.toThrow()
    expect(s.requests).toHaveLength(0)
  })
})

describe('商家转账', () => {
  it('路径是 transfer-bills 而不是 transfers（写错的表现是 404 且无 request-id）', () => {
    expect(TRANSFER_PATH).toBe('/v3/fund-app/mch-transfer/transfer-bills')
  })

  it('发起前自查挡住能挡的', () => {
    const ok = { appId: 'wx', openId: 'o', amountCents: 100, outBillNo: 'ABC123' }
    expect(checkTransfer(ok)).toEqual({ ok: true })
    expect(checkTransfer({ ...ok, appId: '' }).ok).toBe(false)
    expect(checkTransfer({ ...ok, openId: null }).ok).toBe(false)
    expect(checkTransfer({ ...ok, amountCents: MIN_TRANSFER_CENTS - 1 }).ok).toBe(false)
    expect(checkTransfer({ ...ok, amountCents: NO_REAL_NAME_LIMIT_CENTS }).ok).toBe(false)
    // 带下划线会被回 PARAM_ERROR 并指到 out_bill_no
    expect(checkTransfer({ ...ok, outBillNo: 'ABC_123' }).ok).toBe(false)
  })

  it('备注超 32 字截断，而不是挡住用户拿钱', () => {
    const body = buildTransferBill({
      appId: 'wx',
      outBillNo: 'ABC123',
      openId: 'o',
      amountCents: 100,
      remark: '备'.repeat(50),
      sceneId: '1000',
    })
    expect(String(body['transfer_remark'])).toHaveLength(32)
    expect(body).not.toHaveProperty('notify_url')
  })

  it('服务商模式下直接抛：带 sub_mchid 会被回「未在API文档中定义的参数」', async () => {
    const s = stub(() => ({ body: '{}' }))
    const client = new WechatPayClient({ http: s.http })
    await expect(
      createTransferBill(client, narrowWechatPayConfig(cfgRaw('PARTNER')), {
        appId: 'wx',
        outBillNo: 'ABC123',
        openId: 'o',
        amountCents: 100,
        remark: 'r',
        sceneId: '1000',
      }),
    ).rejects.toThrow(/服务商/)
    expect(s.requests).toHaveLength(0)
  })

  it('发起成功后回传 package_info 给前端唤起确认收款', async () => {
    const s = stub(() => ({
      body: '{"out_bill_no":"ABC123","transfer_bill_no":"TB1","state":"WAIT_USER_CONFIRM","package_info":"pkg"}',
    }))
    const client = new WechatPayClient({ http: s.http })
    const res = await createTransferBill(client, narrowWechatPayConfig(cfgRaw()), {
      appId: 'wx',
      outBillNo: 'ABC123',
      openId: 'o',
      amountCents: 100,
      remark: 'r',
      sceneId: '1000',
    })
    expect(res).toEqual({
      outBillNo: 'ABC123',
      transferBillNo: 'TB1',
      state: 'WAIT_USER_CONFIRM',
      packageInfo: 'pkg',
    })
  })

  it('WAIT_USER_CONFIRM 单独一档：球在用户那边，混进 PENDING 就没人知道卡在哪', () => {
    expect(mapTransferState('WAIT_USER_CONFIRM')).toBe('WAIT_CONFIRM')
    expect(mapTransferState('SUCCESS')).toBe('SUCCESS')
    expect(mapTransferState('FAIL')).toBe('FAILED')
    expect(mapTransferState('CANCELLED')).toBe('FAILED')
    expect(mapTransferState('ACCEPTED')).toBe('PENDING')
    expect(needsPolling('WAIT_CONFIRM')).toBe(true)
    expect(needsPolling('SUCCESS')).toBe(false)
  })

  it('查单：不存在返回 null，存在则带上归并后的状态', async () => {
    const missing = new WechatPayClient({ http: stub(() => ({ status: 404, body: '{}' })).http })
    expect(await queryTransferBill(missing, narrowWechatPayConfig(cfgRaw()), 'ABC123')).toBeNull()

    const found = new WechatPayClient({
      http: stub(() => ({ body: '{"out_bill_no":"ABC123","state":"WAIT_USER_CONFIRM"}' })).http,
    })
    expect(await queryTransferBill(found, narrowWechatPayConfig(cfgRaw()), 'ABC123')).toMatchObject(
      {
        state: 'WAIT_USER_CONFIRM',
        status: 'WAIT_CONFIRM',
      },
    )
  })
})

describe('特约商户进件', () => {
  const form = {
    subjectType: 'enterprise' as const,
    licenseCopyMediaId: 'm1',
    licenseNumber: '91410100MA1234567X',
    legalPerson: '张三',
    miniProgramAppid: 'wx_mini',
    merchantName: '某某科技有限公司',
    merchantShortname: '某某',
    servicePhone: '18800000000',
    idCardCopyMediaId: 'm2',
    idCardNationalMediaId: 'm3',
    idCardName: '张三',
    idCardNumber: '410100199001011234',
    idPeriodBegin: '2020-01-01',
    idPeriodEnd: '长期',
    contactMobile: '18800000000',
    contactEmail: 'a@b.com',
    bankAccountType: 'corporate' as const,
    accountName: '某某科技有限公司',
    accountBank: '工商银行',
    bankName: '工商银行郑州分行',
    bankAddressCode: '410100',
    accountNumber: '6222000000000000',
    settlementId: '719',
    qualificationType: '餐饮',
  }

  it('姓名/身份证号/手机号/邮箱/银行卡号必须加密，其余字段保持明文', () => {
    const body = buildApplymentBody('BC001', form, (s) => `ENC(${s})`) as Record<
      string,
      Record<string, unknown>
    >
    const contact = body['contact_info'] as Record<string, string>
    expect(contact['contact_name']).toBe('ENC(张三)')
    expect(contact['mobile_phone']).toBe('ENC(18800000000)')
    expect(contact['contact_email']).toBe('ENC(a@b.com)')

    const idCard = (
      (body['subject_info'] as Record<string, Record<string, Record<string, string>>>)[
        'identity_info'
      ] as Record<string, Record<string, string>>
    )['id_card_info'] as Record<string, string>
    expect(idCard['id_card_number']).toBe('ENC(410100199001011234)')
    // 证件照 media_id 与有效期是明文
    expect(idCard['id_card_copy']).toBe('m2')
    expect(idCard['card_period_end']).toBe('长期')

    const bank = body['bank_account_info'] as Record<string, string>
    expect(bank['account_number']).toBe('ENC(6222000000000000)')
    expect(bank['account_bank']).toBe('工商银行')
  })

  it('主体类型映射到微信枚举', () => {
    const individual = buildApplymentBody('BC', { ...form, subjectType: 'individual' }, (s) => s)
    expect((individual['subject_info'] as Record<string, string>)['subject_type']).toBe(
      'SUBJECT_TYPE_INDIVIDUAL',
    )
  })

  it('图片上传的 multipart：meta 在前、文件在后，且 meta 与签名串一致', () => {
    const { body, meta } = buildMediaUploadMultipart({
      filename: 'a.png',
      sha256: 'abc',
      buffer: new Uint8Array([1, 2, 3]),
      boundary: 'BD',
    })
    const text = Buffer.from(body).toString('binary')
    expect(meta).toBe('{"filename":"a.png","sha256":"abc"}')
    expect(text.startsWith('--BD\r\nContent-Disposition: form-data; name="meta";')).toBe(true)
    expect(text).toContain('Content-Type: image/png')
    expect(text.endsWith('\r\n--BD--\r\n')).toBe(true)
  })

  it('流转中的状态列表不含终态', () => {
    expect(APPLYMENT_PENDING_STATES).not.toContain('APPLYMENT_STATE_FINISHED')
    expect(APPLYMENT_PENDING_STATES).not.toContain('APPLYMENT_STATE_REJECTED')
    expect(APPLYMENT_PENDING_STATES).toContain('APPLYMENT_STATE_AUDITING')
  })
})
