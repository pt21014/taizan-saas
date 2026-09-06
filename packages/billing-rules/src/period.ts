/**
 * 续期日期计算：时区感知的「落到当天 23:59:59」与 `max(原到期日, now) + periods×periodMonths`。
 *
 * 本文件是 `@taizan/billing-rules` 里唯一碰日历的地方，闸门（`gate.ts`）的时区判断也从这里取工具函数。
 *
 * ## 三条本文件自己的取舍
 *
 * **① 不依赖进程时区。** `new Date().getHours()` 在本地开发（Asia/Shanghai）与生产容器（多半是 UTC）
 * 会算出差 8 小时的「当天」，商家会在到期当天的晚上 8 点被锁。所有「当天」都用 `Intl.DateTimeFormat`
 * 显式指定时区算，默认 {@link DEFAULT_TIMEZONE}，可按租户/部署覆盖。
 *
 * **② 到期时刻取当天的 `23:59:59.999`，不是 `23:59:59.000`。** 蓝图写的是「落当天 23:59:59」，
 * 但如果真存 `.000`，商家在 `23:59:59.500` 这半秒里会被判到期——写文档的人想说的是「当天整天都还能用」，
 * 那就必须把这一秒的尾巴也含进去。对外的一切表述仍是「当天 23:59:59 到期」。
 *
 * **③ 加月按「日历月 + 月末夹逼」。** `1/31 + 1 个月 = 2/28`（闰年 `2/29`），不是 `3/2`。
 * 按 30 天折算会让买 12 个月的商家少 5 天，按 31 天折算会让平台每年白送 6 天——
 * 两种都会在对账时被发现，而日历月是商家和发票上都写着的那个口径。
 */

/**
 * 默认时区。整个框架的「当天」都按这个时区算，除非调用方显式传入别的。
 *
 * 之所以给默认值而不是强制必传：闸门挂在每个请求上，漏传一个参数的代价是整仓 500，
 * 而绝大多数部署就是这一个时区。真要按租户分时区，把租户的时区透传进来即可。
 */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai'

/** 一天的毫秒数。 */
export const DAY_MS = 24 * 60 * 60 * 1000

/** 一张订单一次最多能买几个周期。防「把金额乘炸」的手滑护栏，不是业务需要。 */
export const MAX_PERIODS_PER_ORDER = 120

/** 某个时区里的墙上时间分量（年月日时分秒，1 基月份）。 */
export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/** 某个时区里的日历日（年月日，1 基月份）。 */
export interface CalendarDay {
  year: number
  month: number
  day: number
}

// process-local: Intl.DateTimeFormat 构造一次要几毫秒，而闸门挂在每个请求上。
// 这里缓存的是纯函数式的格式化器（无状态、与租户无关），多实例各缓存各的没有一致性问题。
const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone)
  if (cached !== undefined) return cached
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    throw new RangeError(`[@taizan/billing-rules] 无法识别的时区：${String(timeZone)}`)
  }
  formatterCache.set(timeZone, formatter)
  return formatter
}

/** 校验 Date 参数：`undefined` / 非 Date / Invalid Date 一律当作调用方的 bug，当场抛错而不是静默算出 NaN。 */
export function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`[@taizan/billing-rules] ${label} 必须是合法的 Date`)
  }
}

function assertNonNegativeInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`[@taizan/billing-rules] ${label} 必须是非负整数，收到 ${String(value)}`)
  }
}

function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`[@taizan/billing-rules] ${label} 必须是正整数，收到 ${String(value)}`)
  }
}

/** `Date.UTC` 对 0–99 的年份会自动加 1900，这里绕开那个历史包袱。 */
function utcFromParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
): number {
  const ts = Date.UTC(year, month - 1, day, hour, minute, second, ms)
  if (year >= 0 && year < 100) {
    const d = new Date(ts)
    d.setUTCFullYear(year)
    return d.getTime()
  }
  return ts
}

/**
 * 把一个瞬间换算成指定时区里的墙上时间分量。
 *
 * @param date - 时间点（UTC 瞬间）
 * @param timeZone - IANA 时区名，如 `Asia/Shanghai`
 */
