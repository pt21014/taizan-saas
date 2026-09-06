/**
 * 三个内置租户解析策略。顺序（不能换）：
 *
 * ```
 * TokenTenantResolver  →  SlugHeaderResolver  →  SubdomainResolver
 *   token.tenantId          X-Tenant-Slug          {slug}.example.com
 *   最高优先，不可被          仅 /api/client         C 端独立域名
 *   请求参数覆盖
 * ```
 *
 * 顺序的理由是**优先级从高到低 = 可信度从高到低**：token 是我们自己签的，
 * 请求头和 Host 都是客户端可以随便填的。已登录用户带着 staff token 又塞一个
 * `X-Tenant-Slug: 别人家店`，赢的必须是 token——否则「一号多店」就变成了
 * 「一个 token 打所有店」。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { RawPrismaService } from '@taizan/nest-prisma'
import { extractBearer } from '../guards/global-auth.guard'
import { TOKEN_KINDS } from '../token/jwt-payload'
import { TokenService } from '../token/token.service'
import {
  headerValue,
  requestPath,
  type ResolvableRequest,
  type TenantResolverStrategy,
} from './strategy'

/** `SlugHeaderResolver` 认的请求头。 */
export const TENANT_SLUG_HEADER = 'x-tenant-slug'

/** `SlugHeaderResolver` 只在这个前缀下生效。 */
export const SLUG_HEADER_PREFIX = '/api/client'

/** 这些状态的租户解析不出来（等价于「这家店不存在」）。 */
export const UNRESOLVABLE_TENANT_STATUSES: readonly string[] = ['SUSPENDED', 'DEREGISTERED']

/**
 * 从 token 里取 tenantId。**链上第一个，且不可被任何请求参数覆盖。**
 *
 * ## 为什么这里要再验一次签（守卫马上又要验一遍）
 *
 * 中间件跑在守卫**之前**（Nest 的执行顺序：middleware → guard → interceptor → handler），
 * 所以这时候 `req.principal` 还不存在，只能自己解 token。
 *
 * 那能不能不验签、直接 base64 解出 payload 读 tenantId？**绝对不行**。
 * 不验签的解码等于让任何人自己写一个 `{"tenantId":"别人家店"}` 的串，
 * 而 `tenantId` 是整个隔离体系的输入。多一次 HMAC（微秒级）换掉一个越权洞，
 * 这个价格没什么可讨论的。
 *
 * ## 拿不到就返回 null，不抛错
 *
 * token 缺失/过期/伪造在这里一律当成「本策略不适用」，交给后面的策略；
 * 真正的 401 由 `GlobalAuthGuard` 报——那里才知道这个路由是不是 `@Public()`。
 * 在中间件里抢着报 401 会让公开接口带一个坏 token 就 401，而它本该放行。
 */
@Injectable()
export class TokenTenantResolver implements TenantResolverStrategy {
  readonly name = 'token'

  /**
   * 租户来自我们自己签名的 token，是唯一「服务端签发」的来源。
   *
   * 这个标记决定了它是 {@link TENANT_TOKEN_ONLY_PREFIXES}（`/api/admin`）下**唯一**
   * 会被执行的策略：商家后台的当前店铺只能由 token 决定，请求头与 Host 一概不作数。
   */
  readonly serverIssued = true

  constructor(@Inject(TokenService) private readonly tokens: TokenService) {}

  async resolve(req: ResolvableRequest): Promise<{ tenantId: string } | null> {
    const token = extractBearer(req.headers['authorization'])
    if (!token) return null

    for (const kind of TOKEN_KINDS) {
      try {
        const payload = await this.tokens.verify(kind, token)
        // platform token 没有 tenantId，这是正常情况（它跨租户）。返回 null 让链继续。
        return payload.tenantId ? { tenantId: payload.tenantId } : null
      } catch {
        // 换下一把密钥。全部失败就当没带 token。
      }
    }
    return null
  }
}

/** Prisma `Tenant` 行里本策略要的两个字段。 */
interface TenantRow {
  id: string
  status: string
}

interface TenantDelegate {
  findFirst(args: unknown): Promise<TenantRow | null>
}

/**
 * `X-Tenant-Slug` 头 → 查 `Tenant.slug` → tenantId。**只在 `/api/client` 下生效。**
 *
 * ## 为什么限定前缀
 *
 * 这个头是客户端可以随手填的。放开到全站的话，商家后台（`/api/admin`）上一个
 * 带着 staff token 的请求再塞一个别家店的 slug，就多了一条本不该存在的攻击面——
 * 虽然 token 策略排在前面会赢，但「多一条永远不该被走到的分支」本身就是隐患。
 * 小程序/H5（`/api/client`）在用户还没登录时确实需要靠它选店，那是它唯一的正当用途。
 *
 * ## 为什么走 `prisma.raw`
 *
 * 这一步的目的就是**算出 tenantId**，此刻上下文里还没有它，`prisma.tenant` 必然抛错。
 */
