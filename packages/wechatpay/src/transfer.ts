/**
 * 商家转账到零钱（新版 mch-transfer）：批次发起、查询、撤单。
 *
 * 搬自 xiaodian `wechatpay-client.ts` 的三个 transfer 方法 + knowledge
 * `payment/wechat/merchant-transfer.rules.ts` 的发起前自查与状态归并。
 *
 * ## 四条用生产事故换来的约束
 *
 * 1. **路径是 `/v3/fund-app/mch-transfer/transfer-bills`**，不是 `/transfers`。
 *    写错的表现是 404 且**没有 request-id**，body 也是空的——极难排查。
 *    有 request-id 说明请求已经到了业务层（签名证书都没问题），照 message 改参数即可。
 * 2. **不支持服务商模式**：带 `sub_mchid` 会被回「请求中含有未在API文档中定义的参数」。
 *    钱只能从服务商自己的商户号出。这条约束决定了出资方，不是技术选择。
 * 3. **单笔 ≥ 2000 元必须带收款人实名信息**（且要 RSA 加密），奖励性质的转账不该走到那一步。
 * 4. **商户单号只能数字和字母**：带下划线会被回 `PARAM_ERROR` 并指到 `out_bill_no`。
 */
import { PAYMENT_ERROR, PaymentError } from '@taizan/payment-core'

import type { WechatPayApi } from './client'
import type { WechatPayConfig } from './types'

/** 转账接口路径。 */
export const TRANSFER_PATH = '/v3/fund-app/mch-transfer/transfer-bills'

/** 免实名的金额上限（分）。单笔满 2000 元需要收款人真实姓名。 */
export const NO_REAL_NAME_LIMIT_CENTS = 200_000

/** 微信侧的单笔下限（分）。1 分会被拒（实测「超过单笔转账上下限」）。 */
export const MIN_TRANSFER_CENTS = 30

/** 发起转账的入参。 */
export interface TransferBillInput {
  /** 发起转账的 appid，**必须与收款 openid 的归属 appid 一致**。 */
  appId: string
  /** 商户转账单号，6–32 位数字与字母。 */
  outBillNo: string
  /** 收款用户 openid（归属 `appId`）。 */
  openId: string
  amountCents: number
  /** 转账备注（≤32 字，用户可见）。超长直接截断——一句备注不该挡住用户拿钱。 */
  remark: string
  /** 转账场景 ID（商户平台申请，如 1000 现金营销）。 */
  sceneId: string
  /** 回调地址（https 且无 query）；不传就只能靠主动查单。 */
  notifyUrl?: string
  /** 场景报备信息，不同场景要求的字段不同（如 1000 场景需活动名称/奖励说明）。 */
  sceneReport?: { infoType: string; infoContent: string }[]
}

/** 发起前自查的结果。 */
export type TransferGate = { ok: true } | { ok: false; message: string }

/**
 * 发起前的自查。**在调微信之前拦住能拦的**——
 * 每一次失败的调用都会在微信侧留下记录，而且排查成本高得多。
 */
export function checkTransfer(input: {
  appId: string
  openId: string | null | undefined
  amountCents: number
  outBillNo: string
}): TransferGate {
  if (!input.appId) return { ok: false, message: '未配置发起转账的 appid' }
  if (!input.openId) {
    // openid 必须与 appid 同源。用户只在小程序登录过就没有公众号 openid，
    // 拿另一个 appid 下的 openid 去转账，微信会拒。
    return { ok: false, message: '该用户没有可收款的微信身份（需在微信内登录过）' }
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents < MIN_TRANSFER_CENTS) {
    return { ok: false, message: `单笔金额不能低于 ${MIN_TRANSFER_CENTS / 100} 元` }
  }
  if (input.amountCents >= NO_REAL_NAME_LIMIT_CENTS) {
    return {
      ok: false,
      message: `单笔满 ${NO_REAL_NAME_LIMIT_CENTS / 100} 元需要收款人实名信息，当前不支持`,
    }
  }
  if (!/^[A-Za-z0-9]{6,32}$/.test(input.outBillNo)) {
    return { ok: false, message: '商户单号只能是 6-32 位数字和字母' }
  }
  return { ok: true }
}

/** 构造转账报文。字段顺序无关，但**键名必须一字不差**。 */
export function buildTransferBill(input: TransferBillInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    appid: input.appId,
    out_bill_no: input.outBillNo,
    transfer_scene_id: input.sceneId,
    openid: input.openId,
    transfer_amount: input.amountCents,
    transfer_remark: input.remark.slice(0, 32),
  }
  if (input.notifyUrl) body['notify_url'] = input.notifyUrl
  if (input.sceneReport?.length) {
    body['transfer_scene_report_infos'] = input.sceneReport.map((r) => ({
      info_type: r.infoType,
      info_content: r.infoContent,
    }))
  }
  return body
}

