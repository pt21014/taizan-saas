/**
 * 套餐订单的支付回调处理器（`outTradeNo` 前缀 `PLAN`，蓝图 §4.12）。
 *
 * 统一回调控制器（`@taizan/nest-payment` 的 `POST /api/public/pay/:channel/notify`）
 * 已经做完了验签 → 幂等（`transactionId`）→ 归一化 → 按前缀路由这四段，
 * 打到这里的 `event` 是可信的、且**这一笔 transactionId 只会进来一次**。
 * 本文件只回答一件事：这笔钱该兑现给谁、兑现多少。
 *
 * ## 三条防线，顺序不能换
 *
 * | # | 检查 | 不过怎么办 | 为什么是这个反应 |
 * |---|---|---|---|
 * | 1 | 按 `outTradeNo` 找得到订单吗 | 记审计 FAIL + **正常应答** | 找不到单是永久性错误（单号是我们自己生成的，它不存在说明库被清过或者单号被伪造）。让渠道重推一整天不会让它出现 |
 * | 2 | `amountCents` 对得上吗 | 记审计 FAIL + **正常应答** | 同上，且更严重：金额不符要么是有人改了收银台参数（付 1 分钱买一年），要么是我们改过价而旧的收银台还开着。**两种都不可能靠重推自愈**，但两种都必须留下账 |
 * | 3 | 兑现 | 抛错 → 渠道重推 | 只有这一段的失败（数据库抖动、锁超时）是重试能好的 |
 *
 * 前两条**刻意不抛错**。`@taizan/nest-payment` README 写得很直白：抛错 = 请渠道重推，
 * 而微信会重推 15 次、跨度一整天。对一个永远不会通过的检查这么做，唯一的效果是
 * 把接口打满、把日志刷爆，然后仍然没有人去处理那笔钱。正确做法是**记账 + 告警 +
 * 应答成功**，让钱的去向留在审计里，事后人工补兑现。
 *
 * ## 租户上下文
 *
 * 回调没有 token，`tenantId` 只能从订单行反查（这正是蓝图 §8 第 3 条那处合法 raw 用途）。
 * 拿到之后 `runWithPatchedContext({ tenantId })` 切进去，`PlanOrderService` 里的审计与
 * 站内信才写得进租户域表。**框架不替我们猜租户**——猜错的表现是「A 店的钱发到 B 店」。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { AuditService } from '@taizan/nest-audit'
import { AppLogger, runWithPatchedContext } from '@taizan/nest-core'
import { PaymentHandler, type PaymentEventHandler } from '@taizan/nest-payment'
import { PLAN_ORDER_PREFIX, type CallbackEvent } from '@taizan/payment-core'

import { APP_AUDIT_ACTIONS } from '../../../registry/audit-actions'
import { isAmountMatch } from './plan-order.rules'
import { PlanOrderService } from './plan-order.service'

const CONTEXT = 'PlanOrderPaymentHandler'

@Injectable()
@PaymentHandler(PLAN_ORDER_PREFIX)
export class PlanOrderPaymentHandler implements PaymentEventHandler {
  /** 由 `@PaymentHandler('PLAN')` 定义在原型上；`declare` 不产出代码，不会把它盖成 undefined。 */
  declare readonly prefix: string

  constructor(
    @Inject(PlanOrderService) private readonly orders: PlanOrderService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async onPaid(event: CallbackEvent): Promise<void> {
    if (event.kind !== 'PAY_SUCCESS') {
      // 支付失败的回调不关单：单子还在 PENDING，用户可以换个方式再付一次，
      // 真没付成会由 `cancelExpired()` 在 30 分钟后收走。
      this.logger.log(`套餐订单 ${event.outTradeNo} 收到 PAY_FAIL 回调，保持 PENDING`, CONTEXT)
      return
    }

    // raw-reason: 支付回调按参数定位租户（蓝图 §8 第 3 条）。回调进来时没有任何 token，
    // 先按全局唯一的 outTradeNo 找到订单，才知道这笔钱是哪家店的。
    const order = await this.orders.findByOutTradeNo(event.outTradeNo)
    if (!order) {
      await this.recordFail(event, '回调找不到对应的套餐订单')
      this.logger.error(
        `套餐支付回调找不到订单 ${event.outTradeNo}（渠道流水 ${event.transactionId}，` +
          `${event.amountCents} 分）。钱已到账但无单可兑现，请人工核对后补单`,
        undefined,
        CONTEXT,
      )
      return
    }

    if (!isAmountMatch(order.amountCents, event.amountCents)) {
      await this.recordFail(
        event,
        `回调金额与订单不符：订单 ${order.amountCents} 分，回调 ${event.amountCents} 分`,
        order.tenantId,
        order.id,
      )
      this.logger.error(
        `套餐订单 ${order.outTradeNo} 金额不符：订单 ${order.amountCents} 分、` +
          `回调 ${event.amountCents} 分，**不予兑现**。这是永久性错误（重推不会自愈），` +
          `已记审计 FAIL 并正常应答，请人工核对是改价了还是被篡改了参数`,
        undefined,
        CONTEXT,
      )
      return
    }

    await runWithPatchedContext({ tenantId: order.tenantId }, async () => {
      await this.orders.fulfill(order.id, {
        transactionId: event.transactionId,
        paidAt: event.paidAt,
        via: 'CALLBACK',
      })
    })
  }

  /**
   * 记一条**平台域**审计 FAIL。
   *
   * 走 `recordPlatform` 而不是 `record`：这两条分支要么压根不知道租户是谁
   * （订单都找不到），要么恰恰是「不该相信这条回调」的时刻，往租户域表里写一条
   * 属于它的记录反而是在替攻击者往商家的日志里塞东西。平台侧的账留得住就够了。
   *
   * 审计写失败不影响应答（渠道要的是「你收到了没」），只打 error。
   */
  private async recordFail(
    event: CallbackEvent,
    reason: string,
    targetTenantId?: string,
    orderId?: string,
  ): Promise<void> {
    try {
      await this.audit.recordPlatform({
        action: APP_AUDIT_ACTIONS.PLAN_ORDER_CALLBACK,
        actorType: 'SYSTEM',
        actorId: 'pay-callback',
        actorName: `套餐支付回调(${event.channel})`,
        targetType: 'PlanOrder',
        targetId: orderId ?? event.outTradeNo,
        ...(targetTenantId ? { targetTenantId } : {}),
        after: {
          outTradeNo: event.outTradeNo,
          transactionId: event.transactionId,
          amountCents: event.amountCents,
          reason,
        },
        result: 'FAIL',
      })
    } catch (err) {
      this.logger.error(
        `写套餐回调审计失败：${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
        CONTEXT,
      )
    }
  }
}
