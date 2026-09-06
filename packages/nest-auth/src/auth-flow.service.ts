/**
 * 登录 / 换店 / 登出 / 改密的**业务动作**（不含 HTTP）。
 *
 * ## 为什么控制器不在本包
 *
 * 控制器要定 URL、DTO、Swagger 注解、限流档位——这些都是**应用**的决定，不是框架的。
 * `apps/api`（T0-8）里那个 `AuthController` 会是薄薄一层，把 HTTP 形状翻译成这里的调用。
 * 框架给能力，应用定接口，这条线不模糊掉，下游想换 URL、想加字段就不用改框架。
 *
 * @packageDocumentation
 */

import { Inject, Injectable, Optional } from '@nestjs/common'
import { BizException } from '@taizan/nest-core'
import { RateLimitService } from './ratelimit/rate-limit.service'
import type { MembershipProvider } from './membership/membership.provider'
import type { AuthPrincipal } from './principal'
import { SessionService } from './session/session.service'
import { AUTH_ERRORS, TOKEN_PAYLOAD_VERSION, type TokenKind } from './token/jwt-payload'
import { TokenService, type TokenPair } from './token/token.service'
import { AUTH_TTL, MEMBERSHIP_PROVIDER } from './tokens'
import type { TokenTtlConfig } from './token/ttl'

/** 登录成功后发给客户端的一对 token。 */
export interface IssuedTokens extends TokenPair {
  /** access 的有效期（秒），前端拿它算什么时候该刷新。 */
  expiresIn: number
}

/** {@link AuthFlowService.loginStaff} 的结果。 */
export interface StaffLoginResult extends IssuedTokens {
  /** 本次会话对应的 `Staff.id`。 */
  staffId: string
  tenantId: string
  /** 因为超出端数上限被踢下线的 jti（可据此发通知）。 */
  evicted: string[]
}

/**
 * 认证流程服务。
 *
 * **不负责校验口令**——口令哈希与校验在 `@taizan/prisma-base` 的 `seed/password.ts`
 * （`verifyPassword` / `hashPassword`，scrypt），由 `apps/api` 的控制器在调
 * {@link loginStaff} 之前完成。分开的理由：口令校验要读 `StaffAccount` 表、要处理
 * 失败计数与锁定、要判 `needsRehash` 回写——那些是应用层逻辑，塞进来会让本服务
 * 长出一堆对具体表结构的依赖。
 */
@Injectable()
export class AuthFlowService {
  constructor(
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(MEMBERSHIP_PROVIDER) private readonly memberships: MembershipProvider,
    @Inject(AUTH_TTL) private readonly ttl: TokenTtlConfig,
    /**
     * 限流。`@Optional()` 是给「只想要发 token、不想要限流」的最小装配留的口子，
     * 但 `AuthModule.forRoot` 默认一定会提供它——**别在生产里让它是 undefined**。
     */
    @Optional() @Inject(RateLimitService) private readonly rateLimit?: RateLimitService,
  ) {}

  /**
   * 给账号维度记一次。**成功也记**。
   *
   * ## 为什么成功也记
   *
   * 「只在失败时记」对登录是对的（正常人频繁登录不该被自己拦下），但那条规则
   * 有一个前提：这一档拦的是「反复试口令」。注册、发验证码、换店这些档拦的是
   * 「一个人做了太多次这件事」，而那种行为**每次都是成功的**——只算失败的话，
   * 正好把要拦的那种放过去了（knowledge 的证书查验档踩过这个坑）。
   *
   * 所以这里的语义统一成「记一次尝试」，放在动作**之前**调：
   * 之后调的话，抛异常的那些分支就漏记了，而爆破产生的恰恰全是异常分支。
   *
   * ## 为什么只算账号维度
   *
   * 客户端 IP / 入口 IP 两维已经由 `RateLimitGuard` 在同一个请求上算过了。
   * 这里再算一遍等于同一次请求被计两次，实际额度直接减半——
   * 而「限流变严了」这种错在测试里看不出来。
   *
   * @param tier - 档位名（`login` / `sms-code` / `signup` …）
   * @param account - 账号标识：`StaffAccount.id`、手机号、用户名都行，大小写不敏感
   * @throws `RateLimitedException` 该账号在窗口内的尝试次数超额（HTTP 429 + 1042900）
   */
  async countAttempt(tier: string, account: string): Promise<void> {
    await this.rateLimit?.consume(tier, { account, dimensions: ['account'] })
  }

