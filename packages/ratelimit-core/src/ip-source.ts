/**
 * 蓝图 §8 spec 13（`ip-source.spec.ts`）的扫描器。
 *
 * ## 它守的是什么
 *
 * > 全仓禁止直接读 `x-forwarded-for` / `req.ip`，只能用 `resolveIps`
 * > ——守护的不变量：XFF 前几段可伪造，限流形同虚设。
 *
 * 运行时没有任何东西能拦住「某个新接口顺手写了 `req.headers['x-forwarded-for']
 * .split(',')[0]`」：那行代码能跑、能拿到一个 IP、日志里看着也正常，
 * 唯一的症状是限流对会写这个头的人不生效——而会写这个头的人正好是要拦的那批。
 * 所以这条只能静态查。
 *
 * ## 白名单
 *
 * 有两处**必须**直接读原始头，否则 `resolveIps` 自己就没法工作：
 * 1. 本包的 `resolve-ips.ts`（它就是那个唯一入口）；
 * 2. 框架里把 `req` 拆成 `{ xff, socketIp }` 喂给 `resolveIps` 的那一个注入点
 *    （`@taizan/nest-core` 的 `context.middleware.ts` / `@taizan/nest-auth` 的 `ip-resolver.ts`）。
 *
 * 白名单按**文件路径后缀**匹配，且调用方必须自己传——不写死在这里，是因为
 * 下游项目的注入点路径不一样，而「白名单硬编码在框架里、下游改不了」的结果是
 * 下游干脆把整条 spec 关掉。
 *
 * ## 哨兵
 *
 * 正则失效时「扫不到任何违规」和「代码完全合规」长得一模一样。
 * {@link IP_SOURCE_SENTINEL_SOURCE} 是一份故意写坏的源码，
 * spec 里先拿它验一遍扫描器还活着，再去扫真实代码。这是蓝图 §8 spec 1 用过的同一招。
 *
 * @packageDocumentation
 */

/** 一份待扫源码。 */
export interface IpSourceFile {
  path: string
  source: string
}

/** 一处违规。 */
export interface IpSourceViolation {
  file: string
  /** 1 起算的行号。 */
  line: number
  /** 违规那一行的原文（已 trim）。 */
  text: string
  /** 命中了哪条规则。 */
  rule: 'x-forwarded-for' | 'req-ip' | 'remote-address'
  /** 直接进断言失败信息的中文说明。 */
  message: string
}

/** 扫描结果。 */
export interface IpSourceReport {
  /** 实际被扫的文件数（白名单命中的不算）。用来防「glob 写错导致一个文件都没扫到」。 */
  scanned: number
  /** 因为白名单被跳过的文件路径。 */
  skipped: string[]
  violations: IpSourceViolation[]
}

/** {@link scanDirectIpReads} 的选项。 */
export interface ScanDirectIpReadsOptions {
  /**
   * 白名单：路径**以这些串结尾**的文件跳过。
   *
   * 默认只放过本包自己的 `resolve-ips.ts`。框架的注入点由调用方追加，
   * 一处一行，写在 spec 里能被 review 看见。
   */
  allow?: readonly string[]
}

/**
 * 默认白名单：`resolveIps` 的实现文件本身，以及本扫描器自己
 * （它的正则和哨兵里必然写着那个头名，扫自己会永远报违规）。
 */
export const DEFAULT_IP_SOURCE_ALLOWLIST: readonly string[] = [
  'ratelimit-core/src/resolve-ips.ts',
  'ratelimit-core/src/ip-source.ts',
]

/**
 * `x-forwarded-for` 字面量（大小写不敏感）。
 *
 * 只要出现这个串就算——不区分是 `req.headers['x-forwarded-for']` 还是
 * `headers.get('X-Forwarded-For')` 还是拼出来的常量名。想读它的写法太多，
 * 与其枚举不如认这个串：它出现在业务代码里就没有正当理由。
 */
const XFF_LITERAL = /x-forwarded-for/i

/** `req.ip` / `request.ip` / `ctx.req.ip`（末尾必须是词边界，避开 `req.ipRange`）。 */
const REQ_IP = /\b(?:req|request|httpRequest)\s*(?:\?\.|\.)\s*ips?\b/

/** `socket.remoteAddress` / `connection.remoteAddress`。 */
const REMOTE_ADDRESS = /\b(?:socket|connection)\s*(?:\?\.|\.)\s*remoteAddress\b/

/** 行内豁免注释。写了理由才放过——理由至少 {@link EXEMPT_REASON_MIN} 个字。 */
const INLINE_EXEMPT = /\/\/\s*ip-source-ok:(.*)$/

/** 豁免理由的最短长度。`// ip-source-ok: x` 不算理由。 */
const EXEMPT_REASON_MIN = 6