export function zonedParts(date: Date, timeZone: string = DEFAULT_TIMEZONE): ZonedParts {
  assertValidDate(date, 'date')
  const parts = formatterFor(timeZone).formatToParts(date)
  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type)
    if (found === undefined) {
      throw new RangeError(`[@taizan/billing-rules] 时区 ${timeZone} 无法解析出 ${type}`)
    }
    return Number(found.value)
  }
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour'),
    minute: pick('minute'),
    second: pick('second'),
  }
}

/** 指定时区在某个瞬间相对 UTC 的偏移毫秒数（东八区为 `+8h`）。 */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone)
  const asUtc = utcFromParts(p.year, p.month, p.day, p.hour, p.minute, p.second, 0)
  // 分量里没有毫秒，比较基准也截到秒，避免把亚秒当成偏移量。
  return asUtc - Math.floor(date.getTime() / 1000) * 1000
}

/**
 * 把「某时区的墙上时间」还原成 UTC 瞬间。两趟迭代是为了跨 DST 边界时收敛
 * （Asia/Shanghai 没有夏令时，但这个包不该只在一个时区里正确）。
 */
function wallClockToInstant(
  day: CalendarDay,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  timeZone: string,
): Date {
  const guess = utcFromParts(day.year, day.month, day.day, hour, minute, second, ms)
  let ts = guess - zoneOffsetMs(new Date(guess), timeZone)
  ts = guess - zoneOffsetMs(new Date(ts), timeZone)
  return new Date(ts)
}

/** 取某个瞬间在指定时区里的日历日。 */
export function calendarDayOf(date: Date, timeZone: string = DEFAULT_TIMEZONE): CalendarDay {
  const p = zonedParts(date, timeZone)
  return { year: p.year, month: p.month, day: p.day }
}

/** 某年某月有几天（1 基月份）。 */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * 日历日加月，月末夹逼：`1/31 + 1` → `2/28`（闰年 `2/29`）、`1/31 + 3` → `4/30`。
 *
 * 夹逼是单向的：夹过之后不会再「弹回去」，`1/31 + 1 + 1` 走两次是 `3/28`，
 * 一次 `+2` 是 `3/31`。所以续费一律一次性 `periods × periodMonths` 地加，不许循环调用。
 */
export function addCalendarMonths(day: CalendarDay, months: number): CalendarDay {
  if (!Number.isInteger(months)) {
    throw new RangeError(`[@taizan/billing-rules] months 必须是整数，收到 ${String(months)}`)
  }
  const total = day.year * 12 + (day.month - 1) + months
  const year = Math.floor(total / 12)
  const month = total - year * 12 + 1
  return { year, month, day: Math.min(day.day, daysInMonth(year, month)) }
}

