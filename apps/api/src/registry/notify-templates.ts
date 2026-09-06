/**
 * 通知模板（蓝图 §4.13）。
 *
 * ## 为什么在代码里，而不是只在 `NotifyTemplate` 表里
 *
 * `NotifyModule.forRoot({ templates })` 传了内存模板就完全不查库。本阶段选内存，
 * 因为模板缺失在 `NotifyService` 里是**同步抛错**（那被判定为「调用方的编程错误」，
 * 不是「发送失败」，所以不进重试队列）——一个还没跑过 seed 的开发环境，
 * 第一次发通知就会炸在一个和通知本身无关的地方。
 *
 * 真实项目上线前把这份表 seed 进 `NotifyTemplate` 并去掉 `templates` 入参即可：
 * 那时候运营要能自己改文案，代码里的常量就不该再是真源。
 * **TODO(T2-4)**：接平台后台的模板管理页（seed 本身已经在 T2-7 接进 `seedBase` 了，
 * 见 `@taizan/prisma-base` 的 `packages/prisma-base/src/seed/notify-templates.ts`）。
 *
 * ## 模板 key 单一真源：本文件不再手写 plan.expire.* / plan.fulfilled 这些字符串
 *
 * `@taizan/prisma-base` 的 `notify-templates.ts` 才是这些 key 与文案的真源——它既是
 * `NotifyTemplate` 表 seed 的数据，也是本文件在跑过 seed 之前使用的内存兜底。两边
 * 各写一份 key 拼法迟早会有一处漏改（多一个到期档位、改一个 key 的拼法），所以本文件
 * 直接把 `NOTIFY_TEMPLATE_SEEDS` 转换成 `NotifyTemplateDef` 用，一个字符串都不重抄。
 *
 * `NotifyTemplateSeedSpec.channel` 是 `08-notify.prisma` 的 DB 枚举字面量
 * （`IN_APP`/`WECHAT_MP`……），`NotifyTemplateDef.channel` 是 `@taizan/nest-notify` 的
 * `NotifyChannelKind`（`INBOX`/`MP_TEMPLATE`……）——两套命名不同，转换用该包导出的
 * `fromDbNotifyChannel`（就是 T1-5 那条真实 bug 的根治面，见 `channel-map.ts`）。
 *
 * ## 它不是「五张注册表」的第六张
 *
 * 五张注册表（权限点 / 菜单 / 套餐功能项 / 审计动作 / 队列任务）的共同点是
 * 「代码是真源、DB 只是镜像」。通知模板恰恰相反——它最终归运营管。
 * 放在 `registry/` 目录下只是因为它同样是「一份全应用的清单」，
 * `registry/index.ts` **刻意不导出它**，免得把这条差别抹平。
 *
 * @packageDocumentation
 */

import { fromDbNotifyChannel, type NotifyTemplateDef } from '@taizan/nest-notify'
import { NOTIFY_TEMPLATE_SEEDS } from '@taizan/prisma-base'

/**
 * 到期提醒五档（`plan.expire.-7/-3/-1/0/+3` 及各自的 `.sms` 版）+ `plan.fulfilled`
 * + `tenant.suspended` + `signup.welcome`（各含 INBOX/SMS 两版）——全部来自
 * `@taizan/prisma-base` 的 `NOTIFY_TEMPLATE_SEEDS`，逐条转换成本包要的 `NotifyTemplateDef` 形状。
 */
const PLAN_LIFECYCLE_TEMPLATES: Record<string, NotifyTemplateDef> = Object.fromEntries(
  NOTIFY_TEMPLATE_SEEDS.map((spec) => [
    spec.key,
    {
      title: spec.title,
      content: spec.content,
      channel: fromDbNotifyChannel(spec.channel),
      enabled: true,
    } satisfies NotifyTemplateDef,
  ]),
)

/** 全应用通知模板。key 用 `模块.事件` 形式，与审计动作码同一套书写习惯。 */
export const NOTIFY_TEMPLATES: Record<string, NotifyTemplateDef> = {
  'goods.sync-failed': {
    title: '商品同步失败',
    content: '商品「{{name}}」同步到渠道时失败了：{{reason}}。请在后台重试。',
    // 站内信：这条是给店里的人看的运维提示，值不上一条短信钱。
    channel: 'INBOX',
    enabled: true,
  },
  // plan.expire.* / plan.fulfilled / plan.fulfilled.sms / tenant.suspended(.sms) /
  // signup.welcome(.sms) —— 见上面 PLAN_LIFECYCLE_TEMPLATES 的文件头说明。
  ...PLAN_LIFECYCLE_TEMPLATES,
}
