/**
 * Mock 短信 provider：只记录、不发送。
 *
 * 存在的理由：本地开发与 CI 里没有真实短信配额，也不该真的发短信出去。
 * 但**生产环境启用它是一次事故**——验证码会被静默"发送成功"而用户什么都收不到。
 * `assertMockNotInProd` 就是接口设计蓝图 §4.10 `assertNoDevCodeInProd` 思路在本包的落点：
 * 启动时检查一次，生产环境误配直接拒启，而不是等到有人投诉收不到验证码才发现。
 */
import type { SmsProvider, SmsResult, SmsSendRequest } from '../provider'

/** mock 记下的一条发送。 */
export interface MockSmsRecord {
  req: SmsSendRequest
  at: Date
}

/**
 * Mock provider。`sent` 数组按发送顺序记录，供测试断言；不做任何网络调用。
 */
export class MockSmsProvider implements SmsProvider<Record<string, never>> {
  readonly name = 'mock'

  // process-local: 只在单个测试/开发进程里累积，重启即清空，不是持久记录。
  readonly sent: MockSmsRecord[] = []

  async send(req: SmsSendRequest): Promise<SmsResult> {
    this.sent.push({ req, at: new Date() })
    return { ok: true, provider: this.name, vendorRef: `mock-${this.sent.length}` }
  }

  /** 清空记录，测试之间复用同一个实例时用。 */
  reset(): void {
    this.sent.length = 0
  }
}

/** 判定"是不是生产环境"用得到的最小环境形状。 */
export interface ProdCheckEnv {
  NODE_ENV?: string
}

/**
 * 生产环境启用 mock provider 直接拒启。
 *
 * @param env - 一般传 `process.env` 或框架的 `ConfigService` 快照
 * @param enabledProviderNames - 当前装配启用的 provider 名列表（含 primary 与 fallbacks）
 * @throws `NODE_ENV === 'production'` 且启用列表里出现 `'mock'` 时抛
 */
export function assertMockNotInProd(env: ProdCheckEnv, enabledProviderNames: string[]): void {
  if (env.NODE_ENV === 'production' && enabledProviderNames.includes('mock')) {
    throw new Error(
      '[@taizan/sms] 生产环境（NODE_ENV=production）检测到启用了 mock 短信 provider，' +
        '验证码会被静默"发送成功"而用户收不到——拒绝启动。请检查 SMS_PRIMARY_PROVIDER / ' +
        'SMS_FALLBACK_PROVIDERS 等配置。',
    )
  }
}
