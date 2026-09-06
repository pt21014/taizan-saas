/**
 * 领域处理器：`@PaymentHandler(prefix)` + 启动期发现（蓝图 §4.12）。
 *
 * ## 为什么是「前缀 → 处理器」而不是「回调控制器查订单表」
 *
 * 统一回调控制器住在框架包里，它不认识 `PlanOrder`、更不认识业务项目自己建的订单表。
 * 让它查库就意味着框架反向依赖业务表——每加一个能收钱的业务就要改一次框架。
 * 所以约定反过来：单号是我们自己生成的（`buildOutTradeNo('PLAN')`），
 * 前缀就是领域标识，控制器只按前缀分发，「这单是谁的」由领域处理器自己回答。
 *
 * ## 租户从哪来
 *
 * **不从这里来。** 回调没有 token，本包也不往上下文里注入租户——
 * 处理器拿到 `event.outTradeNo` 之后按它查自己的订单表（`prisma.raw`，
 * 带 `// raw-reason: 支付回调按参数定位租户`），拿到 `tenantId` 再
 * `runWithPatchedContext({ tenantId })` 切进去做后续的事。
 * 框架替你猜租户的那一版本，猜错时的表现是「A 店的钱发到了 B 店的账上」。
 *
 * @packageDocumentation
 */

// `Reflect.defineMetadata` 来自 reflect-metadata（Nest 的 peer）。它是幂等的。
import 'reflect-metadata'

import { Inject, Injectable, Optional, type OnModuleInit } from '@nestjs/common'
import { DiscoveryService } from '@nestjs/core'
import type { PrismaClientLike } from '@taizan/nest-prisma'
import {
  OutTradeNoRouter,
  type CallbackEvent,
  type RefundEvent,
  type RoutedOutTradeNo,
} from '@taizan/payment-core'

import type { PaymentLogger } from './logging'
import { PAYMENT_LOGGER } from './tokens'

/** `@PaymentHandler()` 写进类元数据的 key。 */
export const PAYMENT_HANDLER_METADATA = Symbol.for('@taizan/nest-payment:HANDLER')

/**
 * 一个领域的支付事件处理器。
 *
 * `onPaid` 的语义是**幂等地把这笔钱兑现掉**。控制器已经用 `transactionId` 做过一层
 * 幂等，但那层挡的是「同一次回调被推了多次」；处理器自己还要挡「同一笔单被不同来源
 * 兑现两次」（回调 + 主动查单 + 后台手工核销），所以内部仍应基于订单状态做判断。
 */
export interface PaymentEventHandler {
  /**
   * 认领的 outTradeNo 前缀（1–6 位大写字母或数字）。
   *
   * 用了 `@PaymentHandler('PLAN')` 之后**不用再写一遍**——装饰器已经把它定义在原型上，
   * 实现类写 `declare readonly prefix: string` 让 TS 满意即可（`declare` 不产出代码，
   * 不会把原型上的值覆盖成 `undefined`）。
   */
  readonly prefix: string

  /**
   * 支付成功（或失败）事件。
   *
   * @param event - 归一化后的回调事件；`event.kind` 为 `'PAY_FAIL'` 时也会调到，
   *   处理器需要自己决定是关单还是忽略。
   * @param tx - 预留给「控制器在事务里调处理器」的场景；当前统一回调控制器不开事务
   *   （回调要尽快应答，长事务会把连接池吃光），所以调用时是 `undefined`。
   */
  onPaid(event: CallbackEvent, tx?: PrismaClientLike): Promise<void>

  /** 退款结果事件。不实现 = 这个领域不接退款回调（控制器会打 warn 并照常应答）。 */
  onRefunded?(event: RefundEvent): Promise<void>
}

/**
 * 声明一个领域支付处理器。
 *
 * 类仍然要是容器里的 provider（写进所在模块的 `providers`），本装饰器只负责打标记；
 * `PaymentHandlerRegistry` 在 `onModuleInit` 时用 `DiscoveryService` 扫出来。
 *
 * @param prefix - outTradeNo 前缀，1–6 位大写字母或数字
 *
 * @example
 * ```ts
 * @Injectable()
 * @PaymentHandler(PLAN_ORDER_PREFIX)
 * export class PlanOrderPaymentHandler implements PaymentEventHandler {
 *   declare readonly prefix: string
 *   async onPaid(event: CallbackEvent): Promise<void> { ... }
 * }
 * ```
 */
