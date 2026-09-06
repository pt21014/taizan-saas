/**
 * 「这家店的公众号该用谁的」——四级来源优先级。纯函数。
 *
 * 搬自 knowledge `modules/client/mp-source.ts`，判定形状改成蓝图约定的四级
 * （`TENANT_OWN` > `TENANT_AUTHORIZED` > `PLATFORM_AUTHORIZED` > `PLATFORM_OWN`），
 * 入参从「一堆可空字段」改成「一组候选」——候选从哪来（库里读、配置读、闸门判）
 * 是 app 侧的事，本函数只回答「这几条里该用哪条」。
 *
 * 为什么必须收口成一个函数：同一件事原来在三处各判一遍——学员登录、
 * 商家后台「渠道」页显示当前生效的是哪条、发模板消息取凭据。三处分叉不会报错，
 * 表现是**渠道页显示「使用平台的号」而学员登录报错**，或者学员在商家自己的号里登录、
 * 通知却从平台号发出来——而他根本没关注平台号。
 *
 * 配套的机器守卫见 {@link scanDirectAppIdReads} 与 {@link assertMpSourceUsed}：
 * 别处直接读平台 appId/appSecret 就等于绕开了这里的闸门，而这种绕开**不报错**
 * （签名合法、接口通，只是那家店本不该用这个号）。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { MpSource, MpSourceKind } from './types'

/**
 * 四级优先级，按「商家的意愿有多明确」排序：
 *
 * 1. `TENANT_OWN`——商家自己填了 appId + appSecret，最明确的表态，优先级最高；
 * 2. `TENANT_AUTHORIZED`——商家把号授权给了平台（第三方平台代调用）。也是他的号，
 *    但平台拿不到 appSecret，能做的事少一点，所以排在自填之后；
 * 3. `PLATFORM_AUTHORIZED`——平台代运营的号，租户借用；
 * 4. `PLATFORM_OWN`——平台自有号，**且平台超管为这家店开通过**（`enabled`）。
 */
export const MP_SOURCE_PRIORITY: readonly MpSourceKind[] = [
  'TENANT_OWN',
  'TENANT_AUTHORIZED',
  'PLATFORM_AUTHORIZED',
  'PLATFORM_OWN',
] as const

/** 一条候选来源不可用的原因。分开报，因为**该去做事的人不同** */
export type MpSourceUnavailableReason =
  /** 一条都没配 */
  | 'NOT_CONFIGURED'
  /** 只剩平台自有号，但平台超管没给这家店开通 */
  | 'PLATFORM_NOT_PERMITTED'

/** 一条候选是否可用：`enabled` 缺省视为 `true`，且必须有 appId */
function usable(c: MpSource): boolean {
  if (!c.appId) return false
  if (c.enabled === false) return false
  // 自有号那两级要有 appSecret 才算数——没有密钥的「自有号」调什么都失败，
  // 而失败点在很后面（微信回 invalid appsecret），看不出是这里选错了
  if ((c.kind === 'TENANT_OWN' || c.kind === 'PLATFORM_OWN') && !c.appSecret) return false
  return true
}

/**
 * 从一组候选里挑出该用的那条。一条都不可用时返回 `null`。
 *
 * 同一 kind 有多条时取**第一条**（调用方自己决定顺序，例如按 `updatedAt` 倒序）。
 */
export function resolveMpSource(candidates: readonly MpSource[]): MpSource | null {
  for (const kind of MP_SOURCE_PRIORITY) {
    const hit = candidates.find((c) => c.kind === kind && usable(c))
    if (hit) return hit
  }
  return null
}

/**
 * 一条都挑不出来时，说清是「没配」还是「平台没开放」。
 *
 * **开关关着时不是「回落到没有」，而是明确的一种失败**：与「平台压根没配公众号」分开报，
 * 否则商家会去查自己的配置，而该做的事在平台那一侧。
 */
export function explainNoMpSource(candidates: readonly MpSource[]): MpSourceUnavailableReason {
  const gatedPlatform = candidates.some(
    (c) => c.kind === 'PLATFORM_OWN' && c.enabled === false && c.appId && c.appSecret,
  )
  return gatedPlatform ? 'PLATFORM_NOT_PERMITTED' : 'NOT_CONFIGURED'
}

/** 拿不到公众号时给商家/学员看的话。要说清该由谁去做什么 */
export function mpUnavailableMessage(reason: MpSourceUnavailableReason): string {
  return reason === 'PLATFORM_NOT_PERMITTED'
    ? '本店还没有接入公众号，无法完成微信登录。请在「渠道 → 公众号」接入自己的公众号，或联系平台开通共用平台公众号'
    : '尚未配置微信公众号，无法完成微信登录'
}

/**
 * 这条来源能不能拿到 access_token（模板消息、JS-SDK 签名要用）。
 *
 * 中转站那条路**只做登录**：中转站不给 access_token（那是另一档套餐的能力），
 * 所以要凭据的调用方必须先把它排除，否则表现是「登录好好的，一发通知就失败」。
 */
export function canIssueAccessToken(source: MpSource): boolean {
  if (source.relay) return false
  if (source.kind === 'TENANT_OWN' || source.kind === 'PLATFORM_OWN')
    return Boolean(source.appSecret)
  return Boolean(source.authorizerRefreshToken)
}

