/**
 * 微信官方分账（profitsharing）：添加接收方、发起分账、查询、回退、查询回退。
 *
 * 搬自 knowledge `payment/wechat/wechat-partner.service.ts` 的分账五个方法与
 * `profit-sharing.rules.ts` 的抽佣计算（后者已经进了 `@taizan/payment-core` 的
 * `calcCommissionCents`，这里直接复用）。
 *
 * ## 为什么必须走官方分账
 *
 * 「平台收款后再转给商家」属于**二清**（无证经营支付业务），做大了会被叫停。
 * 官方分账是唯一合规路径。
 *
 * ## 三个时序上的硬约束（写代码时最容易忽略）
 *
 * 1. **下单时**就要打分账标记（`settle_info.profit_sharing`，见 `platform-pay.ts`），
 *    事后无法补分账；
 * 2. 分账是**异步**的，接口返回只代表受理，要查询才知道成没成；
 * 3. 已分账的订单退款前**必须先回退**，否则商家余额不足导致退款失败——
 *    留下一个「同意了却退不掉」的烂摊子。
 *
 * ## 服务商模式下开通分账要两步
 *
 * 服务商先在商户平台开通分账产品，再向特约商户**发起分账邀请**，商户确认后才生效。
 * 只做前一步的话，发起分账依然是 `403 NO_AUTH`。{@link queryProfitSharingConfig}
 * 是判断「这家商户能不能分账」最准的探针。
 */
import { PAYMENT_ERROR, PaymentError, calcCommissionCents } from '@taizan/payment-core'

import type { WechatPayApi } from './client'
import { createFieldEncryptor } from './sensitive'
import type { WechatPayConfig } from './types'

export { calcCommissionCents }

/** 微信规定单笔分账不得超过订单金额的 30%。 */
export const MAX_SHARE_BPS = 3000

/** 分账接收方。 */
export interface ProfitSharingReceiver {
  /** 目前只支持 `MERCHANT_ID`（商户号）；`PERSONAL_OPENID` 需要额外申请。 */
  type: 'MERCHANT_ID' | 'PERSONAL_OPENID'
  /** 商户号或 openid。 */
  account: string
  /** 分账金额（分）。 */
  amountCents: number
  description: string
}

function subMchIdOf(cfg: WechatPayConfig): string {
  if (cfg.mode !== 'PARTNER') {
    throw PaymentError.of(
      PAYMENT_ERROR.CONFIG_INVALID,
      '[@taizan/wechatpay] 分账接口只在服务商（PARTNER）模式下可用',
    )
  }
  return cfg.subMchId
}

/**
 * 添加分账接收方。
 *
 * 同一个接收方**重复添加不会报错**，所以每次分账前调一次即可，不必自己维护
 * 「哪些特约商户已经添加过」的状态。
 *
 * `name`（商户全称）在 `type=MERCHANT_ID` 时是必填的，且**必须用微信支付公钥加密**——
 * 少了它微信只回一句笼统的「请求参数错误」，不会告诉你缺的是哪个字段。
 * 这一条是 knowledge 项目在生产环境逐个试报文形状试出来的。
 */
export async function addProfitSharingReceiver(
  api: WechatPayApi,
  cfg: WechatPayConfig,
  params: {
    /** 接收方商户号（通常就是服务商自己）。 */
    account: string
    /** 接收方商户全称（明文传入，本函数负责加密）。 */
    name: string
    /** 与分账方的关系，平台抽服务费按 `PARTNER`（合作伙伴）登记。 */
    relationType?: string
  },
): Promise<Record<string, unknown> | null> {
  const subMchId = subMchIdOf(cfg)
  const encryptor = createFieldEncryptor(cfg.credentials)
  return api.call(cfg, {
    method: 'POST',
    path: '/v3/profitsharing/receivers/add',
    body: {
      appid: cfg.mode === 'PARTNER' ? cfg.spAppId : '',
      sub_mchid: subMchId,
      type: 'MERCHANT_ID',
      account: params.account,
      name: encryptor.encrypt(params.name),
      relation_type: params.relationType ?? 'PARTNER',
    },
    extraHeaders: { 'Wechatpay-Serial': encryptor.serial },
  })
}

/**
 * 请求分账（异步，返回只代表受理）。
 *
 * `unfreeze_unsplit: true` 表示分完这一笔就**解冻剩余资金**给商家。
 * 不解冻的话钱会一直冻着，商家看到「已收款但提不出来」会立刻投诉；
 * 只有还要追加分账时才该传 false。
 */
