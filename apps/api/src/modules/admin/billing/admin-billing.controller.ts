/**
 * `/api/admin/billing` —— 商家侧的「我的套餐」（蓝图 §4.5）。
 *
 * ## 这条前缀为什么必须存在
 *
 * `ALWAYS_WRITABLE_PREFIXES`（`@taizan/billing-rules`）里写着三条到期后仍然可写的
 * 路径，`/api/admin/billing` 是其中之一——它是**收款的门**。而
 * `billing-routes.spec.ts`（spec 8）断言的正是「白名单里的每一条都有真实控制器兑现」：
 * 白名单写了一条不存在的路径，等于放行了空气，商家到期后照样找不到续费入口，
 * 于是「到期 → 只读 → 续不了费 → 永远到期」。
 *
 * 所以这个控制器**不是**为了让 spec 变绿而存在的占位；反过来，是 spec 在提醒
 * 「你答应过这里有个能续费的地方」。
 *
 * ## 四条路由
 *
 * ```
 * GET  /api/admin/billing          当前套餐、到期状态、配额用量
 * GET  /api/admin/billing/plans    可购套餐（到期的店最需要这一屏）
 * GET  /api/admin/billing/orders   本店账单
 * POST /api/admin/billing/orders   自助下单 → 拿支付参数
 * ```
 *
 * `POST` 落在这条前缀下**不是随手放的**：它必须在 `ALWAYS_WRITABLE_PREFIXES` 覆盖的
 * 路径里，否则一家到期的店点「去续费」会拿到 `1440301`——「到期 → 后台只读 →
 * 续不了费 → 永远到期」。`test/plan-order.e2e-spec.ts` ① 就是拿一家昨天到期的店
 * 跑这条 `POST` 的。
 *
 * ## `@RequirePermission` 挂哪一档
 *
 * 两档权限点分别对应「看」与「花钱」：
 *
 * - `billing:view`：看当前套餐、账单、可购套餐。「我们店的套餐什么时候到期」
 *   对店里任何一个员工都不是秘密，`manager` 模板默认给这一档。
 * - `billing:order`：自助下单 / 续费。这是真金白银的动作，`manager` 模板**不**给，
 *   只有店主（恒为全量权限）能点——理由与 `staff:transfer-owner` 一样：某些动作
 *   天生就该锁死在店主本人身上。
 *
 * 这两档权限点与 `BillingGateGuard`（`ALWAYS_WRITABLE_PREFIXES`）是**两道独立的闸门**：
 * 前者管「这个人有没有权限点这个按钮」，后者管「这家店到期了还能不能写」。
 * `POST /orders` 必须**同时**满足两者——没有 `billing:order` 的员工会先被 RBAC 拦成
 * `1340300`，与租户是否到期无关；反过来，店主到期了照样能下单，因为
 * `billing:order` 恒在他的全量权限里，而 `/api/admin/billing` 又落在续费白名单上。
 *
 * @packageDocumentation
 */

import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { PageResult } from '@taizan/contracts'
import { Auth, CurrentUser, type AuthPrincipal } from '@taizan/nest-auth'
import { RequirePermission } from '@taizan/nest-rbac'

import { Validate } from '../../../common/validate.pipe'
import {
  CreateSelfPlanOrderDto,
  ListSelfPlanOrderQueryDto,
} from '../../platform/plan-order/dto/plan-order.dto'
import {
  AdminBillingService,
  type BillingOverview,
  type CreateSelfOrderResult,
  type PlanOrderBillView,
  type PurchasablePlanView,
} from './admin-billing.service'

@ApiTags('admin/billing')
@Controller('api/admin/billing')
@Auth('staff')
export class AdminBillingController {
  constructor(@Inject(AdminBillingService) private readonly billing: AdminBillingService) {}

  @Get()
  @ApiOperation({ summary: '当前套餐、到期状态与配额用量' })
  @RequirePermission('billing:view')
  overview(@CurrentUser() user: AuthPrincipal): Promise<BillingOverview> {
    return this.billing.overview(user)
  }

  @Get('plans')
  @ApiOperation({ summary: '可购套餐（在售的那些）' })
  @RequirePermission('billing:view')
  plans(): Promise<PurchasablePlanView[]> {
    return this.billing.plans()
  }

  @Get('orders')
  @ApiOperation({ summary: '本店账单（套餐订单分页）' })
  @RequirePermission('billing:view')
  orders(
    @CurrentUser() user: AuthPrincipal,
    @Query(Validate(ListSelfPlanOrderQueryDto)) query: ListSelfPlanOrderQueryDto,
  ): Promise<PageResult<PlanOrderBillView>> {
    return this.billing.orders(user, query)
  }

  @Post('orders')
  @ApiOperation({ summary: '自助下单：选套餐与周期，拿回支付参数（到期的店也能调）' })
  @RequirePermission('billing:order')
  createOrder(
    @CurrentUser() user: AuthPrincipal,
    @Body(Validate(CreateSelfPlanOrderDto)) dto: CreateSelfPlanOrderDto,
  ): Promise<CreateSelfOrderResult> {
    return this.billing.createOrder(user, dto)
  }
}
