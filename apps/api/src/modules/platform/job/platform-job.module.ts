import { Module } from '@nestjs/common'

import { PlatformJobController } from './platform-job.controller'
import { PlatformJobService } from './platform-job.service'

/**
 * `DeadLetterService`（`@taizan/nest-infra`）不需要在这里 `imports`：`InfraModule`
 * 在 `AppModule` 里以 `@Global()` 装配（见 `apps/api/src/bootstrap/app.module.ts` 文件头
 * 「为什么是 @Global()」），本模块直接注入即可。
 */
@Module({
  controllers: [PlatformJobController],
  providers: [PlatformJobService],
})
export class PlatformJobModule {}
