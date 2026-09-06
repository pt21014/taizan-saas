/**
 * 平台管理员 MFA「开关位」（T3-4 任务书条目⑤）。
 *
 * ## 本阶段的范围——只做 enable/verify，登录时**不**强制校验
 *
 * `PlatformAdmin.mfaSecretEnc`/`mfaKeyId` 两列已经在 schema 里（`@taizan/prisma-base`），
 * 但表里**没有第三列**用来区分「已生成 secret 但还没扫码确认」与「已确认启用」——
 * 这两列只够表达「有没有配置一份 TOTP 密钥」，表达不了「这份密钥有没有被验证过」。
 * 真要做完整的「未验证 pending → 验证一次 → 才允许登录时强制校验」状态机，需要再加一列
 * （比如 `mfaConfirmedAt`），而 schema 属于 `@taizan/prisma-base`，不在本次改动允许范围内。
 *
 * 因此这里只实现任务书里明确写了「若超出 1 小时工作量可以只做这一半」的那一半：
 * - `enable()`：生成一份新 TOTP secret，加密落库，返回 otpauth URL 给管理员去扫码；
 * - `verify()`：用当前库里的密文解密出 secret，校验一枚一次性码。
 *
 * **TODO(平台 MFA 第二阶段)**：`platform-auth.service.ts` 的 `login()` 目前完全不检查
 * `mfaSecretEnc` 是否非空，也就不会在登录时要求 `totp` 字段——把它接上需要：
 * ① 给 `PlatformLoginDto` 加可选 `totp` 字段；② `login()` 里若 `admin.mfaSecretEnc` 非空则
 * 校验该字段；③ 前端登录页加对应输入框（`apps/platform` 的 `PlatformLoginPage`）。
 * 这些留到下一阶段，本文件的 `verify()` 目前只回答「这枚码此刻对不对」，不改变任何
 * 登录行为。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { ErrorCode } from '@taizan/contracts'
import { BizException, ConfigService } from '@taizan/nest-core'
import { RawPrismaService } from '@taizan/nest-prisma'
import { createVault, type CredentialVault } from '@taizan/crypto'

import type { AppEnv } from '../../../config/env'
import type { AppPrismaClient } from '../../../common/prisma.types'
import { buildOtpauthUrl, generateTotpSecret, verifyTotp } from './totp'

/** 认证器 app 里显示的发行方名字。 */
const OTPAUTH_ISSUER = 'Taizan Platform'

/** `enable()` 的产出。 */
export interface MfaEnableResult {
  /** 让管理员拿去粘贴/生成二维码扫描的 otpauth URL；本身不含明文密钥之外的敏感信息。 */
  otpauthUrl: string
}

/** `verify()` 的产出。 */
export interface MfaVerifyResult {
  verified: true
}

@Injectable()
export class PlatformMfaService {
  private readonly vault: CredentialVault

  constructor(
    // raw-reason: 平台后台——PlatformAdmin 是平台域表，没有 tenantId 列。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
    @Inject(ConfigService) config: ConfigService<AppEnv>,
  ) {
    this.vault = createVault({
      keys: config.get('CRYPTO_KEYS'),
      currentKeyId: config.get('CRYPTO_KEY_CURRENT'),
    })
  }

  /**
   * 生成一份新 TOTP secret 并加密落库，返回 otpauth URL。
   *
   * 重复调用会**覆盖**上一份未确认的 secret——这是有意的：管理员没扫上一次的码、
   * 又点了一次「开启 MFA」，理应拿到一份新的，而不是让旧的悬在那里也能用。
   */
  async enable(adminId: string): Promise<MfaEnableResult> {
    // raw-reason: 平台后台——按 id 找当前登录的平台管理员自己。
    const admin = await this.raw.client.platformAdmin.findUnique({ where: { id: adminId } })
    if (!admin) {
      throw new BizException(ErrorCode.UNAUTHENTICATED, '账号不存在或已被删除')
    }

    const secret = generateTotpSecret()
    const { valueEnc, keyId } = this.vault.encrypt(secret)

    // raw-reason: 平台后台——落密文与配对的密钥版本号。
    await this.raw.client.platformAdmin.update({
      where: { id: adminId },
      data: { mfaSecretEnc: valueEnc, mfaKeyId: keyId },
    })

    return {
      otpauthUrl: buildOtpauthUrl(secret, { issuer: OTPAUTH_ISSUER, accountName: admin.username }),
    }
  }

  /**
   * 校验一枚一次性码。
   *
   * @throws `BizException` `UNAUTHENTICATED`——尚未调用过 `enable()`（没有密钥可验），
   *   或密文解密失败（keyId 被下线之类的运维问题），或码不对/过期。三种情况同一个
   *   错误码：这是一个「你现在验证不了」的信号，不需要让前端分支处理三种不同原因。
   */
  async verify(adminId: string, code: string): Promise<MfaVerifyResult> {
    // raw-reason: 平台后台——同上。
    const admin = await this.raw.client.platformAdmin.findUnique({ where: { id: adminId } })
    if (!admin?.mfaSecretEnc || !admin.mfaKeyId) {
      throw new BizException(ErrorCode.UNAUTHENTICATED, '尚未生成 MFA 密钥，请先调用「开启 MFA」')
    }

    let secret: string
    try {
      secret = this.vault.decrypt(admin.mfaSecretEnc, admin.mfaKeyId)
    } catch {
      throw new BizException(ErrorCode.UNAUTHENTICATED, 'MFA 密钥解密失败，请重新开启 MFA')
    }

    if (!verifyTotp(secret, code)) {
      throw new BizException(ErrorCode.UNAUTHENTICATED, '验证码不正确或已过期')
    }
    return { verified: true }
  }
}
