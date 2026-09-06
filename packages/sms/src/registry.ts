/**
 * `SmsProviderRegistry`：按 name 登记 provider，`sendWithFallback` 按
 * `primary`/`fallbacks` 顺序发送，主厂商失败自动切备用。
 *
 * 每次尝试都记下来（{@link SmsAttempt}），不管最终成不成功——这是
 * `@taizan/nest-notify` 落 `NotifyRecord` 需要的数据：一条通知底下如果切换过
 * 厂商，两次尝试都要能在排障时看到，不能只留最后一次。
 */
import type { SmsProvider, SmsResult, SmsSendRequest } from './provider'

/** 一次尝试的记录。 */
export interface SmsAttempt {
  provider: string
  result: SmsResult
}

/** `sendWithFallback` 的顺序声明。 */
export interface SmsFallbackOrder {
  /** 首选 provider 名。 */
  primary: string
  /** 主厂商失败后依次尝试的备用 provider 名，可以为空数组。 */
  fallbacks?: string[]
}

/** `sendWithFallback` 的返回值。 */
export interface SmsSendOutcome {
  /** 最终生效的那次结果（第一个 `ok: true` 的尝试；全部失败则是最后一次）。 */
  result: SmsResult
  /** 按尝试顺序排列的全部记录，长度 ≥ 1。 */
  attempts: SmsAttempt[]
}

export class SmsProviderRegistry {
  private readonly providers = new Map<string, SmsProvider>()

  /** 登记一个 provider。同名重复登记会覆盖前一个——通常只在测试里这么用。 */
  register(provider: SmsProvider): this {
    this.providers.set(provider.name, provider)
    return this
  }

  /** 取一个已登记的 provider。 */
  get(name: string): SmsProvider {
    const provider = this.providers.get(name)
    if (!provider) {
      throw new Error(`[@taizan/sms] 未登记的短信 provider："${name}"`)
    }
    return provider
  }

  /** 已登记的 provider 名列表。 */
  names(): string[] {
    return [...this.providers.keys()]
  }

  /**
   * 按 `order.primary` → `order.fallbacks` 依次尝试发送，第一个成功的即返回。
   *
   * @param cfgByProvider - 每个 provider 名对应的配置对象（各家配置形状不同，见 `provider.ts`）
   * @throws `order` 里出现未登记的 provider 名，或某个 provider 缺配置时抛
   */
  async sendWithFallback(
    req: SmsSendRequest,
    cfgByProvider: Record<string, unknown>,
    order: SmsFallbackOrder,
  ): Promise<SmsSendOutcome> {
    const chain = [order.primary, ...(order.fallbacks ?? [])]
    if (chain.length === 0) {
      throw new Error('[@taizan/sms] sendWithFallback 至少需要一个 primary')
    }

    const attempts: SmsAttempt[] = []
    for (const name of chain) {
      const provider = this.get(name)
      if (!(name in cfgByProvider)) {
        throw new Error(`[@taizan/sms] provider "${name}" 缺少配置（cfgByProvider 里没有这一项）`)
      }
      const result = await provider.send(req, cfgByProvider[name])
      attempts.push({ provider: name, result })
      if (result.ok) {
        return { result, attempts }
      }
    }
    // 全部失败：返回最后一次的结果，attempts 里能看到每一次都失败在哪
    return { result: attempts[attempts.length - 1]!.result, attempts }
  }
}
