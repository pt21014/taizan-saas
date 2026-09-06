/**
 * 官网自助注册（T1-8）。
 *
 * ## 这是全站唯一「谁都能调、而且会往库里写东西」的入口
 *
 * 所以这个文件上挂着的每一条都不是装饰：
 *
 * | 防线 | 在哪 | 防什么 |
 * |---|---|---|
 * | `@RateLimited('signup')` | 控制器 | 同 IP 一天 3 家店。**成功也计数**——要拦的正是「每次都成功地建出一家店」 |
 * | `countAttempt('signup', phone)` | 本文件，**动作之前** | 同手机号一天 3 家店。放动作之后的话，抛异常的分支就漏记了 |
 * | 图形验证码 | 本文件 | 走量的脚本。**它不防定向攻击**（打码平台几分钱一个），只是第一道筛子 |
 * | 口令强度先判 | 本文件，**进事务之前** | 见下「为什么口令强度要提前判」 |
 * | 不下发 token | 本文件（刻意没有 login） | 见下 |
 * | `SIGNUP_ENABLED` | 本文件 | 出事时不改代码、不改路由就能立刻关掉它 |
 *
 * ## 不下发 token
 *
 * 注册成功后**强制走一次登录**。在这里签 token 等于开了第三条进后台的路：
 * 登录接口上挂着的验证码、失败限流、账号停用判定、换店重签逻辑，注册接口一条都没有。
 * 而它偏偏是那个「谁都能调」的入口——一旦注册返回 token，
 * 「免验证码登录」就只差一个已存在的手机号 + 一次口令校验，那正是这条路上最脆弱的地方。
 *
 * ## 为什么口令强度要在**进事务之前**判
 *
 * `provisionTenant()` 只对**新账号**那一支跑 `assertOwnerPasswordPolicy`。也就是说，
 * 如果放任它在事务里判，「密码太弱」这条错误只会在「这个手机号还没注册过」时出现——
 * 它本身就成了一个手机号探针（已注册 → 「手机号或密码不对」，未注册 → 「密码 8–64 位」）。
 * 提前用**同一个函数**判一次，两条分支的回答就一样了。
 *
 * ## 建店本身一个字都不写
 *
 * 整块是 `provisionTenant(tx, { source: 'SIGNUP' }, deps)`，与平台后台那条路
 * **共用同一个 deps 工厂、同一个函数**。`provision.spec.ts` 逐字节比对
 * `PLATFORM` 与 `SIGNUP` 的 tx 调用序列，`test/arch/provision-single-path.spec.ts`
 * 扫源码不许别处再出现建租户的写调用。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { ErrorCode } from '@taizan/contracts'
import { AuditService } from '@taizan/nest-audit'
import { AuthFlowService, CaptchaService } from '@taizan/nest-auth'
import { AppLogger, BizException, ConfigService } from '@taizan/nest-core'
import { RawPrismaService } from '@taizan/nest-prisma'
import {
  assertOwnerPasswordPolicy,
  buildProvisionAudit,
  isProvisionError,
  normalizePhone,
  provisionTenant,
  validateSlug,
} from '@taizan/provision'

import type { AppPrismaClient } from '../../../common/prisma.types'
import { createProvisionDeps } from '../../../common/provision-deps'
import type { AppEnv } from '../../../config/env'
import type { SignupDto } from './dto/signup.dto'
import {
  CREDENTIAL_FAILURE,
  isSignupOpen,
  mapProvisionFailure,
  resolveSignupTrialDays,
  SIGNUP_DISABLED,
} from './signup.rules'

/** 注册成功的回执。**刻意不含 token**，见文件头。 */
export interface SignupResult {
  tenantId: string
  slug: string
  name: string
  /** 试用到期日（当天最后一刻，`Asia/Shanghai`）。 */
  trialEndAt: string
  /** 试用天数（`SIGNUP_TRIAL_DAYS`）。 */
  trialDays: number
  /**
   * 这次是不是**新建**了登录账号。
   *
   * `false` = 一号多店：成功页必须换一句话，说成「用刚才设置的密码登录」会让他
   * 以为口令被改了（而 provision 永不覆盖已有口令）。
   */
  accountCreated: boolean
  /** 后台登录地址（相对路径；域名由前端按当前站点拼）。 */
  adminLoginPath: string
  /** 直接显示给商家的一句话。 */
  message: string
}

/** slug 查重的回答。 */
export interface CheckSlugResult {
  slug: string
  available: boolean
  /** 不可用时的原因，直接显示。 */
  reason: string | null
}

