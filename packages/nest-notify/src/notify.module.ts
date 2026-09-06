/**
 * `NotifyModule.forRoot({ channels, templates? })`：通知能力的装配入口。
 *
 * `channels` 是**已经配好的驱动实例**（`createSmsChannel(...)`/
 * `createInboxChannel()`/`createMpTemplateChannel()`/`createAppPushChannel()`
 * 的返回值），本模块不替业务侧决定用哪家短信厂商——那是装配层（`apps/api`）
 * 的事，`NotifyModule` 只负责把这些驱动接进 `NotifyService`。
 *
 * `templates` 不传时查 `NotifyTemplate` 表（`PrismaTemplateSource`，走
 * `prisma.raw`——它是平台域表，见 `template-source.ts`）；传了就用内存模板，
 * 适合测试或项目还没跑 seed 的阶段。
 *
 * @packageDocumentation
 */
import { Module, type DynamicModule, type Provider } from '@nestjs/common'
import { PrismaService } from '@taizan/nest-prisma'
import type { PrismaClientLike } from '@taizan/nest-prisma'
import {
  InMemoryTemplateSource,
  PrismaTemplateSource,
  type NotifyTemplateDef,
} from './template-source'
import { NOTIFY_CHANNELS, NOTIFY_TEMPLATE_SOURCE } from './tokens'
import { NotifyRetryHandler } from './notify-retry.handler'
import { NotifyService } from './notify.service'
import type { NotifyChannelDriver } from './types'

export interface NotifyModuleOptions {
  channels: NotifyChannelDriver[]
  /** 不传则查 `NotifyTemplate` 表；传了则完全用这份内存模板，不查库。 */
  templates?: Record<string, NotifyTemplateDef>
}

@Module({})
export class NotifyModule {
  static forRoot(options: NotifyModuleOptions): DynamicModule {
    const templateSourceProvider: Provider = options.templates
      ? {
          provide: NOTIFY_TEMPLATE_SOURCE,
          useValue: new InMemoryTemplateSource(options.templates),
        }
      : {
          provide: NOTIFY_TEMPLATE_SOURCE,
          useFactory: (prisma: PrismaService) =>
            new PrismaTemplateSource(prisma.raw as PrismaClientLike),
          inject: [PrismaService],
        }

    return {
      module: NotifyModule,
      providers: [
        { provide: NOTIFY_CHANNELS, useValue: options.channels },
        templateSourceProvider,
        NotifyService,
        NotifyRetryHandler,
      ],
      exports: [NotifyService],
    }
  }
}