export function PaymentHandler(prefix: string): ClassDecorator {
  assertPrefixShape(prefix)
  return (target): void => {
    Reflect.defineMetadata(PAYMENT_HANDLER_METADATA, prefix, target)
    const proto = (target as unknown as { prototype?: object }).prototype
    // 把 prefix 落到原型上，实现类不用再抄一遍。抄两遍就一定有对不上的那一天，
    // 而对不上的表现是「装饰器上写 PLAN、字段里写 PLN，回调永远路由不到」。
    if (proto && !Object.prototype.hasOwnProperty.call(proto, 'prefix')) {
      Object.defineProperty(proto, 'prefix', {
        value: prefix,
        enumerable: false,
        configurable: true,
        writable: false,
      })
    }
  }
}

/** 读一个类上的 `@PaymentHandler` 前缀；没标注返回 `undefined`。 */
export function getPaymentHandlerPrefix(target: unknown): string | undefined {
  if (typeof target !== 'function' && (typeof target !== 'object' || target === null)) {
    return undefined
  }
  const value: unknown = Reflect.getMetadata(PAYMENT_HANDLER_METADATA, target as object)
  return typeof value === 'string' ? value : undefined
}

/** 前缀形状与 `@taizan/payment-core` 的 `buildOutTradeNo` 完全一致。 */
function assertPrefixShape(prefix: string): void {
  if (!/^[A-Z0-9]{1,6}$/.test(prefix)) {
    throw new TypeError(
      `[@taizan/nest-payment] @PaymentHandler("${prefix}") 前缀不合规：只允许 1–6 位大写字母或数字`,
    )
  }
}

/**
 * 扫描容器里所有 `@PaymentHandler` 并组成路由表。
 *
 * 用发现而不是手动登记表：登记表迟早会和代码漂移，而漂移的表现是
 * 「加了处理器忘了登记 = 收到钱之后什么也没发生，且没有任何报错」。
 */
@Injectable()
export class PaymentHandlerRegistry implements OnModuleInit {
  // process-local: 装配期扫出来的只读路由表，不是跨进程状态。
  private readonly router = new OutTradeNoRouter<PaymentEventHandler>()
  // process-local: 前缀 → 声明它的类名，只为把重复注册的报错说清楚。
  private readonly owners = new Map<string, string>()

  constructor(
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Optional() @Inject(PAYMENT_LOGGER) private readonly logger?: PaymentLogger,
  ) {}

  onModuleInit(): void {
    this.discover()
  }

  /**
   * 扫一遍容器。
   *
   * @throws 两个类抢同一个前缀时抛（`OutTradeNoRouter.register` 的行为）——
   *   覆盖的表现是「另一个领域的支付回调静默进了错误的处理器」：钱收了，货发错了。
   */
  discover(): void {
    for (const wrapper of this.discovery.getProviders()) {
      // 请求作用域的 provider 这里拿不到稳定实例；支付处理器也不该挂在请求作用域上。
      if (!wrapper.isDependencyTreeStatic()) continue
      const instance: unknown = wrapper.instance
      if (typeof instance !== 'object' || instance === null) continue
      const prefix = getPaymentHandlerPrefix(instance.constructor)
      if (prefix === undefined) continue

      const owner = instance.constructor.name
      const previous = this.owners.get(prefix)
      if (previous !== undefined) {
        throw new Error(
          `[@taizan/nest-payment] outTradeNo 前缀 "${prefix}" 被 ${previous} 与 ${owner} 同时注册。` +
            `前缀决定回调路由到哪个领域，重复注册会让其中一个领域的钱进错处理器。`,
        )
      }
      this.owners.set(prefix, owner)
      this.router.register(prefix, instance as PaymentEventHandler)
      this.logger?.log?.(
        `[@taizan/nest-payment] 已注册支付处理器 ${prefix} → ${owner}`,
        'PaymentHandlerRegistry',
      )
    }
  }

  /** 手动登记（不走容器发现时用，例如单测里直接塞一个假处理器）。 */
  register(prefix: string, handler: PaymentEventHandler): void {
    assertPrefixShape(prefix)
    if (this.owners.has(prefix)) {
      throw new Error(`[@taizan/nest-payment] outTradeNo 前缀 "${prefix}" 已经注册过`)
    }
    this.owners.set(prefix, handler.constructor.name)
    this.router.register(prefix, handler)
  }

  /** 已注册的前缀（按注册顺序）。 */
  prefixes(): string[] {
    return this.router.prefixes()
  }

  /**
   * 按单号找处理器。
   *
   * 单号不合规、或前缀没注册，都返回 `null`——这两种情况对回调控制器是同一种处置
   * （打 error、照常应答，别让渠道无限重推），分开只会让调用点多一层 try。
   */
  tryRoute(outTradeNo: string): RoutedOutTradeNo<PaymentEventHandler> | null {
    try {
      return this.router.tryRoute(outTradeNo)
    } catch {
      return null
    }
  }
}
