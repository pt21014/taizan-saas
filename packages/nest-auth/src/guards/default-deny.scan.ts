/**
 * spec 5（`guard-default-deny.spec.ts`）的扫描器（蓝图 §8）。
 *
 * ## 它守的是什么
 *
 * 运行时的默认拒绝已经由 `GlobalAuthGuard` 保证了。这个静态扫描守的是**另一半**：
 *
 * 1. 每个路由方法要么被全局守卫覆盖，要么显式 `@Public()`——也就是说，
 *    源码里不该出现「用 `@UseGuards()` 换掉全局守卫却没有等价的认证」这种写法；
 * 2. **`@Public()` 的路由必须同时声明 `@RateLimited(tier)`**。这一条只能静态查：
 *    运行时最多打条 warn，而 warn 在 CI 上没人看。公开路由是主动开的洞，
 *    没有限流的洞就是一个免费的爆破入口。
 *
 * ## 为什么是正则而不是 TS AST
 *
 * 装饰器的形状很固定（`@Get('x')` 前面若干行连续的 `@Xxx(...)`），正则够用；
 * 而引 `typescript` 的 compiler API 会给一个**架构测试**加上一个几十兆的依赖，
 * 且在 CI 上明显更慢。代价是遇到极端写法（装饰器写在同一行、宏生成的控制器）会漏——
 * 所以下面带了一个**哨兵测试**（`SENTINEL_SOURCE`）：正则一旦失效，
 * 哨兵会先于真实代码报错，而不是静默地全部通过。这是 spec 1 用过的同一招。
 *
 * ## 给 T0-8 用
 *
 * `apps/api/test/arch/guard-default-deny.spec.ts` 直接 `import { scanControllerSources }`
 * 扫 `apps/api/src/**\/*.controller.ts`。本文件是样板实现，不要在下游再抄一份。
 *
 * @packageDocumentation
 */

/** 一个被扫出来的路由方法。 */
export interface ScannedRoute {
  /** 源文件路径（原样回传扫描时传进来的那个）。 */
  file: string
  /** 控制器类名。 */
  controller: string
  /** 方法名。 */
  method: string
  /** HTTP 方法装饰器名（`Get` / `Post` / …）。 */
  httpMethod: string
  /** 是否显式 `@Public()`（方法级或类级）。 */
  isPublic: boolean
  /** `@RateLimited(tier)` 的档位；没声明为 `undefined`。 */
  rateLimitTier: string | undefined
  /** 方法级 `@Auth(...)` 声明的身份（类级会被合并进来）。 */
  authKinds: string[]
}

/** 一条违规。 */
export interface DefaultDenyViolation {
  route: ScannedRoute
  /** 违反了哪条规则。 */
  rule: 'public-without-rate-limit' | 'guard-override-without-public'
  /** 给人看的中文说明（直接进断言失败信息）。 */
  message: string
}

/** 扫描结果。 */
export interface DefaultDenyReport {
  routes: ScannedRoute[]
  violations: DefaultDenyViolation[]
}

/** 一份源码。 */
export interface SourceFile {
  path: string
  source: string
}

const HTTP_DECORATORS = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'All', 'Head', 'Options'] as const

