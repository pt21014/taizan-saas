/**
 * SMS 通道：走 `@taizan/sms` 的 `SmsProviderRegistry`。
 *
 * 主/备厂商切换（余额不足自动换厂商）是 `@taizan/sms` 自己的职责
 * （`registry.sendWithFallback`），这一层只是把 `NotifyMessage` 适配成
 * `SmsSendRequest`，并把多次尝试记录透传出去供 `NotifyService` 落库时参考。
 */
import {
  assertMockNotInProd,
  type ProdCheckEnv,
  type SmsFallbackOrder,
  type SmsProviderRegistry,
} from '@taizan/sms'
import type { NotifyChannelDriver, NotifyMessage, NotifyResult } from '../types'

export interface SmsChannelOptions {
  registry: SmsProviderRegistry
  /** 每个 provider 名对应的配置对象，透传给 `@taizan/sms`。 */
  cfgByProvider: Record<string, unknown>
  order: SmsFallbackOrder
  /** 短信签名，模板没单独指定时用它。 */
  signName?: string
}

/**
 * @throws 生产环境的 `order` 里出现 `mock` provider 时抛（`assertMockNotInProd`，
 *   蓝图 §4.10 `assertNoDevCodeInProd` 思路在本包的落点：验证码/通知短信被静默
 *   "发送成功"而用户收不到，必须在装配那一刻就拒启，不是运行时才发现）。
 */
export function createSmsChannel(
  options: SmsChannelOptions,
  env: ProdCheckEnv,
): NotifyChannelDriver {
  assertMockNotInProd(env, [options.order.primary, ...(options.order.fallbacks ?? [])])

  return {
    kind: 'SMS',
    async send(message: NotifyMessage): Promise<NotifyResult> {
      const phone = message.to.phone
      if (!phone) {
        return { ok: false, channel: 'SMS', error: '缺少手机号（NotifyTarget.phone）' }
      }
      const { result, attempts } = await options.registry.sendWithFallback(
        {
          phone,
          templateKey: message.templateKey,
          params: message.vars,
          signName: options.signName,
        },
        options.cfgByProvider,
        options.order,
      )
      return {
        ok: result.ok,
        channel: 'SMS',
        vendorRef: result.vendorRef,
        error: result.error,
        // 主厂商失败切备用时 attempts.length === 2；写库时会按它展开成两条记录。
        attempts: attempts.map((a) => ({
          ok: a.result.ok,
          label: a.provider,
          vendorRef: a.result.vendorRef,
          error: a.result.error,
        })),
      }
    },
  }
}
