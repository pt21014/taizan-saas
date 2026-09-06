/**
 * 通知模板 seed（T2-7，蓝图 §4.13 / §4.6 到期提醒那一段）。
 *
 * ## 为什么模板 key 的常量放在这里，而不是 `apps/api`
 *
 * 到期提醒的五个档位（T-7/T-3/T-1/T+0/T+3）、幂等键 `notify:plan-expire:{tenantId}:{stage}:{yyyymmdd}`
 * 里的 `stage`、以及 cron 要发的 `templateKey` 全部依赖同一份「档位 → key」的映射。这份映射如果在
 * `apps/api` 的 cron 文件里手写一份、又在 `apps/api` 的 `registry/notify-templates.ts` 里手写一份，
 * 两份迟早会有一处漏改（多一个档位、改一个 key 的拼法）——所以本文件是**唯一真源**，
 * `apps/api` 的 cron 与 in-memory 模板注册表都从这里 `import` 常量，不允许各自拼字符串。
 *
 * ## 每个模板两版文案：INBOX 与 SMS
 *
 * 站内信可以写长一点（商家在后台里看），短信要按条计费、且有字数限制，所以每个语义
 * 都拆成两个 `NotifyTemplate` key（`xxx` 给 INBOX、`xxx.sms` 给 SMS），而不是一个 key
 * 配两种正文——`NotifyTemplate.channel` 是单列，一行只能对应一个通道
 * （见 `08-notify.prisma`），调用方要两条通道都发就得指定两个 templateKey 各发一次。
 *
 * ## 这不是「五张注册表」的第六张
 *
 * 权限点/菜单/套餐功能项/审计动作/队列任务那五张是「代码是真源、DB 只是镜像」；
 * 通知模板反过来——最终该归运营在平台后台改（`apps/api/src/registry/notify-templates.ts`
 * 文件头的 TODO(T2-4)）。本文件产出的既是「DB seed 的初始文案」，也是「代码侧常量的
 * 单一真源」：只要 key 不变，运营在后台把文案改了，代码这边一个字都不用跟着改。
 *
 * @packageDocumentation
 */

import type { SeedDelegate } from './types'

/** 到期提醒的五个档位，字面量与蓝图 §4.6 的 T-7/T-3/T-1/T+0/T+3 一一对应。 */
export const PLAN_EXPIRE_STAGES = ['-7', '-3', '-1', '0', '+3'] as const

/** 一个到期提醒档位。 */
export type PlanExpireStage = (typeof PLAN_EXPIRE_STAGES)[number]

/**
 * 档位 → `evaluateTenantGate().daysLeft` 应该等于的值。
 *
 * `daysLeft` 正数=还剩几天、`0`=今天到期、负数=已过期几天，跟"T-7 表示到期前 7 天"
 * 这种人话方向刚好相反，所以要有一张显式的表，不能指望阅读代码的人自己心算符号。
 */
export const PLAN_EXPIRE_STAGE_DAYS_LEFT: Readonly<Record<PlanExpireStage, number>> = {
  '-7': 7,
  '-3': 3,
  '-1': 1,
  '0': 0,
  '+3': -3,
}

/** 站内信模板 key：`plan.expire.<stage>`。 */
export function planExpireInboxKey(stage: PlanExpireStage): string {
  return `plan.expire.${stage}`
}

/** 短信模板 key：`plan.expire.<stage>.sms`。 */
export function planExpireSmsKey(stage: PlanExpireStage): string {
  return `plan.expire.${stage}.sms`
}

/** 到期提醒之外的模板 key。 */
export const NOTIFY_TEMPLATE_KEYS = {
  /** 套餐兑现成功（T1-5 的 `plan-order.service.ts` 用）。 */
  PLAN_FULFILLED: 'plan.fulfilled',
  PLAN_FULFILLED_SMS: 'plan.fulfilled.sms',
  /** 租户被平台冻结。 */
  TENANT_SUSPENDED: 'tenant.suspended',
  TENANT_SUSPENDED_SMS: 'tenant.suspended.sms',
  /** 自助注册成功的欢迎通知。 */
  SIGNUP_WELCOME: 'signup.welcome',
  SIGNUP_WELCOME_SMS: 'signup.welcome.sms',
} as const

/**
 * 一条模板 seed 数据。`channel` 用的是 **DB 枚举字面量**（`08-notify.prisma` 的
 * `NotifyChannelKind`：`SMS`/`IN_APP`……），不是 `@taizan/nest-notify` 的
 * `NotifyChannelKind`（`SMS`/`INBOX`……）——本包不依赖 `@taizan/nest-notify`，
 * 两套字面量的转换见该包的 `channel-map.ts`。
 */
export interface NotifyTemplateSeedSpec {
  key: string
  channel: 'SMS' | 'IN_APP'
  title: string
  content: string
}