export async function requestProfitSharing(
  api: WechatPayApi,
  cfg: WechatPayConfig,
  params: {
    transactionId: string
    outOrderNo: string
    receivers: ProfitSharingReceiver[]
    /** 分完即解冻剩余资金，默认 `true`。 */
    unfreezeUnsplit?: boolean
  },
): Promise<Record<string, unknown> | null> {
  const subMchId = subMchIdOf(cfg)
  const total = params.receivers.reduce((sum, r) => sum + r.amountCents, 0)
  if (params.receivers.length === 0 || total <= 0) {
    throw PaymentError.of(PAYMENT_ERROR.BAD_REQUEST, '[@taizan/wechatpay] 分账接收方或金额为空')
  }
  return api.call(cfg, {
    method: 'POST',
    path: '/v3/profitsharing/orders',
    body: {
      appid: cfg.mode === 'PARTNER' ? cfg.spAppId : '',
      sub_mchid: subMchId,
      transaction_id: params.transactionId,
      out_order_no: params.outOrderNo,
      receivers: params.receivers.map((r) => ({
        type: r.type,
        account: r.account,
        amount: r.amountCents,
        description: r.description.slice(0, 80),
      })),
      unfreeze_unsplit: params.unfreezeUnsplit ?? true,
    },
  })
}

/** 查询分账结果。**受理不等于成功**，订单级 `FINISHED` 只表示流程结束，要看 `receivers[].result`。 */
export async function queryProfitSharing(
  api: WechatPayApi,
  cfg: WechatPayConfig,
  params: { outOrderNo: string; transactionId: string },
): Promise<Record<string, unknown> | null> {
  const subMchId = subMchIdOf(cfg)
  return api.call(cfg, {
    method: 'GET',
    path:
      `/v3/profitsharing/orders/${encodeURIComponent(params.outOrderNo)}` +
      `?sub_mchid=${subMchId}&transaction_id=${encodeURIComponent(params.transactionId)}`,
    allowNotFound: true,
  })
}

/**
 * 查特约商户的最大分账比例。
 *
 * 它同时是判断「这家商户能不能分账」最准的探针，比直接发起分账看报错清楚得多：
 * - `200` + `max_ratio` → 商户已通过分账邀请，比例上限就是这个数
 * - `404 RESOURCE_NOT_EXISTS` → 商户**尚未开通分账**（邀请没发，或商户没点同意）
 * - `403 NO_AUTH` → 服务商自己没开通分账产品
 *
 * `sub_mchid` **只出现在路径上**，再往 query 里带一份会被判为重复映射而报参数错误。
 */
export async function queryProfitSharingConfig(
  api: WechatPayApi,
  cfg: WechatPayConfig,
): Promise<Record<string, unknown> | null> {
  const subMchId = subMchIdOf(cfg)
  return api.call(cfg, {
    method: 'GET',
    path: `/v3/profitsharing/merchant-configs/${subMchId}`,
    allowNotFound: true,
  })
}

/** 分账回退。已分账的订单要退款，必须先把分出去的钱要回来。 */
export async function returnProfitSharing(
  api: WechatPayApi,
  cfg: WechatPayConfig,
  params: {
    outOrderNo: string
    outReturnNo: string
    /** 回退到哪个商户号（通常是当初的接收方，即服务商自己）。 */
    returnMchId: string
    amountCents: number
    description: string
  },
): Promise<Record<string, unknown> | null> {
  const subMchId = subMchIdOf(cfg)
  return api.call(cfg, {
    method: 'POST',
    path: '/v3/profitsharing/return-orders',
    body: {
      sub_mchid: subMchId,
      out_order_no: params.outOrderNo,
      out_return_no: params.outReturnNo,
      return_mchid: params.returnMchId,
      amount: params.amountCents,
      description: params.description.slice(0, 80),
    },
  })
}

/** 查询分账回退。**回退也是异步的**，受理不等于钱已经回到商家账上，退款前必须查证。 */
export async function queryProfitSharingReturn(
  api: WechatPayApi,
  cfg: WechatPayConfig,
  params: { outReturnNo: string; outOrderNo: string },
): Promise<Record<string, unknown> | null> {
  const subMchId = subMchIdOf(cfg)
  return api.call(cfg, {
    method: 'GET',
    path:
      `/v3/profitsharing/return-orders/${encodeURIComponent(params.outReturnNo)}` +
      `?sub_mchid=${subMchId}&out_order_no=${encodeURIComponent(params.outOrderNo)}`,
    allowNotFound: true,
  })
}
