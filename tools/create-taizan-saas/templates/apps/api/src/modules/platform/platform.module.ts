/**
 * `/api/platform` 命名空间的聚合模块。
 *
 * 这条命名空间**不进租户中间件**（`TENANT_FREE_PREFIXES`）：平台超管天然跨租户，
 * 给它解析一个 tenantId 反而会让 `prisma.tenant` 悄悄把查询限制在某一家店，
 * 平台后台会看到「数据不见了」。整个目录也因此在 raw 白名单里（`src/tenancy/raw-reasons.ts`）。
 *
 * T1-7 会把套餐、订单、公告、审计查询、跨租户看板补齐，形状照抄这里。
 *
 * @packageDocumentation
 */

import { Module } from '@nestjs/common'

import { PlatformAdminModule } from './admin/platform-admin.module'
import { PlatformAnnouncementModule } from './announcement/platform-announcement.module'
import { PlatformAuditModule } from './audit/platform-audit.module'
import { PlatformAuthModule } from './auth/platform-auth.module'
import { DashboardModule } from './dashboard/dashboard.module'
import { PlatformJobModule } from './job/platform-job.module'
import { PlatformOrderModule } from './order/platform-order.module'
import { PlanLifecycleModule } from './plan-lifecycle/plan-lifecycle.module'
import { PlanOrderModule } from './plan-order/plan-order.module'
import { PlanModule } from './plan/plan.module'
import { PlatformRolePresetModule } from './role-preset/platform-role-preset.module'
import { PlatformTenantModule } from './tenant/platform-tenant.module'

@Module({
  imports: [
    PlatformAuthModule,
    PlatformTenantModule,
    // ── T1-7 平台管理面 ──────────────────────────────────────────────
    PlatformAdminModule,
    PlanModule,
    PlatformOrderModule,
    // ── T1-5 平台收费闭环（订单状态机 / 支付回调 / 线下核销 / 退款 / 超时取消）──
    // 与 PlatformOrderModule 并列而不是合并：那个是 T1-7 的**只读**查询面，
    // 这个是唯一的写路径。读写混在一个模块里，`fulfill` 单一路径那条 spec 就不好扫了。
    PlanOrderModule,
    // ── T2-7 到期提醒 cron + 试用转化 cron（蓝图 §4.6）── 复用 PlanOrderModule 的
    // fulfill 路径，见 PlanLifecycleModule 文件头。`retention.cli.ts` 是独立脚本，
    // 不在这里装配。
    PlanLifecycleModule,
    PlatformRolePresetModule,
    PlatformAnnouncementModule,
    PlatformAuditModule,
    DashboardModule,
    // ── T3-4 队列死信查看/重放 + cron 运行记录 ────────────────────────────
    PlatformJobModule,
  ],
})
export class PlatformModule {}