@Injectable()
export class SlugHeaderResolver implements TenantResolverStrategy {
  readonly name = 'slug-header'

  // raw-reason: 登录/鉴权跨租户找账号——按 slug 定位租户是「算出 tenantId」这一步本身，
  // 此时上下文里还没有 tenantId，prisma.tenant 必然抛 TenantScopeError。
  constructor(@Inject(RawPrismaService) private readonly raw: RawPrismaService) {}

  async resolve(req: ResolvableRequest): Promise<{ tenantId: string } | null> {
    const path = requestPath(req)
    if (path !== SLUG_HEADER_PREFIX && !path.startsWith(`${SLUG_HEADER_PREFIX}/`)) return null

    const slug = headerValue(req, TENANT_SLUG_HEADER)
    if (!slug) return null
    return lookupBySlug(this.raw, slug)
  }
}

/**
 * 子域名 → `Tenant.slug` → tenantId。链上最后一个。
 *
 * `shop-a.example.com` 取第一段 `shop-a` 当 slug。`baseDomain` 用来剥掉根域，
 * 不配的话就直接取 Host 的第一段——本地开发（`localhost`、`127.0.0.1`）取不出东西，
 * 返回 null，链失败关闭。
 */
@Injectable()
export class SubdomainResolver implements TenantResolverStrategy {
  readonly name = 'subdomain'

  /**
   * @param raw - 无租户注入的 Prisma 句柄
   * @param baseDomain - 根域，如 `example.com`。Host 不以它结尾时本策略不适用
   * @param ignoredSubdomains - 不当作 slug 的保留子域（`www`、`api`、`admin` 之类）
   */
  // raw-reason: 登录/鉴权跨租户找账号——按子域名定位租户是「算出 tenantId」这一步本身。
  constructor(
    @Inject(RawPrismaService) private readonly raw: RawPrismaService,
    private readonly baseDomain?: string,
    private readonly ignoredSubdomains: readonly string[] = ['www', 'api', 'admin', 'platform'],
  ) {}

  async resolve(req: ResolvableRequest): Promise<{ tenantId: string } | null> {
    const host = (req.hostname ?? headerValue(req, 'host') ?? '').toLowerCase()
    // 去掉端口。
    const bare = host.split(':')[0] ?? ''
    if (!bare) return null

    let sub: string | undefined
    if (this.baseDomain) {
      const suffix = `.${this.baseDomain.toLowerCase()}`
      if (!bare.endsWith(suffix)) return null
      sub = bare.slice(0, -suffix.length)
      // 多级子域（`a.b.example.com`）不认：哪一段是 slug 没有确定答案，
      // 猜一个不如明确地不支持。
      if (sub.includes('.')) return null
    } else {
      const parts = bare.split('.')
      // 至少要 `sub.domain.tld` 三段才谈得上子域。
      if (parts.length < 3) return null
      sub = parts[0]
    }

    if (!sub || this.ignoredSubdomains.includes(sub)) return null
    return lookupBySlug(this.raw, sub)
  }
}

/** 两个策略共用的 slug 查询。 */
async function lookupBySlug(
  raw: RawPrismaService,
  slug: string,
): Promise<{ tenantId: string } | null> {
  const tenant = (raw.client as Record<string, unknown>).tenant as TenantDelegate | undefined
  if (!tenant) {
    throw new Error(
      '[@taizan/nest-auth] Prisma 客户端上没有 tenant 模型，schema 是否漏了 01-tenant？',
    )
  }
  // raw-reason: 登录/鉴权跨租户找账号——slug → tenantId 的映射表本身是平台域数据。
  const row = await tenant.findFirst({ where: { slug }, select: { id: true, status: true } })
  if (!row) return null
  // 封停/已注销的店在这里就不给解析出来（`TenantStatus` 的 SUSPENDED / DEREGISTERED）。
  // 让它解析成功、再由后面的闸门拦，会多出一整条「租户存在但不可用」的分支要每个下游都处理。
  // 注意 TRIAL 与 ACTIVE 都要放行——到期是**现算**的，不落状态位（蓝图 §9）。
  if (UNRESOLVABLE_TENANT_STATUSES.includes(row.status)) return null
  return { tenantId: row.id }
}
