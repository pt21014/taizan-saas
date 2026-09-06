/**
 * C 端会员登录（**联调用的 dev 登录**）。
 *
 * ## 这是一个后门，所以它有三道锁
 *
 * 1. env 开关 `CLIENT_DEV_LOGIN` 默认 **false**，不开就直接拒；
 * 2. `assertAppDevFlagsInProd()`（`src/config/env.ts`）在 `NODE_ENV=production` 且它为真时
 *    **拒绝启动**——形状照抄 nest-core 的 `assertNoDevCodeInProd`，那个常量表是框架级的、
 *    管不到业务新增的开关；
 * 3. 服务内部再判一次 `isProduction`，装配被改坏时的第二道。
 *
 * 三道都是刻意的：一个「只凭手机号就签发会员 token」的接口，等价于任意人可冒充任意会员。
 *
 * 真实的 C 端登录（短信验证码 / 微信 jscode2session）在 T2-*，那时这个接口保持原样即可，
 * 它只服务本地联调与 e2e。
 *
 * ## 为什么这里不需要 raw
 *
 * `/api/client/*` 进租户中间件：请求到这里时 `X-Tenant-Slug`（或子域名）已经被解析成
 * 上下文里的 `tenantId` 了。`Member` 是租户域模型，走 `prisma.tenant` 就够——
 * 「找会员」和「建会员」都自动带上当前店，一个 `tenantId` 字面量都不用写。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { ErrorCode } from '@taizan/contracts'
import { AuthFlowService, type IssuedTokens } from '@taizan/nest-auth'
import { BizException, ConfigService, requireTenantId } from '@taizan/nest-core'
import { PrismaService } from '@taizan/nest-prisma'

import type { Prisma } from '@prisma/client'

import { autoTenantData } from '../../../common/prisma.types'
import type { AppPrismaService } from '../../../common/prisma.types'
import type { AppEnv } from '../../../config/env'

/** dev 登录的产出。 */
export interface ClientLoginResult extends IssuedTokens {
  member: { id: string; phone: string | null; nickname: string | null }
  tenantId: string
}

@Injectable()
export class ClientAuthService {
  constructor(
    @Inject(PrismaService) private readonly prisma: AppPrismaService,
    @Inject(AuthFlowService) private readonly flow: AuthFlowService,
    @Inject(ConfigService) private readonly config: ConfigService<AppEnv>,
  ) {}

  /**
   * 只给手机号就登录：会员不存在就建一个。
   *
   * @param phone - 手机号
   * @throws `BizException` 1040000 开关没开
   */
  async loginDev(phone: string): Promise<ClientLoginResult> {
    if (this.config.isProduction || this.config.get('CLIENT_DEV_LOGIN') !== true) {
      throw new BizException(
        ErrorCode.BAD_REQUEST,
        '联调登录未开启（CLIENT_DEV_LOGIN）。正式环境请走短信验证码或微信登录。',
      )
    }

    // 中间件已经把 tenantId 写进上下文；取不到就是装配出了问题，requireTenantId 会抛。
    const tenantId = requireTenantId()

    // 全程 prisma.tenant：找会员、建会员都自动限定在当前这家店。
    const existing = await this.prisma.tenant.member.findFirst({ where: { phone } })
    const member =
      existing ??
      (await this.prisma.tenant.member.create({
        // id 与 tenantId 由扩展注入，见 `autoTenantData` 的说明。
        data: autoTenantData<Prisma.MemberCreateInput>({
          phone,
          nickname: `会员${phone.slice(-4)}`,
          status: 'ACTIVE',
        }),
      }))

    if (member.status !== 'ACTIVE') {
      throw new BizException(ErrorCode.UNAUTHENTICATED, '该会员已被停用')
    }

    await this.prisma.tenant.member.update({
      where: { id: member.id },
      data: { lastLoginAt: new Date() },
    })

    const tokens = await this.flow.login('member', member.id, tenantId)
    return {
      access: tokens.access,
      refresh: tokens.refresh,
      expiresIn: tokens.expiresIn,
      member: { id: member.id, phone: member.phone, nickname: member.nickname },
      tenantId,
    }
  }
}