function expireStageCopy(stage: PlanExpireStage): { inbox: string; sms: string } {
  switch (stage) {
    case '-7':
      return {
        inbox:
          '您的店铺「{{shopName}}」套餐将于 {{expireAt}} 到期（还剩 {{daysLeft}} 天），' +
          '请及时续费，到期后后台将转为只读、C 端将打烊。',
        sms: '【{{shopName}}】您的套餐还剩 {{daysLeft}} 天到期（{{expireAt}}），请及时续费。',
      }
    case '-3':
      return {
        inbox:
          '您的店铺「{{shopName}}」套餐将于 {{expireAt}} 到期（还剩 {{daysLeft}} 天），' +
          '请尽快续费，避免到期后影响正常营业。',
        sms: '【{{shopName}}】您的套餐还剩 {{daysLeft}} 天到期（{{expireAt}}），请尽快续费。',
      }
    case '-1':
      return {
        inbox:
          '您的店铺「{{shopName}}」套餐明天（{{expireAt}}）到期，到期后后台将转为只读、' +
          'C 端将打烊，续费入口不受影响。',
        sms: '【{{shopName}}】您的套餐明天（{{expireAt}}）到期，请尽快续费。',
      }
    case '0':
      return {
        inbox:
          '您的店铺「{{shopName}}」套餐今天（{{expireAt}}）到期，到期后后台将转为只读、' +
          'C 端将打烊，续费后立即恢复。',
        sms: '【{{shopName}}】您的套餐今天到期，到期后将转为只读，请尽快续费。',
      }
    case '+3':
      return {
        inbox:
          '您的店铺「{{shopName}}」套餐已于 {{expireAt}} 到期（已过 {{daysLeft}} 天），' +
          '后台目前只读、C 端已打烊，请尽快续费以恢复正常使用。',
        sms: '【{{shopName}}】您的套餐已到期，后台已只读，请尽快续费恢复使用。',
      }
  }
}

/** 到期提醒五档 × 两通道 = 10 条。 */
function planExpireSeeds(): NotifyTemplateSeedSpec[] {
  return PLAN_EXPIRE_STAGES.flatMap((stage) => {
    const copy = expireStageCopy(stage)
    return [
      {
        key: planExpireInboxKey(stage),
        channel: 'IN_APP' as const,
        title: '套餐到期提醒',
        content: copy.inbox,
      },
      {
        key: planExpireSmsKey(stage),
        channel: 'SMS' as const,
        title: '套餐到期提醒',
        content: copy.sms,
      },
    ]
  })
}

/** 到期提醒之外的 6 条（3 个语义 × 2 通道）。 */
const OTHER_SEEDS: readonly NotifyTemplateSeedSpec[] = [
  {
    key: NOTIFY_TEMPLATE_KEYS.PLAN_FULFILLED,
    channel: 'IN_APP',
    title: '套餐已开通',
    content:
      '您购买的「{{planName}}」已开通 {{periods}} 个周期（实付 {{amountYuan}} 元），' +
      '有效期至 {{expireAt}}。',
  },
  {
    key: NOTIFY_TEMPLATE_KEYS.PLAN_FULFILLED_SMS,
    channel: 'SMS',
    title: '套餐已开通',
    content: '【{{shopName}}】您购买的「{{planName}}」已开通，有效期至 {{expireAt}}。',
  },
  {
    key: NOTIFY_TEMPLATE_KEYS.TENANT_SUSPENDED,
    channel: 'IN_APP',
    title: '店铺已冻结',
    content: '您的店铺「{{shopName}}」已被平台冻结，后台与 C 端均不可用，如有疑问请联系客服。',
  },
  {
    key: NOTIFY_TEMPLATE_KEYS.TENANT_SUSPENDED_SMS,
    channel: 'SMS',
    title: '店铺已冻结',
    content: '【{{shopName}}】您的店铺已被冻结，如有疑问请联系客服。',
  },
  {
    key: NOTIFY_TEMPLATE_KEYS.SIGNUP_WELCOME,
    channel: 'IN_APP',
    title: '欢迎注册',
    content: '欢迎注册「{{shopName}}」！试用期至 {{trialEndAt}}，祝生意兴隆。',
  },
  {
    key: NOTIFY_TEMPLATE_KEYS.SIGNUP_WELCOME_SMS,
    channel: 'SMS',
    title: '欢迎注册',
    content: '【{{shopName}}】欢迎注册，试用期至 {{trialEndAt}}。',
  },
]

/** 全部 16 条模板 seed 数据：到期提醒 10 条 + 其它 6 条。 */
export const NOTIFY_TEMPLATE_SEEDS: readonly NotifyTemplateSeedSpec[] = [
  ...planExpireSeeds(),
  ...OTHER_SEEDS,
]

/** {@link seedNotifyTemplates} 的入参。 */
export interface SeedNotifyTemplatesInput {
  /** `prisma.notifyTemplate` */
  delegate: SeedDelegate
  /** 主键生成器。 */
  newId: () => string
  /** 要写入的模板，默认 {@link NOTIFY_TEMPLATE_SEEDS}。 */
  specs?: readonly NotifyTemplateSeedSpec[]
}

/**
 * 幂等地写入通知模板。
 *
 * 与套餐 seed 同一个取舍：**每次都覆盖** `title`/`content`/`channel`/`enabled`——
 * 这是框架给的初始文案，不是运营已经改过的产物；本地/CI 环境每次 seed 都该拿到
 * 与代码一致的最新文案，而不是停留在第一次跑的那个版本。
 *
 * `NotifyTemplate.key` 是单列唯一索引，`upsert` 直接按它定位，不需要
 * `findFirstUpsertDelegate` 那种「唯一键带 deletedAt」的绕行（`NotifyTemplate`
 * 是平台域镜像表，没有软删）。
 *
 * @returns 写入的模板条数
 */
export async function seedNotifyTemplates(input: SeedNotifyTemplatesInput): Promise<number> {
  const specs = input.specs ?? NOTIFY_TEMPLATE_SEEDS
  for (const spec of specs) {
    const payload = {
      channel: spec.channel,
      title: spec.title,
      content: spec.content,
      enabled: true,
    }
    await input.delegate.upsert({
      where: { key: spec.key },
      create: { id: input.newId(), key: spec.key, ...payload },
      update: payload,
    })
  }
  return specs.length
}
