/**
 * 从 `X-Forwarded-For` 里解析出**可信的**客户端 IP 与入口 IP。
 *
 * ## 这条不变量的完整原文（knowledge `CLAUDE.md` 第 6 条，一字不改地抄在这里）
 *
 * > **取客户端 IP 只能用 `RateLimitService.resolveIps`，绝不能取 `X-Forwarded-For` 的第一段**。
 * > 链路是 客户端 → EdgeOne → nginx → Node，nginx 用 `$proxy_add_x_forwarded_for` 追加，
 * > 所以 XFF **开头几段是客户端自己写的、可任意伪造**（实测过：伪造后限流 key 直接变成伪造值，
 * > 限流形同虚设）。可信的只有末尾由基础设施追加的段，段数由 `TRUSTED_PROXY_HOPS` 控制（当前 2）。
 * > 限流同时按「客户端 IP + 入口 IP + 账号」三个维度计数，且入口/账号维度必须设得宽松——
 * > 否则会变成攻击者锁死整片地区用户或指定账号的工具。
 *
 * 那句「实测过：伪造后限流 key 直接变成伪造值」不是推演出来的风险，是线上真的发生过：
 * 攻击者每次请求换一个 `X-Forwarded-For: 9.9.9.9` 前缀，限流桶就换一个 key，
 * 于是一个 5 次/10 分钟的登录限流对他而言等于不存在，而日志里看到的是几万个不同 IP
 * 各失败了一次——从监控上完全看不出这是同一台机器。
 *
 * ## 所以这个文件的规则只有一条：**只从末尾数，永远不从开头数**
 *
 * ```
 *   客户端          EdgeOne              nginx               Node
 *   ┌──────┐        ┌──────┐            ┌──────┐            ┌──────┐
 *   │伪造段│──XFF──▶│ 追加 │───XFF+1───▶│ 追加 │───XFF+2───▶│ 这里 │
 *   └──────┘        └──────┘            └──────┘            └──────┘
 *
 *   X-Forwarded-For: 9.9.9.9, 8.8.8.8, 222.137.6.155, 114.66.247.140
 *                    └── 攻击者写的 ──┘  └ EdgeOne 断言 ┘  └ nginx 亲自追加 ┘
 *                                          = client            = edge
 *                                        （倒数第 2 段）      （倒数第 1 段）
 * ```
 *
 * 攻击者能往**开头**塞任意多段，但塞不动末尾那几段的相对位置——所以从末尾倒数是稳的，
 * 从开头正数是可伪造的。`TRUSTED_PROXY_HOPS` 就是「末尾有几段是基础设施写的」。
 *
 * ## 全仓禁止绕过
 *
 * 蓝图 §8 spec 13（`ip-source.spec.ts`）扫全仓：禁止任何地方直接读 `x-forwarded-for`
 * 或 `req.ip`，只能走这个函数。扫描器就在本包的 {@link scanDirectIpReads}。
 *
 * @packageDocumentation
 */

/** {@link resolveIps} 的入参。刻意不收 `Request`——本包零框架依赖，也不认识 express。 */
export interface ResolveIpsInput {
  /**
   * `X-Forwarded-For` 头的原始值。express 对重复同名头会给数组，所以两种都收。
   * 没有这个头就传 `undefined`。
   */
  xff?: string | readonly string[] | undefined
  /**
   * 连接层对端地址（`req.socket.remoteAddress`）。
   *
   * 它是唯一一个**在任何情况下都伪造不了**的值，所以当 XFF 完全不可用时用它兜底。
   * 代价是：Node 挂在 nginx 后面时它恒等于 `127.0.0.1`，所有人共用一个限流桶。
   * 这是刻意的取舍——粒度粗到误伤，也好过粒度细到形同虚设。
   */
  socketIp?: string | undefined
  /**
   * 链路末尾由**可信基础设施**追加的段数，即 env 的 `TRUSTED_PROXY_HOPS`。
   *
   * - `2`：客户端 → CDN → nginx → Node（CDN 追加真实客户端 IP，nginx 追加 CDN 出口 IP）
   * - `1`：客户端 → nginx → Node（没有 CDN）
   * - `0`：Node 直接对外（没有任何反代），此时 XFF 全都是客户端写的，一律不可信
   *
   * **配大了**（比如实际 1 配成 2）：会取到攻击者可写的段，等于没有限流。
   * **配小了**（比如实际 2 配成 1）：会把 CDN 出口 IP 当客户端 IP，同一节点后的用户互相牵连。
   * 配错的方向不同、后果不同，所以 {@link resolveIps} 会把完整链路回给调用方打进日志，
   * 上线后拿真实请求核对一次。
   */
  trustedHops: number
}

