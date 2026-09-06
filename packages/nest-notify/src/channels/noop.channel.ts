/**
 * `NoopChannel`：`MP_TEMPLATE`（公众号模板消息）与 `APP_PUSH`（App 推送）
 * 本阶段的占位驱动。
 *
 * 这两个通道要真正发出去分别依赖 `@taizan/wechat-open`（三级 token 链路，
 * T2-4 在写）与业务侧的推送通道（App 项目自己接极光/个推之类，框架不内置
 * 具体厂商）。TODO：等 `@taizan/wechat-open` 就绪后，在那个包（或装配 app 时）
 * 提供真正的 `NotifyChannelDriver` 实现替换这里的 `NoopChannel`，接口形状
 * （`NotifyChannelDriver`）已经在 `types.ts` 定好，替换时不改 `NotifyService`。
 */
import type { NotifyChannelDriver, NotifyChannelKind, NotifyResult } from '../types'

/** 总是返回失败，`error` 里写清楚原因——不是网络失败，是这个通道还没接驱动。 */
export function createNoopChannel(kind: NotifyChannelKind): NotifyChannelDriver {
  return {
    kind,
    async send(): Promise<NotifyResult> {
      return {
        ok: false,
        channel: kind,
        error: `[@taizan/nest-notify] 通道 "${kind}" 还没有接入真实驱动（TODO：由 wechat-open / app 侧提供）`,
      }
    },
  }
}
