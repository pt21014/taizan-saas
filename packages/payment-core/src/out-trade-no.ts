/**
 * 商户订单号（outTradeNo）规范与按前缀的领域路由。
 *
 * ## 为什么单号里要塞一个「领域前缀」
 *
 * 蓝图 §4.12 的统一回调控制器只有一条路由 `POST /api/public/pay/:channel/notify`，
 * 所有业务的支付回调都打到这里。控制器验完签、做完幂等，接下来要回答
 * 「这笔钱是买什么的」——**唯一能从回调报文里拿到的、由我们自己控制的信息就是 outTradeNo**。
 * 所以单号写成 `PREFIX-ULID`：前缀是领域标识，`OutTradeNoRouter` 按它分发到领域处理器。
 *
 * 换成「回调时查库反查订单表」也能做，但那要求每个业务表都被回调控制器认识，
 * 等于框架包反向依赖业务表——加一个业务就要改一次框架。
 *
 * ## 长度为什么卡 32
 *
 * 微信支付 V3 的 `out_trade_no` 是 6–32 位，支付宝也是 ≤64 但对齐取小的。
 * ULID 固定 26 位，加连字符占 27 位，**所以自动生成时前缀实际只能到 5 位**
 * （`PLAN` 4 位是留足余量的）。前缀本身允许到 6 位，是给「自带短 id」的场景用的，
 * 见 {@link buildOutTradeNo} 的 `id` 参数。
 */
import { ulid } from '@taizan/contracts'

import { PAYMENT_ERROR, PaymentError } from './errors'

/** 商户订单号总长上限（取微信 V3 的 32，其余渠道都比它宽松）。 */
export const OUT_TRADE_NO_MAX_LEN = 32

/** 前缀与 id 之间的分隔符。选 `-` 是因为四家渠道的单号字符集都收它。 */
export const OUT_TRADE_NO_SEP = '-'

/**
 * 前缀字符集：**只允许大写字母与数字，最长 6 位**。
 *
 * 卡死大写是为了 {@link parseOutTradeNo} 能无歧义地切分，也避免
 * 「`plan-` 和 `PLAN-` 注册了两个处理器」这种大小写事故。
 */
const PREFIX_PATTERN = /^[A-Z0-9]{1,6}$/

/** id 段字符集：大小写字母与数字（ULID 是 Crockford Base32 的子集，天然满足）。 */
const ID_PATTERN = /^[A-Za-z0-9]+$/

/** 套餐订单（`PlanOrder`）的前缀。蓝图 §4.12 点名的那个 `PLAN-`。 */
export const PLAN_ORDER_PREFIX = 'PLAN'

function assertPrefix(prefix: string): void {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw PaymentError.of(
      PAYMENT_ERROR.BAD_REQUEST,
      `outTradeNo 前缀 "${prefix}" 不合规：只允许 1–6 位大写字母或数字`,
      { prefix },
    )
  }
}

/**
 * 生成商户订单号 `PREFIX-ULID`。
 *
 * @param prefix - 领域前缀，1–6 位大写字母/数字（如 {@link PLAN_ORDER_PREFIX}）
 * @param id - 自定义 id 段；不传则生成 ULID（26 位，按时间字典序，便于对账时排序）
 * @throws 前缀不合规、id 含非法字符、或拼出来超过 {@link OUT_TRADE_NO_MAX_LEN} 时抛
 *
 * @example
 * ```ts
 * buildOutTradeNo(PLAN_ORDER_PREFIX)          // 'PLAN-01JC0K3V7Q8ZP5R2M9YB4XN6TA'（31 位）
 * buildOutTradeNo('REFUND', 'A1B2C3')         // 'REFUND-A1B2C3'
 * ```
 */
export function buildOutTradeNo(prefix: string, id?: string): string {
  assertPrefix(prefix)
  const body = id ?? ulid()
  if (!ID_PATTERN.test(body)) {
    throw PaymentError.of(
      PAYMENT_ERROR.BAD_REQUEST,
      `outTradeNo 的 id 段 "${body}" 不合规：只允许字母与数字（不能含分隔符 "${OUT_TRADE_NO_SEP}"）`,
      { prefix, id: body },
    )
  }
  const no = `${prefix}${OUT_TRADE_NO_SEP}${body}`
  if (no.length > OUT_TRADE_NO_MAX_LEN) {
    // 与其让微信回一句「out_trade_no 参数格式错误」，不如在下单前就说清超了几位。
    throw PaymentError.of(
      PAYMENT_ERROR.BAD_REQUEST,
      `outTradeNo "${no}" 长度 ${no.length} 超过上限 ${OUT_TRADE_NO_MAX_LEN}` +
        `（ULID 占 26 位，自动生成时前缀最多 5 位）`,
      { outTradeNo: no, length: no.length },
    )
  }
  return no
}

