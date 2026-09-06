/**
 * 把 `@taizan/ratelimit-core` 的 `resolveIps` 接到 `@taizan/nest-core` 的 {@link IP_RESOLVER} 上。
 *
 * 这是「不变量 6 的真源」落到运行时的那一处接线：接上之后，
 * `currentContext().ip.client` 就是**从 XFF 末尾倒数 `TRUSTED_PROXY_HOPS` 段**得到的值，
 * 限流、审计、风控全都从那里取，全仓再没有第二处读 `x-forwarded-for` 的地方。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import {
  ConfigService,
  type IpResolver,
  type IpSource,
  type ResolvedRequestIps,
} from '@taizan/nest-core'
import { resolveIps } from '@taizan/ratelimit-core'

/**
 * `resolveIps` 的 Nest 适配器。
 *
 * `TRUSTED_PROXY_HOPS` 在构造时读一次就固定下来（env 是启动即校验的，运行期不会变），
 * 免得每个请求都过一次 `ConfigService`。
 */
@Injectable()
export class ResolveIpsAdapter implements IpResolver {
  /** 链路末尾由可信基础设施追加的段数。 */
  readonly trustedHops: number

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.trustedHops = config.get('TRUSTED_PROXY_HOPS')
  }

  resolve(source: IpSource): ResolvedRequestIps {
    const { client, edge } = resolveIps({
      xff: source.xff,
      socketIp: source.socketIp,
      trustedHops: this.trustedHops,
    })
    return { client, edge }
  }
}