/** 这一行是否带着一条**写清了理由**的豁免注释。 */
function hasExemption(line: string): boolean {
  const reason = INLINE_EXEMPT.exec(line)?.[1]?.trim() ?? ''
  return reason.length >= EXEMPT_REASON_MIN
}

/** 单行注释（整行以 `//` 或 `*` 开头）。注释里提到 XFF 是在解释，不是在读。 */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/

const RULE_MESSAGE: Record<IpSourceViolation['rule'], string> = {
  'x-forwarded-for':
    '直接读 X-Forwarded-For。这个头的开头几段是客户端自己写的、可任意伪造' +
    '（knowledge 实测过：伪造后限流 key 直接变成伪造值，限流形同虚设）。' +
    '只能用 @taizan/ratelimit-core 的 resolveIps，从末尾倒数 TRUSTED_PROXY_HOPS 段。',
  'req-ip':
    '直接读 req.ip。它的值取决于 express 的 trust proxy 配置，' +
    '配成 true 时取的就是 XFF 的第一段——也就是攻击者写的那段。' +
    '要客户端 IP 请读请求上下文的 ctx.ip.client（它由 resolveIps 填）。',
  'remote-address':
    '直接读 socket.remoteAddress。Node 挂在 nginx 后面时它恒等于 127.0.0.1，' +
    '拿它做限流 key 等于所有人共用一个桶。它只该作为 resolveIps 的 socketIp 兜底入参。',
}

/**
 * 扫一批源码，找出绕过 `resolveIps` 直接取 IP 的地方。
 *
 * 调用方自己决定 glob 范围（本包零依赖，不带 glob 库），把读到的
 * `{ path, source }` 列表传进来即可：
 *
 * ```ts
 * const files = (await glob('src/**\/*.ts')).map((p) => ({ path: p, source: readFileSync(p, 'utf8') }))
 * const report = scanDirectIpReads(files, { allow: [...DEFAULT_IP_SOURCE_ALLOWLIST, 'nest-auth/src/ratelimit/ip-resolver.ts'] })
 * expect(report.scanned).toBeGreaterThan(0)   // 防 glob 写错导致空扫
 * expect(report.violations).toEqual([])
 * ```
 *
 * 单行豁免：在那一行后面写 `// ip-source-ok: 理由`（理由至少 6 个字）。
 */
export function scanDirectIpReads(
  files: readonly IpSourceFile[],
  options: ScanDirectIpReadsOptions = {},
): IpSourceReport {
  const allow = options.allow ?? DEFAULT_IP_SOURCE_ALLOWLIST
  const violations: IpSourceViolation[] = []
  const skipped: string[] = []
  let scanned = 0

  for (const file of files) {
    const normalizedPath = file.path.replace(/\\/g, '/')
    if (allow.some((suffix) => normalizedPath.endsWith(suffix.replace(/\\/g, '/')))) {
      skipped.push(file.path)
      continue
    }
    scanned += 1

    const lines = file.source.split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i] as string
      if (COMMENT_LINE.test(raw)) continue
      if (hasExemption(raw)) continue

      const rule: IpSourceViolation['rule'] | undefined = XFF_LITERAL.test(raw)
        ? 'x-forwarded-for'
        : REQ_IP.test(raw)
          ? 'req-ip'
          : REMOTE_ADDRESS.test(raw)
            ? 'remote-address'
            : undefined
      if (!rule) continue

      violations.push({
        file: file.path,
        line: i + 1,
        text: raw.trim(),
        message: `${file.path}:${i + 1} ${RULE_MESSAGE[rule]}`,
        rule,
      })
    }
  }

  return { scanned, skipped, violations }
}

/**
 * 哨兵源码：故意写坏的一份输入，必须被扫出 {@link IP_SOURCE_SENTINEL_EXPECTATION} 的结果。
 *
 * 里面每一行都对应一个真实会被写出来的写法，包括三条**不该**报的：
 * 注释行、带豁免理由的行、以及形近但无关的 `req.ipRange`。
 */
export const IP_SOURCE_SENTINEL_SOURCE = [
  "const a = req.headers['x-forwarded-for']", // 违规 1
  'const b = req.ip', // 违规 2
  'const c = request?.ip ?? null', // 违规 3
  'const d = socket.remoteAddress', // 违规 4
  '// 这一行在注释里提到 x-forwarded-for，不该报',
  'const e = req.socket.remoteAddress // ip-source-ok: 作为 resolveIps 的兜底入参传进去',
  'const f = req.ipRange // 形近但无关，不该报',
  'const g = ctx.ip.client // 正确写法',
].join('\n')

/** {@link IP_SOURCE_SENTINEL_SOURCE} 必须扫出的结果。 */
export const IP_SOURCE_SENTINEL_EXPECTATION = {
  violationCount: 4,
  rules: ['x-forwarded-for', 'req-ip', 'req-ip', 'remote-address'] as const,
  lines: [1, 2, 3, 4] as const,
} as const
