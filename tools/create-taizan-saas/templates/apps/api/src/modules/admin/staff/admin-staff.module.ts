import { Module } from '@nestjs/common'

import { AdminStaffController } from './staff.controller'
import { AdminStaffService } from './staff.service'

/**
 * 商家侧员工管理（`/api/admin/staff`）。
 *
 * 不 `imports` 任何东西：`PrismaModule` / `AuthModule` / `RbacModule` 都是 `@Global()` 的。
 *
 * 邀请的**核销**端（`/api/public/invites/:token/accept`）刻意**不**复用本 service：
 * 那条路由没有登录态、没有租户上下文，本 service 的每个方法都以 `AuthPrincipal` 起手。
 * 硬套会逼出一个「principal 可以是 undefined」的分支，而那个分支正好绕过了
 * 「谁能授予什么角色」的全部判定。两边共享的是**数据**（`StaffInvite.roleIds` 在
 * 生成邀请时就已经校验过一次），不是代码路径。
 */
@Module({
  controllers: [AdminStaffController],
  providers: [AdminStaffService],
})
export class AdminStaffModule {}
