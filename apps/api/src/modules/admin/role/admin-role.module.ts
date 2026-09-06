import { Module } from '@nestjs/common'

import { AdminRoleController } from './role.controller'
import { AdminRoleService } from './role.service'

/** 商家侧自定义角色（`/api/admin/roles`）。依赖的三个包都是 `@Global()` 的，无需 imports。 */
@Module({
  controllers: [AdminRoleController],
  providers: [AdminRoleService],
})
export class AdminRoleModule {}
