/**
 * 全局守卫：**默认拒绝**（蓝图 §9 xiaodian 第 1 条）。
 *
 * ## 「默认拒绝」到底是什么意思
 *
 * 它注册成 `APP_GUARD`，对**每一个**路由生效。所以一个新写的控制器，
 * 什么装饰器都不加时的行为是 401，而不是裸奔。想公开就必须显式 `@Public()`——
 * 把「开洞」变成一个需要动手写、能被 code review 看见、能被 spec 5 静态扫出来的动作。
 *
 * 反过来的设计（默认放行 + 逐控制器 `@UseGuards`）的失败模式是：漏写一个装饰器，
 * 一个内部接口就对全世界开放，而且没有任何东西会报错。这类事故在两个老项目上都发生过。
 *
 * ## 守卫链里的位置
 *
 * ```
 * GlobalAuthGuard → PermissionsGuard → BillingGateGuard → (拦截器) DataScopeInterceptor → AuditInterceptor
 * ```
 *
 * 顺序在 `apps/api/src/bootstrap/app.module.ts` 一处定死（T0-8）。本守卫必须最靠前：
 * 后面每一个都要读 `req.principal`。
 *
 * @packageDocumentation
 */

import {
  Inject,
  Injectable,
  Optional,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { AppLogger, BizException, patchCurrentContext } from '@taizan/nest-core'
import { AUTH_KINDS_KEY, IS_PUBLIC_KEY, RATE_LIMIT_KEY } from '../decorators'
import type { MembershipProvider } from '../membership/membership.provider'
import type { AuthPrincipal, RequestWithPrincipal } from '../principal'
import { SessionService } from '../session/session.service'
import { AUTH_ERRORS, TOKEN_KINDS, type TokenKind, type TokenPayload } from '../token/jwt-payload'
import { TokenService } from '../token/token.service'
import { MEMBERSHIP_PROVIDER } from '../tokens'

/**
 * 从 `Authorization` 头里剥出 token。
 *
 * **强制 `Bearer ` 前缀**（大小写不敏感），不接受裸串。xiaodian 用的是裸串，
 * 结果是任何一个把整个头当 token 传的客户端都能「碰巧」工作，直到某天有人加了个
 * 标准的 `Bearer ` 前缀然后线上炸掉。只认一种格式，前后端就没有解释空间。
 *
 * @returns token 串；头不存在或格式不对返回 `undefined`
 */
export function extractBearer(raw: unknown): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return undefined
  const match = /^Bearer\s+(\S+)$/i.exec(value.trim())
  return match?.[1]
}

/** `Reflector.getAllAndOverride` 的第二个参数类型（handler + class）。 */
type ReflectorTargets = Parameters<Reflector['getAllAndOverride']>[1]

@Injectable()
export class GlobalAuthGuard implements CanActivate {
  /** 已经就「某个公开路由没声明限流档位」警告过的路由 key，避免每请求刷屏。 */
  private readonly warnedRoutes = new Set<string>()

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(MEMBERSHIP_PROVIDER) private readonly memberships: MembershipProvider,
    @Optional() @Inject(AppLogger) private readonly logger?: AppLogger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 只管 HTTP。ws / rpc / 队列消费者各有各的认证方式，硬套 Authorization 头没有意义。
    if (context.getType() !== 'http') return true

