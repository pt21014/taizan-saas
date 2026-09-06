/**
 * 特约商户进件（applyment4sub）：表单 → 微信进件报文的纯函数映射 + 提交/查询/图片上传。
 *
 * 整体搬自 xiaodian `libs/wechatpay/src/applyment.ts`（160 行）与
 * `wechatpay-client.ts` 里的 `uploadMerchantMedia` / `submitApplyment` /
 * `queryApplymentByBusinessCode`。
 *
 * 敏感字段（姓名/身份证号/手机号/邮箱/银行卡号）经 `encryptFn`（RSAES-OAEP）加密，
 * 请求头必须带 `Wechatpay-Serial` = 加密所用公钥的 ID/序列号。
 *
 * 文档：https://pay.weixin.qq.com/doc/v3/partner/4012712216
 */
import { createHash } from 'node:crypto'

import { PAYMENT_ERROR, PaymentError } from '@taizan/payment-core'

import type { WechatPayApi } from './client'
import { createFieldEncryptor } from './sensitive'
import { generateNonce } from './sign'
import type { WechatPayConfig } from './types'

/** 商户进件表单。日期均 `YYYY-MM-DD`，长期填 `'长期'`。 */
export interface WxApplymentForm {
  subjectType: 'enterprise' | 'individual'
  // 经营信息
  licenseCopyMediaId: string
  licenseNumber: string
  legalPerson: string
  miniProgramAppid: string
  merchantName: string
  merchantShortname: string
  servicePhone: string
  // 经营者/法人身份证
  /** 人像面 media_id。 */
  idCardCopyMediaId: string
  /** 国徽面 media_id。 */
  idCardNationalMediaId: string
  idCardName: string
  idCardNumber: string
  idPeriodBegin: string
  /** 可为 `'长期'`。 */
  idPeriodEnd: string
  contactMobile: string
  contactEmail: string
  // 结算账户
  bankAccountType: 'corporate' | 'personal'
  accountName: string
  /** 开户银行（微信枚举名，如「工商银行」）。 */
  accountBank: string
  /** 开户银行全称（含支行）。 */
  bankName: string
  /** 开户行省市区编码（区县级）。 */
  bankAddressCode: string
  accountNumber: string
  // 结算规则
  settlementId: string
  qualificationType: string
}

/** 微信侧申请单状态（加上本地草稿 `DRAFT`）。 */
export const APPLYMENT_STATES = [
  'DRAFT',
  'APPLYMENT_STATE_EDITTING',
  'APPLYMENT_STATE_AUDITING',
  'APPLYMENT_STATE_REJECTED',
  'APPLYMENT_STATE_TO_BE_CONFIRMED',
  'APPLYMENT_STATE_TO_BE_SIGNED',
  'APPLYMENT_STATE_SIGNING',
  'APPLYMENT_STATE_FINISHED',
  'APPLYMENT_STATE_CANCELED',
] as const

export type ApplymentState = (typeof APPLYMENT_STATES)[number]

/** 仍在流转中、需要定时任务持续同步的状态。 */
export const APPLYMENT_PENDING_STATES: readonly string[] = [
  'APPLYMENT_STATE_EDITTING',
  'APPLYMENT_STATE_AUDITING',
  'APPLYMENT_STATE_TO_BE_CONFIRMED',
  'APPLYMENT_STATE_TO_BE_SIGNED',
  'APPLYMENT_STATE_SIGNING',
]

/** 进件申请单查询结果。 */
export interface ApplymentQueryResult {
  applymentState: string
  applymentStateMsg: string
  subMchid: string | null
  signUrl: string | null
  auditDetail: unknown[]
  rawJson: Record<string, unknown>
}

/**
 * 表单 → `/v3/applyment4sub/applyment/` 请求 body。
 *
 * `encryptFn` 由调用方从 `createFieldEncryptor()` 拿——**做成参数而不是内部直接加密**，
 * 是为了让这个函数保持纯：单测里传一个 `(s) => 'ENC(' + s + ')'` 就能断言
 * 「哪些字段被加密了、哪些没有」，而不必造一对 RSA 密钥。
 */
export function buildApplymentBody(
  businessCode: string,
  f: WxApplymentForm,
  encryptFn: (plaintext: string) => string,
): Record<string, unknown> {
  return {
    business_code: businessCode,
    // 超级管理员 = 法人（接收微信支付重要通知）
    contact_info: {
      contact_type: 'LEGAL',
      contact_name: encryptFn(f.idCardName),
      mobile_phone: encryptFn(f.contactMobile),
      contact_email: encryptFn(f.contactEmail),
    },
    subject_info: {
      subject_type:
        f.subjectType === 'enterprise' ? 'SUBJECT_TYPE_ENTERPRISE' : 'SUBJECT_TYPE_INDIVIDUAL',
      business_license_info: {
        license_copy: f.licenseCopyMediaId,
        license_number: f.licenseNumber,
        merchant_name: f.merchantName,
        legal_person: f.legalPerson,
      },
      identity_info: {
        id_doc_type: 'IDENTIFICATION_TYPE_IDCARD',
        id_card_info: {
          id_card_copy: f.idCardCopyMediaId,
          id_card_national: f.idCardNationalMediaId,
          id_card_name: encryptFn(f.idCardName),
          id_card_number: encryptFn(f.idCardNumber),
          card_period_begin: f.idPeriodBegin,
          card_period_end: f.idPeriodEnd,
        },
        owner: true,
      },
    },
    business_info: {
      merchant_shortname: f.merchantShortname,
      service_phone: f.servicePhone,
      sales_info: {
        sales_scenes_type: ['SALES_SCENES_MINI_PROGRAM'],
        mini_program_info: { mini_program_appid: f.miniProgramAppid },
      },
    },
    settlement_info: {
      settlement_id: f.settlementId,
      qualification_type: f.qualificationType,
    },
    bank_account_info: {
      bank_account_type:
        f.bankAccountType === 'corporate'
          ? 'BANK_ACCOUNT_TYPE_CORPORATE'
          : 'BANK_ACCOUNT_TYPE_PERSONAL',
      account_name: encryptFn(f.accountName),
      account_bank: f.accountBank,
      bank_address_code: f.bankAddressCode,
      bank_name: f.bankName,
      account_number: encryptFn(f.accountNumber),
    },
  }
}

