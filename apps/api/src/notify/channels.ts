/**
 * 通知通道的装配（蓝图 §4.13）。
 *
 * ## 本阶段只装两条通道，为什么是这两条
 *
 * - **INBOX（站内信）**：没有外部依赖，永远送得到。它是「通知这件事真的接上了」的
 *   最小证据——`NotifyService` 会为每个通道写一行 `NotifyRecord`，站内信的「发送」
 *   本身就是那次写库。
 * - **SMS（mock provider）**：短信是唯一一条会真的花钱、也真的会在生产上出事的通道。
 *   本地/CI 用 `MockSmsProvider` 记账不发送，而 `createSmsChannel` 在装配时就会调
 *   `assertMockNotInProd`——`NODE_ENV=production` 还挂着 mock 直接拒启。
 *   把这条链路现在就接上，是为了让「换成真厂商」变成改一处配置，而不是改一处代码。
 *
 * `MP_TEMPLATE` / `APP_PUSH` 现在**一个都不装**，而不是装成 noop：装了 noop 的后果是
 * 业务代码可以照常 `channels: ['APP_PUSH']` 并拿到 `ok: true`，
 * 于是「推送没到」变成一个看不出来的状态。不装的话 `NotifyService` 会直接抛
 * 「通道没有登记驱动」——这才是那时候该发生的事。
 *
 * @packageDocumentation
 */

import { createInboxChannel, createSmsChannel, type NotifyChannelDriver } from '@taizan/nest-notify'
import { MockSmsProvider, SmsProviderRegistry, type ProdCheckEnv } from '@taizan/sms'

/**
 * 短信签名。真实项目里应当来自 env / 租户凭据表；mock provider 用不到它，
 * 留在这里是为了换真厂商时能一眼看到「这个位置需要一个值」。
 */
const SMS_SIGN_NAME = 'taizan-saas'

/**
 * 建通知通道列表。
 *
 * @param env - 用来判定「是不是生产环境」，一般传 `process.env`
 * @throws 生产环境仍然挂着 mock 短信 provider 时抛（`assertMockNotInProd`）
 */
export function createNotifyChannels(env: ProdCheckEnv): NotifyChannelDriver[] {
  const registry = new SmsProviderRegistry().register(new MockSmsProvider())

  return [
    createInboxChannel(),
    createSmsChannel(
      {
        registry,
        cfgByProvider: { mock: {} },
        // 没有 fallbacks：只有一家 mock，写一个假的备用只会让「切换真的发生过没有」
        // 变得不可验证。接真厂商时这里才有第二项。
        order: { primary: 'mock' },
        signName: SMS_SIGN_NAME,
      },
      env,
    ),
  ]
}