  /**
   * 发送短信验证码前的闸门。
   *
   * 这一档花的是真钱，而且是短信轰炸机的目标——被轰的是那个手机号的主人，
   * 他什么也没做。所以账号维度用手机号本身，而不是「谁在请求」。
   *
   * 真正发短信由 `@taizan/nest-notify` 做，这里只负责「还能不能发」。
   *
   * @param phone - 收短信的手机号
   */
  async guardSmsCode(phone: string): Promise<void> {
    await this.countAttempt('sms-code', phone)
  }

  /**
   * 商家员工登录：校验成员关系 → 签 token → 登记会话。
   *
   * 调用方必须**已经**校验过口令。这里只做「这个账号在这家店里还有效吗」。
   *
   * @param accountId - `StaffAccount.id`（口令校验的产物）
   * @param tenantId - 要进的店
   * @throws `BizException` 1140100 成员关系不存在或已停用
   */
  async loginStaff(accountId: string, tenantId: string): Promise<StaffLoginResult> {
    // 先记一次再干活：成员关系不存在会在下一行抛，记在后面就漏掉了这条分支，
    // 而「拿一堆 accountId 挨个试哪个在这家店里」正好全落在这条分支上。
    await this.countAttempt('login', accountId)
    const membership = await this.requireActiveMembership(accountId, tenantId)

    const access = await this.tokens.sign('staff', {
      sub: membership.staffId,
      tenantId,
      accountId,
      ver: TOKEN_PAYLOAD_VERSION,
    })
    const payload = await this.tokens.verify('staff', access)
    const evicted = await this.sessions.add(
      'staff',
      membership.staffId,
      payload.jti,
      this.ttl.access.staff,
    )
    const refresh = await this.tokens.issueRefresh('staff', membership.staffId, {
      tenantId,
      accountId,
    })

    return {
      access,
      refresh,
      expiresIn: this.ttl.access.staff,
      staffId: membership.staffId,
      tenantId,
      evicted,
    }
  }

  /**
   * 平台超管 / C 端会员登录：签 token + 登记会话。
   *
   * @param kind - `'platform'` 或 `'member'`
   * @param sub - 主体 id
   * @param tenantId - member 必传（会员归属单店）；platform 不传
   */
  async login(
    kind: Exclude<TokenKind, 'staff'>,
    sub: string,
    tenantId?: string,
  ): Promise<IssuedTokens & { evicted: string[] }> {
    if (kind === 'member' && !tenantId) {
      throw new TypeError('[@taizan/nest-auth] member 登录必须给 tenantId（会员归属单个租户）')
    }

    await this.countAttempt('login', sub)

    const extra = tenantId !== undefined ? { tenantId } : {}
    const access = await this.tokens.sign(kind, { sub, ver: TOKEN_PAYLOAD_VERSION, ...extra })
    const payload = await this.tokens.verify(kind, access)
    const evicted = await this.sessions.add(kind, sub, payload.jti, this.ttl.access[kind])
    const refresh = await this.tokens.issueRefresh(kind, sub, extra)

    return { access, refresh, expiresIn: this.ttl.access[kind], evicted }
  }

