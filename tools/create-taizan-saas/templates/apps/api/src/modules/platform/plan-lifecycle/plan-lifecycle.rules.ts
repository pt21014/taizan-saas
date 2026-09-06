/**
 * 到期提醒档位判定的**纯函数**（T2-7，蓝图 §4.6 到期提醒那一段）。
 *
 * 不碰数据库、不读时钟、不读进程时区——`now`/`daysLeft` 一律由调用方注入，理由与
 * `@taizan/billing-rules`/`plan-order.rules.ts` 一样：档位判定错了不会报错，只会在
 * 某天变成「商家说没收到到期提醒」的客诉，只有纯函数才能被穷举测试。
 *
 * 五个档位、它们对应的 `daysLeft`、模板 key 的拼法，**唯一真源在 `@taizan/prisma-base`**
 * 的 `notify-templates.ts`——本文件只转发这些常量，不再定义第二份，`expire-notify.cron.ts`
 * 与这里各自 import 一次就够。
 *
 * @packageDocumentation
 */

import { DEFAULT_TIMEZONE, calendarDayOf } from '@taizan/billing-rules'
import {
  PLAN_EXPIRE_STAGE_DAYS_LEFT,
  PLAN_EXPIRE_STAGES,
  planExpireInboxKey,
  planExpireSmsKey,
  type PlanExpireStage,
} from '@taizan/prisma-base'

export { PLAN_EXPIRE_STAGE_DAYS_LEFT, PLAN_EXPIRE_STAGES, planExpireInboxKey, planExpireSmsKey }
export type { PlanExpireStage }

// process-local: 纯常量的反向索引（`PLAN_EXPIRE_STAGE_DAYS_LEFT` 的镜像，五个固定条目），
// 不跨请求可变、不跨租户、不需要跨进程一致——每个进程各建一份完全无害，反而是正确的。
/** `daysLeft` → 档位的反向表（`PLAN_EXPIRE_STAGE_DAYS_LEFT` 的镜像，构建一次即可）。 */
const DAYS_LEFT_TO_STAGE: ReadonlyMap<number, PlanExpireStage> = new Map(
  (Object.entries(PLAN_EXPIRE_STAGE_DAYS_LEFT) as [PlanExpireStage, number][]).map(
    ([stage, daysLeft]) => [daysLeft, stage],
  ),
)

/**
 * 按 `evaluateTenantGate().daysLeft` 判定命中哪个到期提醒档位。
 *
 * 只有**恰好**等于某个档位的 `daysLeft` 才命中——cron 每天固定时刻跑一次，
 * `daysLeft` 每天恰好变化 1，五档之间不会重叠也不会漏跳（除非 cron 漏跑了一整天，
 * 那属于运维事故，不该在规则层用「区间匹配」悄悄补偿——补偿逻辑一旦写错就会在
 * 某天连发好几条，还把「有没有漏跑」这件事本身也一起遮住了）。
 *
 * @param daysLeft - `evaluateTenantGate` 算出来的剩余天数；`null`（未开通）永不命中
 * @returns 命中的档位；没有命中任何档位时为 `null`
 */
export function resolveExpireStage(daysLeft: number | null): PlanExpireStage | null {
  if (daysLeft === null) return null
  return DAYS_LEFT_TO_STAGE.get(daysLeft) ?? null
}

/**
 * 幂等键：`notify:plan-expire:{tenantId}:{stage}:{yyyymmdd}`（蓝图 §4.6）。
 *
 * `yyyymmdd` 按时区现算（默认 `Asia/Shanghai`），不用 `now.toISOString()` 直接切片——
 * UTC 切片在 `Asia/Shanghai` 的午夜前后会算出昨天的日期，从而在**同一个自然日**里
 * 因为跨了 UTC 日界而多算一次，那正是幂等键要防的事。
 *
 * @param tenantId - 租户 id
 * @param stage - 命中的档位，见 {@link resolveExpireStage}
 * @param now - 现在
 * @param timezone - 计算「今天是哪天」用的时区
 */
export function planExpireIdempotencyKey(
  tenantId: string,
  stage: PlanExpireStage,
  now: Date,
  timezone: string = DEFAULT_TIMEZONE,
): string {
  const { year, month, day } = calendarDayOf(now, timezone)
  const yyyymmdd = `${String(year).padStart(4, '0')}${pad2(month)}${pad2(day)}`
  return `${tenantId}:${stage}:${yyyymmdd}`
}

/** `IdempotencyService.run` 的 scope：与 key 拼在一起就是蓝图写的那个完整幂等键。 */
export const PLAN_EXPIRE_NOTIFY_SCOPE = 'notify:plan-expire'

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}