/** {@link resolveIps} 的结果。 */
export interface ResolvedIps {
  /**
   * 可信的客户端 IP：倒数第 `trustedHops` 段。限流「按人算」用它，审计记录用它。
   *
   * 「可信」只到 CDN 那一层为止——CDN 断言这是真实客户端，我们信 CDN。
   * 它挡不住「攻击者控制了 CDN 边缘节点」这种事，但那不是限流该解决的问题。
   */
  client: string
  /**
   * 入口 IP：XFF 末段，由我们自己的 nginx 亲自追加，**客户端绝对影响不了**。
   *
   * 限流「按入口算」用它。它是伪造 XFF 的兜底闸门：攻击者可以让 `client` 每次都不一样，
   * 但 `edge` 只会是他真实的那一个。
   */
  edge: string
  /** 完整链路（原样按顺序拼回去），只用来打日志核对 `TRUSTED_PROXY_HOPS` 是否配对。 */
  chain: string
  /** `client` 是从哪儿来的，见 {@link ClientIpSource}。用来在日志里区分「正常」和「降级」。 */
  source: ClientIpSource
  /** 被判定为非法 IP 而丢弃的段数。持续 > 0 说明上游在往 XFF 里写非 IP 的东西。 */
  rejected: number
}

/**
 * `client` 的来源。
 *
 * - `hops`：正常。倒数第 `trustedHops` 段。
 * - `edge`：**降级**。XFF 段数比 `trustedHops` 少，退回末段（nginx 亲自追加的那段）。
 *   宁可粒度粗到「整个 CDN 节点算一个人」，也绝不退回到开头那些可伪造的段。
 * - `socket`：**再降级**。XFF 为空或全是非法段，退回连接层对端地址。
 */
export type ClientIpSource = 'hops' | 'edge' | 'socket'

/** XFF 里一段都没有、socketIp 也没给时用的占位值。 */
export const UNKNOWN_IP = 'unknown'

/**
 * 解析客户端 IP 与入口 IP。**纯函数**，同样的入参永远同样的结果。
 *
 * @example 正常链路（trustedHops=2）
 * ```ts
 * resolveIps({ xff: '222.137.6.155, 114.66.247.140', trustedHops: 2 })
 * // → { client: '222.137.6.155', edge: '114.66.247.140', source: 'hops' }
 * ```
 *
 * @example 攻击者在开头塞了三段伪造 IP——结果和上面**一模一样**
 * ```ts
 * resolveIps({ xff: '1.1.1.1, 2.2.2.2, 3.3.3.3, 222.137.6.155, 114.66.247.140', trustedHops: 2 })
 * // → { client: '222.137.6.155', edge: '114.66.247.140', source: 'hops' }
 * ```
 */