/**
 * 进件图片上传的 multipart body。
 *
 * **签名串的 body 用的是 `meta` JSON，不是 multipart 全文**——
 * 这是微信在整个 V3 里唯一的例外，拿全文去签必然验签失败。
 */
export function buildMediaUploadMultipart(opts: {
  filename: string
  sha256: string
  buffer: Uint8Array
  boundary: string
}): { body: Uint8Array; meta: string } {
  const meta = JSON.stringify({ filename: opts.filename, sha256: opts.sha256 })
  const ext = opts.filename.split('.').pop()?.toLowerCase() ?? 'jpg'
  const mime = ext === 'png' ? 'image/png' : ext === 'bmp' ? 'image/bmp' : 'image/jpg'
  const head =
    `--${opts.boundary}\r\n` +
    'Content-Disposition: form-data; name="meta";\r\n' +
    'Content-Type: application/json\r\n\r\n' +
    `${meta}\r\n` +
    `--${opts.boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${opts.filename}";\r\n` +
    `Content-Type: ${mime}\r\n\r\n`
  const tail = `\r\n--${opts.boundary}--\r\n`
  return {
    body: Buffer.concat([
      Buffer.from(head, 'utf8'),
      Buffer.from(opts.buffer),
      Buffer.from(tail, 'utf8'),
    ]),
    meta,
  }
}

/** 上传进件图片 → `media_id`。 */
export async function uploadMerchantMedia(
  api: WechatPayApi,
  cfg: WechatPayConfig,
  file: { filename: string; buffer: Uint8Array },
): Promise<{ mediaId: string }> {
  const sha256 = createHash('sha256').update(file.buffer).digest('hex')
  const boundary = `boundary${generateNonce(12)}`
  const { body, meta } = buildMediaUploadMultipart({
    filename: file.filename,
    sha256,
    buffer: file.buffer,
    boundary,
  })
  // 签名串正文是 meta JSON；实际发送的是 multipart 全文。两者不同是微信的规定，不是笔误。
  const res = await api.call<{ media_id?: string }>(cfg, {
    method: 'POST',
    path: '/v3/merchant/media/upload',
    body,
    signBody: meta,
    extraHeaders: { 'Content-Type': `multipart/form-data;boundary=${boundary}` },
    verifyResponse: false,
  })
  return { mediaId: String(res?.media_id ?? '') }
}

/** 提交特约商户进件申请单 → `applyment_id`。 */
export async function submitApplyment(
  api: WechatPayApi,
  cfg: WechatPayConfig,
  businessCode: string,
  form: WxApplymentForm,
): Promise<{ applymentId: string }> {
  const encryptor = createFieldEncryptor(cfg.credentials)
  const body = buildApplymentBody(businessCode, form, encryptor.encrypt)
  const res = await api.call<{ applyment_id?: number | string }>(cfg, {
    method: 'POST',
    path: '/v3/applyment4sub/applyment/',
    body,
    // 敏感字段加密所用公钥的序列号/公钥 ID：少了这个头，密文是对的微信也解不开。
    extraHeaders: { 'Wechatpay-Serial': encryptor.serial },
  })
  if (!res?.applyment_id) {
    throw PaymentError.of(
      PAYMENT_ERROR.UPSTREAM_ERROR,
      '[@taizan/wechatpay] 进件应答缺 applyment_id',
    )
  }
  return { applymentId: String(res.applyment_id) }
}

/** 按业务单号查询进件申请单状态。 */
export async function queryApplymentByBusinessCode(
  api: WechatPayApi,
  cfg: WechatPayConfig,
  businessCode: string,
): Promise<ApplymentQueryResult | null> {
  const d = await api.call<Record<string, unknown>>(cfg, {
    method: 'GET',
    path: `/v3/applyment4sub/applyment/business_code/${encodeURIComponent(businessCode)}`,
    allowNotFound: true,
  })
  if (!d) return null
  return {
    applymentState: String(d['applyment_state'] ?? ''),
    applymentStateMsg: String(d['applyment_state_msg'] ?? ''),
    subMchid: d['sub_mchid'] ? String(d['sub_mchid']) : null,
    signUrl: d['sign_url'] ? String(d['sign_url']) : null,
    auditDetail: Array.isArray(d['audit_detail']) ? (d['audit_detail'] as unknown[]) : [],
    rawJson: d,
  }
}