  /**
   * 换店：校验目标店的成员关系后**重签一个新 token**。
   *
   * ## 为什么是重签而不是「改一下 token 里的 tenantId」
   *
   * token 是签过名的，改不了。更本质的原因是蓝图 §4.3 那条不变量：
   * **staff token 一次只绑一家店**。一个能同时代表多家店的 token 会让每一处隔离判断
   * 都要多问一句「这次是哪家」，而漏问一处就是跨租户泄漏。
   *
   * ## 取舍：**不吊销旧 token**（附录第 5 条，已由负责人拍板接受）
   *
   * 换店之后旧 token 仍然可以访问原来那家店，直到它自己过期（staff 最长 8 小时）。
   *
   * - **换来的**：多标签页各开一家店。这是一号多店老板的真实用法——
   *   左边标签盯 A 店的订单，右边标签改 B 店的菜单。主动吊销旧 token 会让
   *   「在新标签页打开另一家店」这个动作把老标签页踢掉，用户会认为是 bug。
   * - **代价**：从 A 店离职的人，如果他在离职生效**之前**恰好开着 A 店的 token，
   *   那个 token 还能用最多 8 小时。
   * - **代价为什么可接受**：成员关系是**每请求现查**的（`MembershipProvider`，30 秒缓存）。
   *   把他从 A 店移除的那一刻起，最多 30 秒后旧 token 就会在 `GlobalAuthGuard` 里
   *   撞上「membership 为空」而 401。也就是说真正的兜底是成员关系，不是 token 的生死。
   * - **真出事了怎么办**：`SessionService.revokeAll(kind, sub)` 一把全撤，
   *   改密、管理员强制下线走的都是这条路。
   *
   * @param principal - 当前身份（必须是 staff）
   * @param targetTenantId - 目标店
   * @returns 新的一对 token
   * @throws `BizException` 1140100 目标店没有该账号的有效成员关系
   */
  async switchTenant(principal: AuthPrincipal, targetTenantId: string): Promise<StaffLoginResult> {
    if (principal.kind !== 'staff' || !principal.accountId) {
      throw new BizException(AUTH_ERRORS.KIND_MISMATCH, '只有商家员工可以切换店铺')
    }
    // 用 accountId（而不是前端传来的任何东西）去查目标店的成员关系——
    // 「他名下有哪些店」这个判断必须在服务端做，否则换店就变成了越权入口。
    // 计数由 loginStaff 里那次 countAttempt 完成（换店本质上就是重新登录一次），
    // 所以这里**不要**再记一次，否则老板切两次店就消耗了四次额度。
    return this.loginStaff(principal.accountId, targetTenantId)
  }

  /**
   * 登出：只吊销**当前这一条**会话。
   *
   * 其它端不受影响——「在手机上退出登录」不该把收银台一起踢掉。
   * 想全退用 {@link logoutAll}。
   */
  async logout(principal: AuthPrincipal): Promise<void> {
    await this.sessions.revokeOne(principal.kind, principal.id, principal.jti)
  }

  /** 全端退出。 */
  async logoutAll(principal: AuthPrincipal): Promise<void> {
    await this.sessions.revokeAll(principal.kind, principal.id)
  }

  /**
   * 改密之后的收尾：**全端撤销**。
   *
   * 这是「改密即全撤」（蓝图 §4.3）的兑现点。改密的动机通常就是「我怀疑号被盗了」，
   * 这时候还留着别的端在线，改密就白改了。
   *
   * 口令本身的哈希与写库由调用方完成（`hashPassword` 在 `@taizan/prisma-base`），
   * 这里只管清会话。**顺序很重要**：先写库、后清会话——反过来的话，
   * 清完会话到写库成功之间如果进程挂了，用户会用着旧口令但被踢下线，
   * 而他不知道为什么。
   *
   * @param kind - 身份类型
   * @param sub - 主体 id
   */
  async changePassword(kind: TokenKind, sub: string): Promise<void> {
    await this.sessions.revokeAll(kind, sub)
  }

  /** 用 refresh 换一对新 token（一次性轮换，见 `TokenService.rotateRefresh`）。 */
  async refresh(token: string): Promise<IssuedTokens> {
    const pair = await this.tokens.rotateRefresh(token)
    const payload = await this.tokens.verifyRefresh(pair.refresh)
    return { ...pair, expiresIn: this.ttl.access[payload.kind] }
  }

  private async requireActiveMembership(
    accountId: string,
    tenantId: string,
  ): Promise<{ staffId: string }> {
    const membership = await this.memberships.membershipById(accountId, tenantId)
    if (!membership) {
      // 刻意不说「这家店不存在」——那会让攻击者能用这个接口枚举 tenantId。
      throw new BizException(AUTH_ERRORS.UNAUTHENTICATED, '这家店铺不在你名下')
    }
    if (membership.status !== 'ACTIVE') {
      throw new BizException(AUTH_ERRORS.UNAUTHENTICATED, '这家店铺已停用你的账号')
    }
    return membership
  }
}