/** {@link parseOutTradeNo} 的结果。 */
export interface ParsedOutTradeNo {
  prefix: string
  id: string
}

/**
 * 把商户订单号拆回 `{ prefix, id }`。
 *
 * 按**第一个**分隔符切分：id 段本身不允许含 `-`（{@link buildOutTradeNo} 已经挡住），
 * 所以这里不会有歧义。
 *
 * @throws 格式不合规时抛 {@link PaymentError}。**不返回 null**——
 * 回调里拿到一个解析不了的单号是异常情况，静默返回 null 会让它一路飘到业务层才炸。
 */
export function parseOutTradeNo(no: string): ParsedOutTradeNo {
  const bad = (why: string): never => {
    throw PaymentError.of(PAYMENT_ERROR.BAD_REQUEST, `outTradeNo "${no}" 不合规：${why}`, {
      outTradeNo: no,
    })
  }
  if (typeof no !== 'string' || no.length === 0) return bad('为空')
  if (no.length > OUT_TRADE_NO_MAX_LEN) return bad(`长度 ${no.length} 超过 ${OUT_TRADE_NO_MAX_LEN}`)
  const sep = no.indexOf(OUT_TRADE_NO_SEP)
  if (sep < 0) return bad(`缺少分隔符 "${OUT_TRADE_NO_SEP}"`)
  const prefix = no.slice(0, sep)
  const id = no.slice(sep + 1)
  if (!PREFIX_PATTERN.test(prefix)) return bad(`前缀 "${prefix}" 不是 1–6 位大写字母或数字`)
  if (!ID_PATTERN.test(id)) return bad(`id 段 "${id}" 不是纯字母数字`)
  return { prefix, id }
}

/** 路由命中的结果：解析出的单号三段 + 注册的处理器。 */
export interface RoutedOutTradeNo<H> extends ParsedOutTradeNo {
  handler: H
}

/**
 * 按 outTradeNo 前缀分发到领域处理器。
 *
 * 泛型 `H` 是处理器本身的类型——本包不规定处理器长什么样（那是 `@taizan/nest-payment`
 * 与业务项目的事），只负责「前缀 → 处理器」这张表的唯一性。
 *
 * @example
 * ```ts
 * const router = new OutTradeNoRouter<(e: CallbackEvent) => Promise<void>>()
 * router.register(PLAN_ORDER_PREFIX, onPlanOrderPaid)
 * const { handler, id } = router.route(event.outTradeNo)
 * await handler(event)
 * ```
 */
export class OutTradeNoRouter<H> {
  private readonly handlers = new Map<string, H>()

  /**
   * 注册一个领域前缀。
   *
   * **重复前缀直接抛**，不是后者覆盖前者：两个领域抢同一个前缀时，
   * 覆盖的表现是「另一个领域的支付回调静默进了错误的处理器」——钱收了，货发错了。
   * 启动期抛错至少是当场炸。
   */
  register(prefix: string, handler: H): this {
    assertPrefix(prefix)
    const existing = this.handlers.get(prefix)
    if (existing !== undefined) {
      throw PaymentError.of(
        PAYMENT_ERROR.BAD_REQUEST,
        `outTradeNo 前缀 "${prefix}" 已经注册过领域处理器，不能重复注册`,
        { prefix },
      )
    }
    this.handlers.set(prefix, handler)
    return this
  }

  /** 这个前缀注册过没有。 */
  has(prefix: string): boolean {
    return this.handlers.has(prefix)
  }

  /** 已注册的全部前缀（按注册顺序）。装配自检/启动日志用。 */
  prefixes(): string[] {
    return [...this.handlers.keys()]
  }

  /**
   * 解析单号并取出处理器。
   *
   * @throws 单号不合规抛 `BAD_REQUEST`；前缀没注册抛 `ROUTE_NOT_FOUND`。
   */
  route(outTradeNo: string): RoutedOutTradeNo<H> {
    const parsed = parseOutTradeNo(outTradeNo)
    const handler = this.handlers.get(parsed.prefix)
    if (handler === undefined) {
      throw PaymentError.of(
        PAYMENT_ERROR.ROUTE_NOT_FOUND,
        `outTradeNo 前缀 "${parsed.prefix}" 没有注册领域处理器（已注册：${this.prefixes().join(', ') || '无'}）`,
        { outTradeNo, prefix: parsed.prefix },
      )
    }
    return { ...parsed, handler }
  }

  /** 同 {@link route}，但前缀没注册时返回 `null` 而不抛（单号本身不合规仍然抛）。 */
  tryRoute(outTradeNo: string): RoutedOutTradeNo<H> | null {
    const parsed = parseOutTradeNo(outTradeNo)
    const handler = this.handlers.get(parsed.prefix)
    return handler === undefined ? null : { ...parsed, handler }
  }
}