/** 官网落地页要的站点配置。 */
export interface SiteConfig {
  /** 注册按钮显不显示。与 `POST /signup` 读的是同一个开关（`isSignupOpen`）。 */
  signupEnabled: boolean
  /** 注册送几天试用。 */
  trialDays: number
  /** 在售套餐，价格**现取自 `Plan` 表**——官网页面上不许再抄一份价格。 */
  plans: SitePlan[]
}

/** 官网价目表里的一行。 */
export interface SitePlan {
  id: string
  code: string
  name: string
  firstPriceCents: number
  renewPriceCents: number
  periodMonths: number
  sort: number
}

@Injectable()
export class SignupService {
  constructor(
    // raw-reason: 自助注册——建店这一刻租户还不存在，注入不了 tenantId；
    // 「这个手机号有没有账号」也天然是跨租户查询（StaffAccount 是平台域表）。
    @Inject(RawPrismaService) private readonly raw: RawPrismaService<AppPrismaClient>,
    @Inject(ConfigService) private readonly config: ConfigService<AppEnv>,
    /** 只用它的 `countAttempt`——账号（手机号）维度的那一半限流。 */
    @Inject(AuthFlowService) private readonly authFlow: AuthFlowService,
    @Inject(CaptchaService) private readonly captcha: CaptchaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /** 出一张图形验证码。 */
  issueCaptcha(): Promise<{ id: string; svg: string }> {
    return this.captcha.issue()
  }

  /** 站点配置：注册开关、试用天数、在售套餐（价格现取自 `Plan` 表）。 */
  async siteConfig(): Promise<SiteConfig> {
    // raw-reason: 自助注册的落地页——Plan 是平台域表（没有 tenantId 列），
    // 而且这一刻请求方还没有任何租户上下文。
    const rows = await this.raw.client.plan.findMany({
      where: { status: 'ENABLED' },
      orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }],
    })
    return {
      signupEnabled: isSignupOpen(this.config.get('SIGNUP_ENABLED')),
      trialDays: this.trialDays(),
      plans: rows.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        firstPriceCents: row.firstPriceCents,
        renewPriceCents: row.renewPriceCents,
        periodMonths: row.periodMonths,
        sort: row.sort,
      })),
    }
  }

  /**
   * slug 查重。
   *
   * 形状与保留字用 `validateSlug`（纯函数，与落库那一步是同一个），
   * 只有形状过了才去查库——形状不合法的输入不该产生一次数据库往返。
   *
   * 这个接口是 `lookup` 档（防批量枚举，不是防爆破）而不是 `signup` 档：
   * 注册页要边打字边查，用 `signup` 档（一天 3 次）的话第四个字就查不动了。
   */
  async checkSlug(raw: string): Promise<CheckSlugResult> {
    const checked = validateSlug(raw)
    if (!checked.ok) {
      return {
        slug: String(raw ?? '')
          .trim()
          .toLowerCase(),
        available: false,
        reason: checked.message,
      }
    }
    // raw-reason: 自助注册——slug 全局唯一性检查天然跨租户（Tenant 是平台域表）。
    const taken = await this.raw.client.tenant.findUnique({ where: { slug: checked.value } })
    return {
      slug: checked.value,
      available: taken === null,
      reason: taken === null ? null : '这个店铺路径已经被占用了',
    }
  }

  /**
   * 注册一家店。
   *
   * 顺序是想清楚的：**开关 → 验证码 → 口令强度 → 手机号维度限流 → 事务**。
   * 限流那一步刻意排在最后一道校验之后、事务之前：排在最前面的话，
   * 一个连验证码都填错的人也会消耗掉这个手机号今天的额度，
   * 而那个手机号的主人什么也没做。
   *
   * @throws `BizException` 见 `signup.rules.ts` 的映射表
   */
  async signup(dto: SignupDto): Promise<SignupResult> {
    if (!isSignupOpen(this.config.get('SIGNUP_ENABLED'))) {
      throw new BizException(SIGNUP_DISABLED.code, SIGNUP_DISABLED.message)
    }

    // 验证码：两个字段都不给就跳过（前端还没接的联调期），给了就必须对。
    // 「给了但错了」不能放行——放行的话前端随便填一个就等于没有验证码。
    if (dto.captchaId !== undefined || dto.captchaCode !== undefined) {
      const passed = await this.captcha.verify(dto.captchaId, dto.captchaCode)
      if (!passed) throw new BizException(ErrorCode.BAD_REQUEST, '验证码不对或已失效，换一张')
    }

    // 口令强度先判——理由见文件头「为什么口令强度要在进事务之前判」。
    // 用的是 provision 导出的同一个函数，不是这里另写一遍。
    try {
      assertOwnerPasswordPolicy(dto.password)
    } catch (error) {
      throw this.toBizException(error)
    }

    const phone = normalizePhone(dto.phone)
    // 记在动作**之前**：记在后面的话，抛异常的那些分支就漏记了，
    // 而扫名单产生的恰恰全是异常分支。这一档 `counts: 'requests'`，成功也计数。
    await this.authFlow.countAttempt('signup', phone)

    const trialDays = this.trialDays()

    try {
      // raw-reason: 自助注册——建店事务全程跨租户（这一刻租户还不存在，注入不了 tenantId）。
      const created = await this.raw.client.$transaction(async (tx) => {
        // 已有账号时用他填的**现有**口令去验；没有账号时用他新设的口令去建。
        // 这一步查库放在事务里，是为了和 provision 自己那次 findUnique 处在同一个快照下——
        // 事务外判会有「判完到建之间账号被建出来了」的缝，那条缝的后果是
        // 拿一个不该被当成新口令的字符串去建账号。
        const account = await tx.staffAccount.findUnique({ where: { phone } })
        const ownerPassword = account === null ? dto.password : (dto.existingPassword ?? '')

        const result = await provisionTenant(
          tx,
          {
            slug: dto.slug,
            name: dto.name,
            ownerPhone: dto.phone,
            ownerPassword,
            // 显式给天数 = 恒为 TRIAL，理由见 `resolveSignupTrialDays` 的 TSDoc。
            trialDays,
            source: 'SIGNUP',
          },
          createProvisionDeps(),
        )

        // 审计与建店同一个事务：回滚就一起没有。自助注册没有操作者，
        // `buildProvisionAudit` 会把 actor 记成新店主自己的账号 id。
        const payload = buildProvisionAudit(
          { slug: dto.slug, name: dto.name, ownerPhone: dto.phone, source: 'SIGNUP' },
          result,
        )
        await this.audit.recordPlatform(
          {
            ...payload,
            // 没有人按下这个动作，执行体是系统本身——与平台运营手工开店区分开，
            // 审计页才回答得了「这家店是自己注册进来的还是运营开的」。
            actorType: 'SYSTEM',
            actorName: `signup:${payload.after.slug as string}`,
          },
          tx,
        )

        // raw-reason: 自助注册——回读刚建好的租户行拿 trialEndAt，Tenant 是平台域表。
        const row = await tx.tenant.findUnique({ where: { id: result.tenantId } })
        return { row: row as NonNullable<typeof row>, result }
      })

      const accountCreated = created.result.created.account
      return {
        tenantId: created.result.tenantId,
        slug: created.row.slug,
        name: created.row.name,
        trialEndAt: (created.row.trialEndAt ?? created.row.planExpireAt)?.toISOString() ?? '',
        trialDays,
        accountCreated,
        adminLoginPath: '/admin/login',
        message: accountCreated
          ? `店铺已开通，${String(trialDays)} 天试用。请用刚才设置的密码登录后台。`
          : `店铺已开通，${String(trialDays)} 天试用。` +
            '这家店挂在你原有的账号下，登录密码还是原来那个（没有被改动）。',
      }
    } catch (error) {
      throw this.toBizException(error)
    }
  }

  /** `SIGNUP_TRIAL_DAYS` → 落库的试用天数。 */
  private trialDays(): number {
    return resolveSignupTrialDays(this.config.get('SIGNUP_TRIAL_DAYS'))
  }

  /**
   * `ProvisionError` → `BizException`；其它异常原样抛（让它变成 500，别伪装成业务错）。
   *
   * 映射表在 `signup.rules.ts`，那是一个纯函数、有单测——错误码这种东西
   * 写在 service 里就没人测得动了。
   */
  private toBizException(error: unknown): unknown {
    if (!isProvisionError(error)) return error
    const failure = mapProvisionFailure(error.reason, error.message)
    // 走到这里说明凭据类失败被合并了，日志里留下真实原因，否则线上排查无从下手。
    if (failure === CREDENTIAL_FAILURE) {
      this.logger.warn(
        `凭据类失败被合并成 1140100「手机号或密码不对」，真实 reason=${error.reason}`,
        'signup',
      )
    }
    return new BizException(failure.code, failure.message)
  }
}