/** 日历日加天。 */
export function addCalendarDays(day: CalendarDay, days: number): CalendarDay {
  if (!Number.isInteger(days)) {
    throw new RangeError(`[@taizan/billing-rules] days 必须是整数，收到 ${String(days)}`)
  }
  // 用正午做基准点，跨月/跨年的进位交给 Date 自己算。
  const ts = utcFromParts(day.year, day.month, day.day, 12, 0, 0, 0) + days * DAY_MS
  const d = new Date(ts)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/** 把一个日历日落到该时区当天的最后一刻（`23:59:59.999`，见文件头取舍 ②）。 */
export function endOfCalendarDay(day: CalendarDay, timeZone: string = DEFAULT_TIMEZONE): Date {
  return wallClockToInstant(day, 23, 59, 59, 999, timeZone)
}

/** 把一个日历日落到该时区当天的第一刻（`00:00:00.000`）。 */
export function startOfCalendarDay(day: CalendarDay, timeZone: string = DEFAULT_TIMEZONE): Date {
  return wallClockToInstant(day, 0, 0, 0, 0, timeZone)
}

/** 把一个瞬间推到它所在那一天（按指定时区）的最后一刻。 */
export function endOfDayInZone(date: Date, timeZone: string = DEFAULT_TIMEZONE): Date {
  return endOfCalendarDay(calendarDayOf(date, timeZone), timeZone)
}

/**
 * 两个瞬间之间差几个「日历日」（按指定时区），`to - from`。
 *
 * 刻意按日历日而不是 `(t2-t1)/86400000` 取整：商家看到的「还有 3 天到期」指的是翻 3 次日历，
 * 而不是 72 小时。23:00 和次日 01:00 只差 2 小时，但它是「1 天」。
 */
export function diffCalendarDays(
  from: Date,
  to: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): number {
  const a = calendarDayOf(from, timeZone)
  const b = calendarDayOf(to, timeZone)
  const ta = utcFromParts(a.year, a.month, a.day, 12, 0, 0, 0)
  const tb = utcFromParts(b.year, b.month, b.day, 12, 0, 0, 0)
  return Math.round((tb - ta) / DAY_MS)
}

/** {@link computeRenewal} 的入参。 */
export interface ComputeRenewalInput {
  /** 租户当前到期日；`null` = 从未开通过。 */
  currentExpireAt: Date | null
  /** 本次计算的「现在」。由调用方注入，规则函数自己不读时钟。 */
  now: Date
  /** 买几个周期（正整数，上限 {@link MAX_PERIODS_PER_ORDER}）。 */
  periods: number
  /** 一个周期几个月（正整数，取自 `Plan.periodMonths`）。 */
  periodMonths: number
  /** 计算「当天」用的时区，默认 {@link DEFAULT_TIMEZONE}。 */
  timezone?: string
}

/** {@link computeRenewal} 的结果。两个字段直接落 `PlanOrder.expireBeforeAt` / `expireAfterAt`。 */
export interface ComputeRenewalResult {
  /** 履约前的到期日（原样回传 `currentExpireAt`）。退款回退就退到这里。 */
  expireBeforeAt: Date | null
  /** 履约后的新到期日，落在该时区当天的最后一刻。 */
  expireAfterAt: Date
}

/**
 * 续期后的新到期日 = `max(原到期日, now)` 起加 `periods × periodMonths` 个日历月，落到当天最后一刻。
 *
 * 取 `max` 同时照顾两种人（这条从 knowledge 原样搬过来，是踩过的坑）：
 * - **提前续的**：从原到期日往后加，不会因为早付钱反而少享受几天；
 * - **断了几个月才回来的**：从今天起算，不该为没享受服务的那几个月付费。
 *
 * 少了 `max`，前者被吞掉未到期的天数，后者买完还是过期状态——后者尤其恶劣：
 * 商家付了钱，后台还锁着，他只会认为平台在骗钱。
 *
 * @param input - 见 {@link ComputeRenewalInput}
 * @returns `{ expireBeforeAt, expireAfterAt }`，直接落订单两列，退款时按 `expireBeforeAt` 回退
 * @throws RangeError - `periods` / `periodMonths` 不是正整数，或 `periods` 超过 {@link MAX_PERIODS_PER_ORDER}
 *
 * @example
 * ```ts
 * // 2026-01-31 到期，续 1 个月 → 2026-02-28 23:59:59.999（+08:00）
 * computeRenewal({
 *   currentExpireAt: new Date('2026-01-31T15:59:59.999Z'),
 *   now: new Date('2026-01-10T00:00:00Z'),
 *   periods: 1,
 *   periodMonths: 1,
 * })
 * ```
 */
export function computeRenewal(input: ComputeRenewalInput): ComputeRenewalResult {
  const { currentExpireAt, now, periods, periodMonths } = input
  const timeZone = input.timezone ?? DEFAULT_TIMEZONE
  assertValidDate(now, 'now')
  if (currentExpireAt !== null) assertValidDate(currentExpireAt, 'currentExpireAt')
  assertPositiveInt(periods, 'periods')
  assertPositiveInt(periodMonths, 'periodMonths')
  if (periods > MAX_PERIODS_PER_ORDER) {
    throw new RangeError(
      `[@taizan/billing-rules] periods 不得超过 ${MAX_PERIODS_PER_ORDER}，收到 ${String(periods)}`,
    )
  }

  // 到期当天整天仍算未到期（见 gate.ts），所以「原到期日是否还有效」也按当天最后一刻比。
  const currentEnd = currentExpireAt === null ? null : endOfDayInZone(currentExpireAt, timeZone)
  const base = currentEnd !== null && currentEnd.getTime() > now.getTime() ? currentEnd : now

  const expireAfterAt = endOfCalendarDay(
    addCalendarMonths(calendarDayOf(base, timeZone), periods * periodMonths),
    timeZone,
  )
  return { expireBeforeAt: currentExpireAt, expireAfterAt }
}

/**
 * 试用到期时刻 = `now` 起 `trialDays` 天后的当天最后一刻。
 *
 * `trialDays = 0` 表示「今天用完就到期」（当天最后一刻），不是「立刻到期」——
 * 注册即到期的租户会在开店的第一分钟看到打烊页，那是配置错误的表现，不该由规则函数复现。
 *
 * @param now - 现在
 * @param trialDays - 试用天数（非负整数）
 * @param timezone - 时区，默认 {@link DEFAULT_TIMEZONE}
 */
export function computeTrialEnd(
  now: Date,
  trialDays: number,
  timezone: string = DEFAULT_TIMEZONE,
): Date {
  assertValidDate(now, 'now')
  assertNonNegativeInt(trialDays, 'trialDays')
  return endOfCalendarDay(addCalendarDays(calendarDayOf(now, timezone), trialDays), timezone)
}

/** {@link computeRefundRollback} 的入参。 */
export interface RefundRollbackInput {
  /** 租户此刻的到期日。 */
  currentExpireAt: Date | null
  /** 被退款那张订单履约前的到期日（`PlanOrder.expireBeforeAt`）。 */
  expireBeforeAt: Date | null
  /** 被退款那张订单履约后的到期日（`PlanOrder.expireAfterAt`）。 */
  expireAfterAt: Date | null
}

/** {@link computeRefundRollback} 的结果。 */
export interface RefundRollbackResult {
  /** 回退后应写回 `Tenant.planExpireAt` 的值。`applied=false` 时等于 `currentExpireAt`（不动）。 */
  expireAt: Date | null
  /** 是否真的执行了回退。 */
  applied: boolean
  /**
   * 没执行回退的原因：
   * - `ALREADY_ROLLED_BACK`：当前到期日已经不晚于 `expireBeforeAt`，重复退款的幂等命中；
   * - `SUPERSEDED`：这张订单之后又续过费，当前到期日比它履约后的还晚。
   */
  reason?: 'ALREADY_ROLLED_BACK' | 'SUPERSEDED'
}

/**
 * 退款回退到期日：把 `Tenant.planExpireAt` 退回这张订单履约前的 `expireBeforeAt`。
 *
 * **`SUPERSEDED` 刻意不自动处理**：订单 A 履约后商家又买了订单 B，此时退 A，
 * 按月加出来的那一段没法可靠地「减回去」（`1/31 +1月 = 2/28`，减 1 个月只能回到 `1/28`，
 * 平白吃掉商家 3 天）。返回 `applied=false` 让平台后台弹出来人工核对，
 * 比悄悄算错一个到期日要好——错的那个数没人会发现，直到商家来投诉。
 *
 * @param input - 见 {@link RefundRollbackInput}
 */
export function computeRefundRollback(input: RefundRollbackInput): RefundRollbackResult {
  const { currentExpireAt, expireBeforeAt, expireAfterAt } = input
  if (currentExpireAt !== null) assertValidDate(currentExpireAt, 'currentExpireAt')
  if (expireBeforeAt !== null) assertValidDate(expireBeforeAt, 'expireBeforeAt')
  if (expireAfterAt !== null) assertValidDate(expireAfterAt, 'expireAfterAt')

  const cur = currentExpireAt === null ? Number.NEGATIVE_INFINITY : currentExpireAt.getTime()
  const before = expireBeforeAt === null ? Number.NEGATIVE_INFINITY : expireBeforeAt.getTime()
  const after = expireAfterAt === null ? Number.POSITIVE_INFINITY : expireAfterAt.getTime()

  if (cur <= before) {
    return { expireAt: currentExpireAt, applied: false, reason: 'ALREADY_ROLLED_BACK' }
  }
  if (cur > after) {
    return { expireAt: currentExpireAt, applied: false, reason: 'SUPERSEDED' }
  }
  return { expireAt: expireBeforeAt, applied: true }
}