// ---------------------------------------------------------------------------
// 机器守卫：别处不许直接读平台 appId/appSecret
// ---------------------------------------------------------------------------

/** 一处直接读平台凭据的地方 */
export interface DirectAppIdRead {
  /** 相对扫描根目录的路径，用 `/` 分隔（Windows 上也是） */
  file: string
  /** 命中的行号，从 1 开始 */
  line: number
  /** 命中的那一行（trim 过） */
  text: string
}

/**
 * 默认的「直接读平台凭据」特征。
 *
 * 之所以是正则而不是 AST：这条规则要能被别的包、被生成器模板直接复用，
 * 而那些地方连 TypeScript 都不一定装。正则会有漏网（换个变量名就绕过去了），
 * 但它拦住的是「顺手复制一行配置读取」这种最常见的绕开方式，够用。
 */
export const DEFAULT_PLATFORM_CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bplatformMp\s*\.\s*(appId|appSecret)\b/,
  /\bthis\s*\.\s*mp\s*\.\s*(appId|appSecret|enabled)\b/,
  /\bPLATFORM_MP_APP_(ID|SECRET)\b/,
  /\bprocess\.env\.\s*WECHAT_MP_APP_(ID|SECRET)\b/,
]

export interface ScanOptions {
  /** 允许直接读的文件（相对扫描根目录，`/` 分隔）。判定函数与配置文件本身要放行 */
  allow?: readonly string[]
  /** 覆盖默认特征 */
  patterns?: readonly RegExp[]
  /** 额外忽略的目录名，缺省 `node_modules` / `dist` / `.turbo` / `coverage` */
  ignoreDirs?: readonly string[]
}

const DEFAULT_IGNORE_DIRS = ['node_modules', 'dist', '.turbo', 'coverage']

function collect(dir: string, root: string, ignore: readonly string[]): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) {
      if (ignore.includes(name)) continue
      out.push(...collect(p, root, ignore))
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts')) {
      out.push(p)
    }
  }
  return out
}

/**
 * 扫一棵源码树，找出所有**直接读平台公众号 appId/appSecret** 的地方。
 *
 * @param srcDir 扫描根目录（绝对路径）
 * @returns 命中列表；空数组表示没有人绕开 {@link resolveMpSource}
 *
 * 用法见 `mp-source-usage.spec.ts`：业务项目照抄一份，把 `allow` 换成自己的白名单。
 */
export function scanDirectAppIdReads(srcDir: string, options: ScanOptions = {}): DirectAppIdRead[] {
  const patterns = options.patterns ?? DEFAULT_PLATFORM_CREDENTIAL_PATTERNS
  const allow = new Set(options.allow ?? [])
  const ignore = options.ignoreDirs ?? DEFAULT_IGNORE_DIRS
  const hits: DirectAppIdRead[] = []

  for (const file of collect(srcDir, srcDir, ignore)) {
    const rel = path.relative(srcDir, file).split(path.sep).join('/')
    if (allow.has(rel)) continue
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((text, i) => {
      if (patterns.some((re) => re.test(text))) {
        hits.push({ file: rel, line: i + 1, text: text.trim() })
      }
    })
  }
  return hits
}

export interface MpSourceUsageOptions extends ScanOptions {
  /** 扫描根目录（绝对路径） */
  srcDir: string
  /**
   * 必须出现 `resolveMpSource` 的文件（相对 `srcDir`）。
   * 典型是三处：C 端登录、商家后台渠道页、取凭据的那个服务。
   */
  callers?: readonly string[]
  /**
   * 必须**委托**给上面某一处、自己不许再判一遍的文件。
   * 抄第二份的话表现是「通知从商家的号发出去、分享签名却是平台号签的」，
   * 而微信只回一句 invalid signature。
   */
  delegators?: readonly string[]
  /** `delegators` 里必须出现的委托目标名，缺省 `MpTokenService` */
  delegateTo?: string
}

/**
 * 「公众号来源判定只有一份」的断言，供 `mp-source-usage.spec.ts` 直接调用。
 *
 * 违规就抛 `Error`，message 里逐条列出文件与行号——spec 里 `expect(() => ...).not.toThrow()`
 * 时失败信息才看得懂。
 */
export function assertMpSourceUsed(options: MpSourceUsageOptions): void {
  const problems: string[] = []

  for (const rel of options.callers ?? []) {
    const src = readFileSync(path.join(options.srcDir, rel), 'utf8')
    if (!src.includes('resolveMpSource')) {
      problems.push(`${rel} 没有调用 resolveMpSource——它自己判了一遍`)
    }
  }

  const target = options.delegateTo ?? 'MpTokenService'
  for (const rel of options.delegators ?? []) {
    const src = readFileSync(path.join(options.srcDir, rel), 'utf8')
    if (!src.includes(target)) problems.push(`${rel} 没有向 ${target} 要凭据`)
    if (src.includes('resolveMpSource')) {
      problems.push(`${rel} 自己又判了一遍 resolveMpSource，两份规则迟早不一致`)
    }
  }

  for (const hit of scanDirectAppIdReads(options.srcDir, options)) {
    problems.push(`${hit.file}:${hit.line} 直接读了平台公众号凭据：${hit.text}`)
  }

  if (problems.length) {
    throw new Error(`公众号来源判定被绕开了：\n- ${problems.join('\n- ')}`)
  }
}