    // Reflector 期望的入参类型（`(Type | Function)[]`），抽出来复用。
    const targets: ReflectorTargets = [context.getHandler(), context.getClass()]
    // getAllAndOverride：方法上的声明覆盖类上的。控制器整体 @Auth('staff')、
    // 其中一个方法 @Public() 是很常见的形状（比如后台里的一个公开分享页）。
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) === true

    if (isPublic) {
      this.warnIfUnthrottled(context, targets)
      return true
    }

    const req = context.switchToHttp().getRequest<RequestWithPrincipal>()
    const token = extractBearer(req.headers['authorization'])
    if (!token) {
      throw new BizException(AUTH_ERRORS.UNAUTHENTICATED)
    }

    const declared = this.reflector.getAllAndOverride<TokenKind[]>(AUTH_KINDS_KEY, targets)
    // 没写 @Auth() 就是「任何一种有效身份都行，但必须登录」。
    const accepted: readonly TokenKind[] = declared?.length ? declared : TOKEN_KINDS

    const payload = await this.verifyAgainst(accepted, token)

    // 会话必须还活着。这条把「改密立即失效」「踢最旧端」从愿望变成事实。
    if (!(await this.sessions.isAlive(payload.kind, payload.sub, payload.jti))) {
      throw new BizException(AUTH_ERRORS.UNAUTHENTICATED, '登录状态已失效，请重新登录')
    }

    const principal = await this.buildPrincipal(payload)
    req.principal = principal

    // 上下文里的 tenantId **只来自 token**（蓝图 §4.1：TokenTenantResolver 优先级最高
    // 且不可被请求参数覆盖）。这里刻意不读 req.params / req.query / 任何头。
    patchCurrentContext({
      identity: {
        kind: principal.kind,
        id: principal.id,
        ...(principal.accountId !== undefined ? { accountId: principal.accountId } : {}),
      },
      ...(principal.tenantId !== undefined ? { tenantId: principal.tenantId } : {}),
    })

    return true
  }

  /**
   * 先认出这个 token **到底是什么身份**，再判断它配不配打这条路由。
   *
   * ## 为什么不是「按 accepted 逐个试，都失败就报错」
   *
   * 那样做的话，「签名根本不对的伪造串」和「合法的 member token 打了 staff 接口」
   * 会走到同一个分支，只能二选一地报错——报 1140102 会让伪造攻击收到一句
   * 「凭证类型不符」的提示（等于告诉他换个 kind 再试），报 1140100 又会让真用户
   * 拿着好好的 member token 打 admin 接口时看到「未登录」（他明明登录了）。
   *
   * 所以分两步：**先对三把密钥都试一遍**认出真实 kind（这一步是 3 次 HMAC，
   * 微秒级），再拿真实 kind 去比对本路由的 accepted 清单。两种失败于是有了
   * 各自准确的错误码。
   */
  private async verifyAgainst(
    accepted: readonly TokenKind[],
    token: string,
  ): Promise<TokenPayload> {
    let expired = false
    // 「签名验过了，但这串东西不该拿来访问接口」——目前只有一种：refresh 当 access 用。
    let signedButWrongType = false

    for (const kind of TOKEN_KINDS) {
      let payload: TokenPayload
      try {
        payload = await this.tokens.verify(kind, token)
      } catch (error) {
        if (error instanceof BizException) {
          if (error.code === AUTH_ERRORS.TOKEN_EXPIRED.code) expired = true
          if (error.code === AUTH_ERRORS.KIND_MISMATCH.code) signedButWrongType = true
        }
        continue
      }
      // 认出来了。它是不是本路由接受的身份，是另一个问题。
      if (!accepted.includes(payload.kind)) {
        throw new BizException(AUTH_ERRORS.KIND_MISMATCH)
      }
      return payload
    }

    // 三把密钥都不认。过期优先于「签名不对」——用户的 token 过期了，
    // 报「登录已过期」比报「未登录」有用得多（前端可以去静默刷新）。
    if (expired) throw new BizException(AUTH_ERRORS.TOKEN_EXPIRED)
    if (signedButWrongType) throw new BizException(AUTH_ERRORS.KIND_MISMATCH)
    throw new BizException(AUTH_ERRORS.UNAUTHENTICATED)
  }

  /**
   * 组装主体。staff 会在这里**现查库并用库里的角色覆盖 token**。
   */
  private async buildPrincipal(payload: TokenPayload): Promise<AuthPrincipal> {
    const principal: AuthPrincipal = {
      kind: payload.kind,
      id: payload.sub,
      jti: payload.jti,
    }
    if (payload.tenantId !== undefined) principal.tenantId = payload.tenantId
    if (payload.accountId !== undefined) principal.accountId = payload.accountId

    if (payload.kind !== 'staff') return principal

    // ── 以下是蓝图 §4.3 那条关键不变量 ──────────────────────────────────
    if (!payload.accountId || !payload.tenantId) {
      // staff token 缺这两个字段说明它是手工拼的或者是老版本的，一律拒。
      throw new BizException(AUTH_ERRORS.UNAUTHENTICATED, '登录状态已失效，请重新登录')
    }

    const membership = await this.memberships.membershipById(payload.accountId, payload.tenantId)
    if (!membership) {
      throw new BizException(AUTH_ERRORS.UNAUTHENTICATED, '你已不在这家店铺中，请重新登录')
    }
    if (membership.status !== 'ACTIVE') {
      throw new BizException(AUTH_ERRORS.UNAUTHENTICATED, '这家店铺已停用你的账号')
    }
    // token 里可能也带了 sub（Staff.id），但以库里那条为准：换店 / 重建成员关系
    // 都会让 Staff.id 变，而旧 token 里还是老的。
    principal.id = membership.staffId
    principal.roleIds = membership.roleIds
    principal.dataScope = membership.dataScope
    principal.isOwner = membership.isOwner
    return principal
  }

  /**
   * 公开路由没声明限流档位就 warn 一次。
   *
   * 这里只 warn 不拒绝：拒绝会让「加一个公开接口」变成一次运行时事故，
   * 而 spec 5（`guard-default-deny.spec.ts`）在 CI 上做静态扫描，那才是该拦住它的地方。
   * 运行时这条 warn 的价值在于：本地开发时立刻看见，不用等 CI。
   */
  private warnIfUnthrottled(context: ExecutionContext, targets: ReflectorTargets): void {
    const tier = this.reflector.getAllAndOverride<string>(RATE_LIMIT_KEY, targets)
    if (tier) return

    const key = `${context.getClass().name}.${context.getHandler().name}`
    if (this.warnedRoutes.has(key)) return
    this.warnedRoutes.add(key)
    this.logger?.warn(
      `公开路由 ${key} 声明了 @Public() 却没有 @RateLimited(tier)——它是一个没有限流的爆破入口。` +
        `spec 5（guard-default-deny）会在 CI 上把这条升级成失败。`,
      'GlobalAuthGuard',
    )
  }
}