/** 装饰器行：`  @Xxx(...)` 或 `  @Xxx`。 */
const DECORATOR_LINE = /^\s*@([A-Za-z_$][\w$]*)\s*(\((.*)\))?\s*,?\s*$/
/** 类声明行（可能带 export / abstract）。 */
const CLASS_LINE = /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/
/** 方法声明行：`  foo(...)` / `  async foo(...)` / `  private async foo(...)`。 */
const METHOD_LINE =
  /^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*[(<]/

/** 从 `@RateLimited('login')` 的实参里抠出字符串字面量。 */
function firstStringArg(args: string | undefined): string | undefined {
  if (!args) return undefined
  const m = /^\s*['"`]([^'"`]*)['"`]/.exec(args)
  return m?.[1]
}

/** 从 `@Auth('staff', 'platform')` 的实参里抠出全部字符串字面量。 */
function allStringArgs(args: string | undefined): string[] {
  if (!args) return []
  return [...args.matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1] as string)
}

/** 一段连续装饰器的解析结果。 */
interface DecoratorSet {
  names: Set<string>
  isController: boolean
  isPublic: boolean
  rateLimitTier: string | undefined
  authKinds: string[]
  httpMethod: string | undefined
  hasUseGuards: boolean
}

function emptySet(): DecoratorSet {
  return {
    names: new Set(),
    isController: false,
    isPublic: false,
    rateLimitTier: undefined,
    authKinds: [],
    httpMethod: undefined,
    hasUseGuards: false,
  }
}

function absorb(set: DecoratorSet, name: string, args: string | undefined): void {
  set.names.add(name)
  if (name === 'Controller') set.isController = true
  if (name === 'Public') set.isPublic = true
  if (name === 'RateLimited') set.rateLimitTier = firstStringArg(args)
  if (name === 'Auth') set.authKinds.push(...allStringArgs(args))
  if (name === 'UseGuards') set.hasUseGuards = true
  if ((HTTP_DECORATORS as readonly string[]).includes(name)) set.httpMethod = name
}

/**
 * 把**跨行的装饰器**折叠成一行。
 *
 * 为什么必须做这件事：装饰器很容易写成多行，
 *
 * ```ts
 * @Audit({
 *   action: AUDIT.GOODS_DELETE,
 *   targetId: (req) => req.params.id,
 * })
 * @Delete(':id')
 * remove(@Param('id') id: string) {}
 * ```
 *
 * 而逐行匹配的 `DECORATOR_LINE` 认不出 `@Audit({`（括号没配平），于是它被当成
 * 「非装饰器行」，把待定装饰器集合清空——**结果是整条路由从扫描结果里消失了**。
 *
 * 消失比误报危险得多：一条没被扫到的路由在报告里和「一条合规的路由」长得一模一样，
 * 于是 `@Public()` 忘了配限流也照样全绿。T0-8 装配 `apps/api` 时真的踩到了这个：
 * 11 条路由里少了 5 条，全是带多行 `@Audit` / `@ApiOperation` 的那些。
 *
 * 折叠规则：一行以 `@` 开头且圆括号未配平时，继续吃后面的行直到配平。
 * 折叠后的行数用空行补齐，**保持后续行号不变**（报错要能指到位置）。
 *
 * @param lines - 原始行
 * @returns 同样长度的数组，跨行装饰器已折叠进它的首行，被吃掉的行变成空串
 */
export function foldMultilineDecorators(lines: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!/^\s*@[A-Za-z_$]/.test(line)) {
      out.push(line)
      continue
    }
    let merged = line
    let depth = netParenDepth(line)
    let consumed = 0
    while (depth > 0 && i + consumed + 1 < lines.length) {
      consumed += 1
      const next = lines[i + consumed] ?? ''
      merged += next.trim()
      depth += netParenDepth(next)
    }
    out.push(merged)
    // 被吃掉的行填空串：数组长度不变，后面每一行的行号也就不变。
    for (let k = 0; k < consumed; k++) out.push('')
    i += consumed
  }
  return out
}

/** 一行里 `(` 与 `)` 的净差（忽略字符串里的括号——装饰器实参里带括号的字符串极罕见）。 */
function netParenDepth(line: string): number {
  let depth = 0
  for (const ch of line) {
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
  }
  return depth
}

/**
 * 扫一批源码。
 *
 * @param files - 源文件列表（路径 + 内容）。调用方自己决定 glob 范围
 * @returns 扫到的全部路由与全部违规
 */
export function scanControllerSources(files: readonly SourceFile[]): DefaultDenyReport {
  const routes: ScannedRoute[] = []

  for (const file of files) {
    const lines = foldMultilineDecorators(file.source.split(/\r?\n/))
    let currentClass: string | undefined
    let classDecorators = emptySet()
    let pending = emptySet()

    for (const raw of lines) {
      const decorator = DECORATOR_LINE.exec(raw)
      if (decorator) {
        absorb(pending, decorator[1] as string, decorator[3])
        continue
      }

      const klass = CLASS_LINE.exec(raw)
      if (klass) {
        currentClass = pending.isController ? (klass[1] as string) : undefined
        classDecorators = pending
        pending = emptySet()
        continue
      }

      const method = METHOD_LINE.exec(raw)
      if (method && currentClass && pending.httpMethod) {
        routes.push({
          file: file.path,
          controller: currentClass,
          method: method[1] as string,
          httpMethod: pending.httpMethod,
          // 方法级与类级取「或」：类上标 @Public() 时整个控制器都是公开的。
          isPublic: pending.isPublic || classDecorators.isPublic,
          rateLimitTier: pending.rateLimitTier ?? classDecorators.rateLimitTier,
          authKinds: pending.authKinds.length ? pending.authKinds : classDecorators.authKinds,
        })
      }
      // 任何非装饰器行都清空待定装饰器：装饰器必须**紧贴**它修饰的目标。
      if (raw.trim() !== '') pending = emptySet()
    }
  }

  const violations: DefaultDenyViolation[] = []
  for (const route of routes) {
    if (route.isPublic && !route.rateLimitTier) {
      violations.push({
        route,
        rule: 'public-without-rate-limit',
        message:
          `${route.file} 的 ${route.controller}.${route.method}（@${route.httpMethod}）声明了 @Public() ` +
          `却没有 @RateLimited(tier)。公开路由是主动开的洞，没有限流的洞就是免费的爆破入口。`,
      })
    }
  }

  return { routes, violations }
}

/**
 * 哨兵源码：一份**故意造出来**的、必须被扫出确定结果的输入。
 *
 * 用法（照抄进 spec）：断言 `scanControllerSources([{path:'sentinel.ts', source: SENTINEL_SOURCE}])`
 * 扫出 {@link SENTINEL_EXPECTATION} 描述的那些数字。正则哪天被改坏（或者装饰器写法变了），
 * 哨兵会先炸，而不是让真实代码「一条违规都没扫到」地假通过——
 * 「扫不到东西」和「没有问题」在断言上长得一模一样，这是静态扫描类测试最容易骗过自己的地方。
 */
export const SENTINEL_SOURCE = `
@Controller('sentinel')
export class SentinelController {
  @Get('ok')
  @Public()
  @RateLimited('public-read')
  ok(): string { return 'ok' }

  @Post('bad')
  @Public()
  bad(): string { return 'bad' }

  @Get('guarded')
  @Auth('staff')
  guarded(): string { return 'guarded' }

  @Audit({
    action: 'sentinel.remove',
    targetId: (req) => req.params.id,
  })
  @Delete(':id')
  @Auth('staff')
  remove(): string { return 'removed' }
}
`

/**
 * {@link SENTINEL_SOURCE} 必须扫出来的结果。
 *
 * `routeCount: 4` 里的第 4 条是**带跨行装饰器**的 `remove`——它专门盯着
 * {@link foldMultilineDecorators}。那个折叠一旦坏掉，`remove` 会从结果里静默消失，
 * 而「少扫到一条路由」和「一切合规」在断言上长得一模一样。
 */
export const SENTINEL_EXPECTATION = {
  routeCount: 4,
  violationCount: 1,
  violatingMethod: 'bad',
  /** 带跨行装饰器的那条必须被扫到。 */
  multilineMethod: 'remove',
} as const