export function resolveIps(input: ResolveIpsInput): ResolvedIps {
  const raw = Array.isArray(input.xff) ? input.xff.join(',') : ((input.xff as string) ?? '')
  const hops = normalizeHops(input.trustedHops)

  const segments = raw.split(',')
  const parts: string[] = []
  let rejected = 0
  for (const segment of segments) {
    const trimmed = segment.trim()
    if (trimmed === '') continue
    const normalized = normalizeIp(trimmed)
    if (normalized === undefined) {
      // 非法段直接丢弃，不是「整个头作废」：攻击者只要在开头塞一个 `not-an-ip`
      // 就能让整个头作废、把我们赶回 socketIp（= 所有人一个桶），那正好是他要的。
      // 丢弃是安全的，因为他只能往**开头**塞，从末尾倒数的位置不受影响。
      rejected += 1
      continue
    }
    parts.push(normalized)
  }

  const socket = normalizeIp(input.socketIp?.trim() ?? '') ?? UNKNOWN_IP

  if (parts.length === 0) {
    return { client: socket, edge: socket, chain: '', source: 'socket', rejected }
  }

  const edge = parts[parts.length - 1] as string
  const index = parts.length - hops

  // hops 为 0（Node 直接对外）时 index === parts.length，越界；整个 XFF 都不可信，
  // 只有连接层对端地址是真的。
  if (hops === 0) {
    return { client: socket, edge: socket, chain: parts.join(' | '), source: 'socket', rejected }
  }

  if (index < 0) {
    // 段数不够：链路比配置说的短。**绝不**因此去取开头那段（那正是被绕过的那次的写法），
    // 退回末段——它至少是我们自己的基础设施写的。
    return { client: edge, edge, chain: parts.join(' | '), source: 'edge', rejected }
  }

  return {
    client: parts[index] as string,
    edge,
    chain: parts.join(' | '),
    source: 'hops',
    rejected,
  }
}

/** `trustedHops` 归一：非整数 / 负数一律当 0（= 谁都不可信），不静默当成 1。 */
function normalizeHops(hops: number): number {
  if (!Number.isFinite(hops)) return 0
  const n = Math.trunc(hops)
  return n < 0 ? 0 : n
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
/** IPv6 只做字符集与结构的粗校验：目的是挡住「不是 IP 的东西」，不是当解析器用。 */
const IPV6_CHARS = /^[0-9a-fA-F:.]+$/

/**
 * 校验并归一化一个 IP 段。
 *
 * 归一化做三件事，都是为了**同一个客户端不要落进两个限流桶**：
 * 1. 去掉端口（`1.2.3.4:5678` → `1.2.3.4`，`[::1]:80` → `::1`）；
 * 2. IPv4-mapped IPv6 拍平（`::ffff:1.2.3.4` → `1.2.3.4`，Node 在双栈监听下给的就是这个形状）；
 * 3. IPv6 小写。
 *
 * @returns 归一化后的 IP；不是 IP 返回 `undefined`
 */
export function normalizeIp(value: string): string | undefined {
  if (value === '') return undefined
  let v = value.trim()

  // `[::1]:8080` / `[::1]`
  if (v.startsWith('[')) {
    const close = v.indexOf(']')
    if (close < 0) return undefined
    v = v.slice(1, close)
  } else {
    // `1.2.3.4:5678`——只有恰好一个冒号时才当端口，IPv6 里冒号一定不止一个。
    const first = v.indexOf(':')
    if (first >= 0 && first === v.lastIndexOf(':') && IPV4.test(v.slice(0, first))) {
      v = v.slice(0, first)
    }
  }

  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(v)
  if (mapped) v = mapped[1] as string

  const v4 = IPV4.exec(v)
  if (v4) {
    for (let i = 1; i <= 4; i += 1) {
      const octet = Number(v4[i])
      if (octet > 255) return undefined
      // `01.2.3.4` 和 `1.2.3.4` 是同一台机器的两个 key，不许。
      if ((v4[i] as string).length > 1 && (v4[i] as string).startsWith('0')) return undefined
    }
    return v
  }

  if (v.includes(':') && IPV6_CHARS.test(v) && !v.includes(':::')) {
    return v.toLowerCase()
  }

  return undefined
}
