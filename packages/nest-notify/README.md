# @taizan/nest-notify

通知抽象（蓝图 §4.13）：短信 / 站内信 / 公众号模板消息 / App 推送四通道，模板化、
失败进队列重试（3 次指数退避，重试与死信交给 `@taizan/nest-infra`）、
`fallback: true` 时按 `channels` 顺序降级。

## 怎么加一个通知通道

1. 在 `src/channels/` 下新建一个文件，导出一个返回 `NotifyChannelDriver` 的工厂函数：

   ```ts
   import type { NotifyChannelDriver, NotifyMessage, NotifyResult } from '../types'

   export function createEmailChannel(smtpClient: SmtpClient): NotifyChannelDriver {
     return {
       kind: 'EMAIL', // 先在 types.ts 的 NotifyChannelKind 里加上这个字面量
       async send(message: NotifyMessage): Promise<NotifyResult> {
         if (!message.to.email) {
           return { ok: false, channel: 'EMAIL', error: '缺少邮箱地址' }
         }
         try {
           const ref = await smtpClient.send(message.to.email, message.title, message.content)
           return { ok: true, channel: 'EMAIL', vendorRef: ref }
         } catch (err) {
           // 不抛出去——NotifyService 靠 result.ok 决定要不要进重试队列
           return { ok: false, channel: 'EMAIL', error: String(err) }
         }
       },
     }
   }
   ```

2. 装配时把它加进 `NotifyModule.forRoot({ channels: [...] })` 的数组；模板的默认
   通道（`NotifyTemplate.channel`）或调用点的 `channels` 参数写上这个 kind 就会
   被用到。
3. 参考 `channels/sms.channel.ts`：如果这个通道底下也有"多厂商/多次尝试"的概念，
   把每次尝试记进 `NotifyResult.attempts`——`NotifyRecord` 落库时会按它展开成
   多条记录，排障时能看到每一次失败在哪，不是只有最后一次。
4. `MP_TEMPLATE`/`APP_PUSH` 目前是 `NoopChannel`（`channels/noop.channel.ts`），
   等 `@taizan/wechat-open` 或 App 项目侧的真实驱动就绪后，直接换成新驱动，
   不用改 `NotifyService`——它只依赖 `NotifyChannelDriver` 这个接口。

## 关键约定

- **重试与死信不是本包自己数的**：`notify.retry` 用 `@JobHandler` 声明
  `attempts: 3` + 指数退避，交给 `@taizan/nest-infra` 的队列驱动去数第几次、
  几次之后落 `JobDeadLetter`。`NotifyRetryHandler.process()` 只负责"再发一次、
  更新 `NotifyRecord` 状态"，**发送失败必须 `throw`**（`JobProcessor` 的契约）。
- **广播 vs 降级**：`channels` 不传 `fallback` 时是广播——列表里每个通道独立
  尝试，各自的失败各自进重试队列（例如"重要通知"要求短信 + 站内信都收到）。
  `fallback: true` 时是降级——按顺序尝试到第一个成功为止，只有整条链都失败
  才对最后一次尝试的通道入队重试（中间失败是预期内的正常降级，不重复排队）。
- **INBOX 没有外部传输**："发送"就是把 `NotifyRecord`/`PlatformNotifyRecord`
  写进库这个动作本身，落库统一由 `NotifyService` 完成（有 `tenantId` 走
  `prisma.tenant`，没有走 `prisma.raw` 并标 `// raw-reason: ...`），`InboxChannel`
  只需要证明"这个通道总是能送达"。
- **模板参数缺失、模板不存在/已停用一律同步抛错**，不产生任何 `NotifyRecord`——
  这是调用方的编程错误，不是"发送失败"，不该进重试队列。
- **生产环境启用 mock 短信 provider 直接拒启**：`createSmsChannel(options, env)`
  在装配时调 `@taizan/sms` 的 `assertMockNotInProd`，`NODE_ENV=production` 且
  `order` 里出现 `mock` 就抛错，接的是蓝图 §4.10 `assertNoDevCodeInProd` 的思路。
