/**
 * 租户解析链与中间件（蓝图 §4.1、spec 16）。
 *
 * @packageDocumentation
 */

import { Inject, Injectable, type NestMiddleware } from '@nestjs/common'
import { ErrorCode } from '@taizan/contracts'
import { BizException, patchCurrentContext } from '@taizan/nest-core'
import type { NextFunction, Request, Response } from 'express'
import { TENANT_RESOLVERS } from '../tokens'
import {
  isApiPath,
  isTenantFreePath,
  isTokenOnlyTenantPath,
  requestPath,
  type ResolvableRequest,
  type TenantResolverStrategy,
} from './strategy'

/** 一次解析的结果（带上是哪条策略赢的，便于排查）。 */
export interface TenantResolution {
  tenantId: string
  /** 命中的策略名。 */
  by: string
}

/**
 * 按顺序跑策略链，第一个非 null 的赢。
 *
 * 做成一个独立的类（而不是把 for 循环写在中间件里）只为一件事：**可单测**。
 * 「token 已给 tenantId 时后面的策略一次都不该被调用」这条不变量，
 * 用假策略数组断言调用次数最直观；混在中间件里就得起一个 express。
 */
@Injectable()
export class TenantResolverChain {
  constructor(
    @Inject(TENANT_RESOLVERS) private readonly strategies: readonly TenantResolverStrategy[],
  ) {}

  /** 链上的策略名（顺序即优先级），给日志和 spec 用。 */
  get order(): string[] {
    return this.strategies.map((s) => s.name)
  }

  /**
   * 解析。
   *
   * @param req - 请求切片
   * @param options - `serverIssuedOnly: true` 时只跑 `serverIssued` 的策略
   *   （见 `TENANT_TOKEN_ONLY_PREFIXES`）。这是**过滤**而不是重排：顺序仍是注册顺序。
   * @returns 命中的租户；全部策略都不适用时返回 `null`（由调用方决定失败关闭还是放过）
   */
  async resolve(
    req: ResolvableRequest,
    options: { serverIssuedOnly?: boolean } = {},
  ): Promise<TenantResolution | null> {
    for (const strategy of this.strategies) {
      // 客户端可控的来源（请求头 / Host）在 token-only 前缀下**一次都不跑**，
      // 而不是「跑了但结果被忽略」——不跑就不会有多余的一次 DB 查询，也不会有分支。
      if (options.serverIssuedOnly === true && strategy.serverIssued !== true) continue
      const hit = await strategy.resolve(req)
      if (hit) {
        // 这里 return 就是「token 已给 tenantId 则忽略后续策略」的兑现点：
        // TokenTenantResolver 排在链首，它一旦命中，SlugHeader / Subdomain 根本不会被调用，
        // 请求头里塞的别家 slug 也就无从生效。
        return { tenantId: hit.tenantId, by: strategy.name }
      }
    }
    return null
  }
}

/**
 * 租户解析中间件。
 *
 * ## 只做三件事（第一件是这次修的）
 *
 * 0. 路径不在 `/api/` 下——`/health`、Swagger 的 `/docs`——直接放行，压根不跑解析链。
 *    这一步不靠白名单，靠 {@link isApiPath}；理由与事故背景见 `strategy.ts` 里
 *    {@link API_PATH_PREFIX} 的文档。
 * 1. 跑解析链，把结果 `patchCurrentContext({ tenantId })` 写进上下文；
 * 2. 全部失败就抛 `1240400`（**失败关闭**）——
 *    唯一的例外是 `TENANT_TOKEN_ONLY_PREFIXES`（`/api/admin`）：那里只跑 token 策略，
 *    解析不到就留空放行，由 `GlobalAuthGuard` 报 1140100。理由见 `strategy.ts` 那个常量。
 *
 * 刻意**不**做的事：不碰 `req` 上的任何字段（除了读）、不做鉴权、不查成员关系。
 * 「谁往上下文里写了 tenantId」全仓只有这一处，出问题时不用满仓找。
 *
 * ## 注册方式
 *
 * `AuthModule.configure()` 里 `forRoutes('*')` + `exclude(TENANT_FREE_PREFIXES)`。
 * 排除清单不能手抄，必须用那个常量——spec 16 会拿常量和实际 `exclude` 调用比对。
 * 注意 `exclude()` 挡的是 `TENANT_FREE_PREFIXES` 那两条 `/api/*` 前缀，**不覆盖**
 * `/health` `/docs` 这类非 API 路由——那两条路由是靠上面第 0 步在 `use()` 内部放行的，
 * 不是靠装配时的 `exclude()`。也正因如此，第 0 步的判断只写在这一个文件里就够了，
 * 不需要跟着改 `AuthModule.configure()`。
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(@Inject(TenantResolverChain) private readonly chain: TenantResolverChain) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const asResolvable = req as unknown as ResolvableRequest

    const path = requestPath(asResolvable)

    // 最根本的一道：不在 /api/ 下的路径压根不该进租户解析。`forRoutes('*')` 是全量挂载，
    // `exclude()` 只挡得住写在 TENANT_FREE_PREFIXES 里的前缀——而 `/health`、Swagger 的
    // `/docs` 这些框架路由从来没人往那份清单里填过（事故正是这么来的：探活拿到
    // 200 + 1240400 而不是健康报告）。这里判的是「像不像业务 API」而不是「在不在白名单里」，
    // 明天随便加一条新的框架路由（`/metrics` 之类）不需要先想起来改清单。
    if (!isApiPath(path)) {
      next()
      return
    }

    // 双保险：模块装配时已经 exclude 了这些前缀，这里再判一次。
    // 装配是可被下游改坏的（谁手抄一份前缀清单漏了一个），这条判断改不坏。
    if (isTenantFreePath(path)) {
      next()
      return
    }

    const tokenOnly = isTokenOnlyTenantPath(path)

    // 错误一律走 `next(error)` 而不是 `throw`。异步中间件里 throw 出去的 rejection
    // 只有 Express 5 会接住，Nest 自己不接——而「异常有没有进到全局 filter」
    // 这件事不该依赖底层 HTTP 适配器的版本。
    try {
      const hit = await this.chain.resolve(asResolvable, { serverIssuedOnly: tokenOnly })
      if (!hit) {
        if (tokenOnly) {
          // 留空放行，交给 GlobalAuthGuard 报 1140100（未登录）。
          // 这里抢着报 1240400 会让「没带 token 打商家后台」变成「店铺不存在」，
          // 前端于是不跳登录页。理由全文见 strategy.ts 的 TENANT_TOKEN_ONLY_PREFIXES。
          // 不是失败开放：上下文里没有 tenantId，任何 prisma.tenant 查询照样抛 NO_CONTEXT。
          next()
          return
        }
        // 失败关闭。蓝图 §4.1 写的就是「有序、失败关闭」——
        // 放过去等于让后续查询在没有 tenantId 的情况下执行，那是跨租户泄漏的入口。
        next(
          new BizException(
            ErrorCode.TENANT_NOT_FOUND,
            '无法确定当前店铺（token / X-Tenant-Slug / 子域名都没解析出来）',
          ),
        )
        return
      }

      patchCurrentContext({ tenantId: hit.tenantId })
      next()
    } catch (error) {
      next(error)
    }
  }
}
