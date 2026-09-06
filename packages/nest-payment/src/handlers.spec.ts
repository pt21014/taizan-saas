import 'reflect-metadata'
import { Injectable } from '@nestjs/common'
import { DiscoveryModule } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import type { CallbackEvent } from '@taizan/payment-core'
import { describe, expect, it } from 'vitest'

import {
  getPaymentHandlerPrefix,
  PaymentHandler,
  PaymentHandlerRegistry,
  type PaymentEventHandler,
} from './handlers'

@Injectable()
@PaymentHandler('PLAN')
class PlanHandler implements PaymentEventHandler {
  declare readonly prefix: string
  readonly seen: string[] = []
  async onPaid(event: CallbackEvent): Promise<void> {
    this.seen.push(event.outTradeNo)
  }
}

@Injectable()
@PaymentHandler('SHOP')
class ShopHandler implements PaymentEventHandler {
  declare readonly prefix: string
  async onPaid(): Promise<void> {}
}

/** 和 `PlanHandler` 抢同一个前缀。 */
@Injectable()
@PaymentHandler('PLAN')
class RogueHandler implements PaymentEventHandler {
  declare readonly prefix: string
  async onPaid(): Promise<void> {}
}

async function registryWith(...handlers: unknown[]): Promise<PaymentHandlerRegistry> {
  const moduleRef = await Test.createTestingModule({
    imports: [DiscoveryModule],
    providers: [PaymentHandlerRegistry, ...(handlers as never[])],
  }).compile()
  await moduleRef.init()
  return moduleRef.get(PaymentHandlerRegistry)
}

describe('@PaymentHandler / PaymentHandlerRegistry', () => {
  it('装饰器把 prefix 同时写进元数据与原型（实现类不用抄第二遍）', () => {
    expect(getPaymentHandlerPrefix(PlanHandler)).toBe('PLAN')
    expect(new PlanHandler().prefix).toBe('PLAN')
  })

  it('非法前缀在装饰阶段就抛（不等到运行时才发现路由不到）', () => {
    expect(() => PaymentHandler('plan')).toThrow(/只允许 1–6 位大写字母或数字/)
    expect(() => PaymentHandler('TOOLONGPREFIX')).toThrow(/只允许 1–6 位大写字母或数字/)
  })

  it('扫描容器里所有 @PaymentHandler 并按前缀路由', async () => {
    const registry = await registryWith(PlanHandler, ShopHandler)

    expect(registry.prefixes().sort()).toEqual(['PLAN', 'SHOP'])
    expect(registry.tryRoute('PLAN-01JC0K3V7Q8ZP5R2M9YB4XN6TA')?.handler).toBeInstanceOf(
      PlanHandler,
    )
    expect(registry.tryRoute('SHOP-ABC123')?.handler).toBeInstanceOf(ShopHandler)
  })

  it('未注册的前缀与不合规的单号都返回 null（控制器对这两者的处置是一样的）', async () => {
    const registry = await registryWith(PlanHandler)

    expect(registry.tryRoute('NOBODY-ABC123')).toBeNull()
    expect(registry.tryRoute('没有分隔符')).toBeNull()
    expect(registry.tryRoute('')).toBeNull()
  })

  // 用例 ⑥
  it('两个类抢同一个前缀 → 启动期直接抛（覆盖的话钱会进错处理器）', async () => {
    await expect(registryWith(PlanHandler, RogueHandler)).rejects.toThrow(
      /outTradeNo 前缀 "PLAN" 被 .* 与 .* 同时注册/,
    )
  })

  it('手动 register 同一个前缀两次也抛', async () => {
    const registry = await registryWith(PlanHandler)
    expect(() => registry.register('PLAN', new ShopHandler())).toThrow(/已经注册过/)
  })
})
