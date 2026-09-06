/**
 * 把 `TenantScopeError` 翻译成响应包里的业务码。
 *
 * ## 为什么需要它
 *
 * `@taizan/tenant-scope` 是零框架依赖的纯函数包，它抛的是自己的 `TenantScopeError`，
 * 不认识 HTTP、也不认识 7 位错误码。`@taizan/nest-core` 的 `AllExceptionsFilter`
 * 只认 `BizException` 与 `HttpException`，于是一次跨租户越权会掉进「未知异常 → 500 +
 * 9050000」那一支——前端看到的是「系统内部错误」，而它其实是一次**被正确拦下来的**越权。
 *
 * ## 为什么是继承而不是并列一个 `@Catch(TenantScopeError)`
 *
 * 两个理由：
 * 1. `TenantScopeError` 可能在 monorepo 里存在 ESM/CJS 两份副本，`instanceof`
 *    会漏判——这正是那个包自己用 `isTenantScopeError()` 鸭子类型判别的原因。
 *    而 `@Catch(SomeClass)` 的匹配靠的就是 `instanceof`。
 * 2. 并列两个过滤器时，「哪个先被问到」取决于注册顺序，而注册顺序取决于模块实例化顺序
 *    ——同样是那个不该依赖的东西（见 `global-providers.ts` 文件头）。
 *
 * 继承 + `@Catch()`（全捕获）之后：本类先认 `TenantScopeError`，认不出来的原样交给
 * `super.catch()`，行为与只装 core 那个过滤器**完全一致**。没有分叉。
 *
 * ## 映射表
 *
 * | reason | 码 | 为什么 |
 * |---|---|---|
 * | `FOREIGN_RESULT` | `1240300` | 命中的记录属于别家：这就是跨租户越权 |
 * | `TENANT_ID_CONFLICT` | `1240300` | 调用方显式写了别家的 `tenantId`，同上 |
 * | `NO_CONTEXT` | `1240400` | 没解析出当前店（多半是路由前缀配错了），前端提示「店铺不存在」 |
 * | 其它 | 500 | `UNKNOWN_OPERATION` / `MODEL_NOT_REGISTERED` 等**是代码 bug**，不该粉饰成业务错误 |
 *
 * 注意：正常路径下这个过滤器**不该被触发**。业务代码应当自己先确认归属再动手
 * （见 `goods.service.ts` 的 `requireOwned`），那样错误码更准、也不会多打一次探针。
 * 这里是兜底——防止某天有人忘了那一步，让隔离错误变成 500 而不是 403。
 *
 * @packageDocumentation
 */

import { Catch, type ArgumentsHost } from '@nestjs/common'
import { ErrorCode } from '@taizan/contracts'
import { AllExceptionsFilter, BizException } from '@taizan/nest-core'
import { isTenantScopeError } from '@taizan/tenant-scope'

@Catch()
export class TenantScopeExceptionFilter extends AllExceptionsFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    super.catch(this.translate(exception), host)
  }

  /** 认得出来就换成 `BizException`，认不出来原样返回。 */
  private translate(exception: unknown): unknown {
    if (isTenantScopeError(exception, 'FOREIGN_RESULT')) {
      return new BizException(
        ErrorCode.CROSS_TENANT_FORBIDDEN,
        undefined,
        // 不回传原始 message：那里面带着模型名、操作名和当前 tenantId。
        null,
      )
    }
    if (isTenantScopeError(exception, 'TENANT_ID_CONFLICT')) {
      return new BizException(ErrorCode.CROSS_TENANT_FORBIDDEN)
    }
    if (isTenantScopeError(exception, 'NO_CONTEXT')) {
      return new BizException(
        ErrorCode.TENANT_NOT_FOUND,
        '无法确定当前店铺，请重新登录或确认访问地址',
      )
    }
    // UNKNOWN_OPERATION / MODEL_NOT_REGISTERED / INVALID_ARGUMENT 等一律不接：
    // 它们是「有人加了张表忘了登记」或「Prisma 升级出了新操作」，是代码 bug。
    // 包装成业务码等于把一次隔离配置事故降级成用户看得懂的提示，然后没人去修。
    return exception
  }
}
