/**
 * 请求上下文里那两个 IP 的**注入点**。
 *
 * ## 为什么要有这个接口
 *
 * `RequestContext.ip.client` 是限流、审计、风控共同依赖的值，而**怎么算出它**
 * 是一条硬性不变量（knowledge `CLAUDE.md` 第 6 条）：
 *
 * > 取客户端 IP 只能用 `resolveIps`，绝不能取 `X-Forwarded-For` 的第一段。
 * > XFF 开头几段是客户端自己写的、可任意伪造（实测过：伪造后限流 key 直接变成伪造值，
 * > 限流形同虚设）。可信的只有末尾由基础设施追加的段，段数由 `TRUSTED_PROXY_HOPS` 控制。
 *
 * 真正的实现在 `@taizan/ratelimit-core` 的 `resolveIps`（零框架依赖、107 个单测）。
 * 但 `@taizan/nest-core` 是所有包的底座，**不该**为了一个函数去依赖限流包
 * （依赖方向会变成 core → ratelimit，而限流是上层能力）。所以这里只定义
 * {@link IP_RESOLVER} 这个 token 和 {@link IpResolver} 这个接口，
 * 由 `@taizan/nest-auth` 的 `AuthModule.forRoot` 把 `resolveIps` 接上来。
 *
 * 没接的时候（比如只用 `CoreModule` 的最小进程）走 {@link PlaceholderIpResolver}——
 * 它会把 `client` 标成不可信，见那个类的注释。
 *
 * @packageDocumentation
 */

/**
 * 从请求上剥下来的、算 IP 需要的两样东西。
 *
 * 刻意只有这两个字段：解析函数因此不认识 express，可以在裸 node 里单测。
 * 从 `req` 上把它们取出来的**唯一一处**是 {@link readIpSource}。
 */
export interface IpSource {
  /** `X-Forwarded-For` 原始值。同名头出现多次时 express 给数组。 */
  xff: string | string[] | undefined
  /** 连接层对端地址（`req.socket.remoteAddress`）。 */
  socketIp: string | undefined
}

/** 解析出来的两个维度，形状与 `RequestContext.ip` 一致。 */
export interface ResolvedRequestIps {
  /** 可信客户端 IP。限流「按人算」、审计记录用它。 */
  client: string
  /** 入口 IP（直连我们的那一跳）。限流「按入口算」用它，客户端伪造不了。 */
  edge: string
}

/** IP 解析器。实现见 `@taizan/nest-auth` 的 `ResolveIpsAdapter`。 */
export interface IpResolver {
  resolve(source: IpSource): ResolvedRequestIps
}

/**
 * {@link IpResolver} 的注入 token。
 *
 * `Symbol.for` 而不是裸字符串：esm 与 cjs 两份产物同时被加载时（monorepo 里很常见）
 * 仍然是同一个 token。
 */
export const IP_RESOLVER = Symbol.for('@taizan/nest-core:IP_RESOLVER')

/** 一个只有 `headers` 与 `socket` 的最小请求形状（不 import express 的类型）。 */
export interface IpBearingRequest {
  headers?: Record<string, string | string[] | undefined>
  socket?: { remoteAddress?: string | undefined } | undefined
}

/**
 * 从请求上取原始素材。**全仓唯一允许直接碰 `x-forwarded-for` 的地方**
 * （另一处是 `resolveIps` 自己），spec 13 的白名单里就这两个文件。
 */
export function readIpSource(req: IpBearingRequest): IpSource {
  return {
    xff: req.headers?.['x-forwarded-for'], // ip-source-ok: 原样带走，取哪一段由 resolveIps 决定
    socketIp: req.socket?.remoteAddress, // ip-source-ok: 只作为 XFF 完全不可用时的兜底入参
  }
}

/**
 * 没接限流包时的**占位实现**。
 *
 * 它把 `client` 与 `edge` **都设成连接层对端地址**——也就是说，占位状态下
 * `ip.client` 的粒度是「直连我们的那一跳」，而不是真实客户端。
 *
 * 为什么不顺手取一下 XFF 的某一段：因为不知道 `TRUSTED_PROXY_HOPS`，
 * 任何一种取法都可能取到攻击者写的那段，而那正是不变量 6 要禁止的事。
 * **粗到没用，好过细到可伪造**：前者只会让限流误伤（看得见），
 * 后者会让限流静默失效（看不见）。
 *
 * 生产环境务必装上 `AuthModule.forRoot`（它会注册真实实现）。
 */
export class PlaceholderIpResolver implements IpResolver {
  resolve(source: IpSource): ResolvedRequestIps {
    const direct = source.socketIp ?? 'unknown'
    return { client: direct, edge: direct }
  }
}

/** 进程内共用的占位实例（无状态，不需要每次 new）。 */
export const PLACEHOLDER_IP_RESOLVER: IpResolver = new PlaceholderIpResolver()