/** 微信的转账单状态。 */
export type TransferState =
  | 'ACCEPTED'
  | 'PROCESSING'
  | 'WAIT_USER_CONFIRM'
  | 'TRANSFERING'
  | 'SUCCESS'
  | 'FAIL'
  | 'CANCELING'
  | 'CANCELLED'

/** 归并后的本地状态。 */
export type TransferLocalStatus = 'PENDING' | 'WAIT_CONFIRM' | 'SUCCESS' | 'FAILED'

/**
 * 把微信的八种状态归到四种。
 *
 * **`WAIT_USER_CONFIRM` 单独一档**，不能混进 `PENDING`：这个状态意味着球在用户那边——
 * 钱已经准备好了，等他在微信里点确认。混进「处理中」的话，运营会一直等系统，
 * 而系统在等用户，谁都不知道卡在哪。
 */
export function mapTransferState(state: string): TransferLocalStatus {
  switch (state) {
    case 'SUCCESS':
      return 'SUCCESS'
    case 'FAIL':
    case 'CANCELLED':
      return 'FAILED'
    case 'WAIT_USER_CONFIRM':
      return 'WAIT_CONFIRM'
    default:
      return 'PENDING'
  }
}

/** 这个状态还需不需要继续轮询。 */
export function needsPolling(status: TransferLocalStatus): boolean {
  return status === 'PENDING' || status === 'WAIT_CONFIRM'
}

/** 发起转账的结果。 */
export interface TransferBillResult {
  outBillNo: string
  transferBillNo: string
  state: string
  /** 回传前端 `wx.requestMerchantTransfer` 唤起用户确认收款用。 */
  packageInfo: string | null
}

/**
 * 发起一笔商家转账。
 *
 * @throws {PaymentError} 服务商模式下调用（本接口不支持），或自查未过
 */
export async function createTransferBill(
  api: WechatPayApi,
  cfg: WechatPayConfig,
  input: TransferBillInput,
): Promise<TransferBillResult> {
  if (cfg.mode === 'PARTNER') {
    throw PaymentError.of(
      PAYMENT_ERROR.CONFIG_INVALID,
      '[@taizan/wechatpay] 商家转账不支持服务商模式（带 sub_mchid 会被微信判为未定义参数）',
    )
  }
  const gate = checkTransfer({
    appId: input.appId,
    openId: input.openId,
    amountCents: input.amountCents,
    outBillNo: input.outBillNo,
  })
  if (!gate.ok) {
    throw PaymentError.of(PAYMENT_ERROR.BAD_REQUEST, `[@taizan/wechatpay] ${gate.message}`)
  }
  const res = await api.call<{
    out_bill_no?: string
    transfer_bill_no?: string
    state?: string
    package_info?: string
  }>(cfg, {
    method: 'POST',
    path: TRANSFER_PATH,
    body: buildTransferBill(input),
    // 商家转账应答不强制验签（平台证书/公钥缺失时也要能用）。
    verifyResponse: false,
  })
  return {
    outBillNo: String(res?.out_bill_no ?? input.outBillNo),
    transferBillNo: String(res?.transfer_bill_no ?? ''),
    state: String(res?.state ?? ''),
    packageInfo: res?.package_info ?? null,
  }
}

/** 转账查单（按商户单号）。单不存在返回 `null`。 */
export async function queryTransferBill(
  api: WechatPayApi,
  cfg: WechatPayConfig,
  outBillNo: string,
): Promise<{
  outBillNo: string
  transferBillNo: string
  state: string
  status: TransferLocalStatus
  failReason: string | null
} | null> {
  const res = await api.call<{
    out_bill_no?: string
    transfer_bill_no?: string
    state?: string
    fail_reason?: string
  }>(cfg, {
    method: 'GET',
    path: `${TRANSFER_PATH}/out-bill-no/${encodeURIComponent(outBillNo)}`,
    allowNotFound: true,
  })
  if (!res) return null
  const state = String(res.state ?? '')
  return {
    outBillNo: String(res.out_bill_no ?? outBillNo),
    transferBillNo: String(res.transfer_bill_no ?? ''),
    state,
    status: mapTransferState(state),
    failReason: res.fail_reason ?? null,
  }
}

/** 转账撤单（用户确认收款前可撤）。 */
export async function cancelTransferBill(
  api: WechatPayApi,
  cfg: WechatPayConfig,
  outBillNo: string,
): Promise<{ state: string }> {
  const res = await api.call<{ state?: string }>(cfg, {
    method: 'POST',
    path: `${TRANSFER_PATH}/out-bill-no/${encodeURIComponent(outBillNo)}/cancel`,
    body: '',
    verifyResponse: false,
  })
  return { state: String(res?.state ?? '') }
}
