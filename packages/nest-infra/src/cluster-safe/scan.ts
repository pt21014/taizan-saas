/**
 * 集群安全静态扫描（蓝图 §8 第 12 条）。
 *
 * 守的是 knowledge 那条线上活故障：pm2 cluster 起 4 个进程之后，
 * `order-close.service.ts` / `profit-sharing.service.ts` 里的裸 `setInterval`
 * 变成了「同一笔订单被关 4 次、同一笔分账被发起 4 次」。
 *
 * ## 四条规则
 *
 * | # | 规则 | 例外 |
 * |---|---|---|
 * | 1 | 禁止裸 `setInterval` / `setTimeout` 做业务调度 | 白名单文件；或加 `// cluster-safe-allow: 理由` |
 * | 2 | 禁止 `@nestjs/schedule` 的 `@Cron` / `@Interval` / `@Timeout`，必须用 `@LeaderCron` | 无 |
 * | 3 | 一次性凭据（state / nonce / ticket / once）禁止用 `get(`，必须 `takeOnce` | 加 `// cluster-safe-allow: 理由` |
 * | 4 | 长驻的 `new Map()` / `new Set()`（模块级或类字段）必须标 `// process-local: 理由` | 无 |
 *
 * 规则 4 只盯**长驻容器**，靠两个形状识别（prettier 两空格缩进下稳定）：
 * 模块级的 `const/let/var`（缩进 0），以及类字段（缩进 2 且不以 `const/let/var` 开头）。
 * 函数体里的局部 `const x = new Map()` 随调用结束就没了，不是跨进程状态，不管。
 * 这是个启发式，但它的错误方向是安全的——误报只是逼人写一行注释，漏报才会出事故。
 *
 * 四条规则都跳过注释行：注释不执行，而在文档里举反例恰恰是好事，
 * 不该被自己的扫描器打回。
 *
 * 导出给 T0-8 的全仓 `cluster-safe.spec.ts` 与 T4-2 的生成器模板复用。
 *
 * @packageDocumentation
 */

/** 一条违规。 */
export interface ClusterSafetyViolation {
  /** 文件路径（原样回传，扫描器不关心它是绝对还是相对）。 */
  file: string
  /** 行号（从 1 开始）。 */
  line: number
  /** 规则编号。 */
  rule: 'timer' | 'nest-cron' | 'take-once' | 'process-local'
  /** 违规行原文（去首尾空白）。 */
  code: string
  /** 中文说明，直接可以贴进 CI 报错。 */
  message: string
}

/** 一个待扫文件。 */
export interface SourceFile {
  path: string
  content: string
}

/** 扫描选项。 */
export interface ClusterSafetyOptions {
  /**
   * 允许出现调度定时器的文件（后缀匹配，用 `/` 分隔）。
   *
   * 默认放行本包的 cron 调度器与锁看门狗——调度器本身总得有个定时器，
   * 关键是**只有这一处**。
   */
  timerAllowlist?: readonly string[]
}

/** 允许出现定时器的文件（默认值）。 */
export const DEFAULT_TIMER_ALLOWLIST: readonly string[] = [
  'src/cron/cron.scheduler.ts',
  'src/lock/watchdog.ts',
]

/** 逐行豁免标记。 */
export const ALLOW_MARKER = 'cluster-safe-allow:'

/** 进程内容器的标注标记。 */
export const PROCESS_LOCAL_MARKER = 'process-local:'

const TIMER_RE = /\b(setInterval|setTimeout)\s*\(/
const NEST_CRON_RE = /@(Cron|Interval|Timeout)\s*\(/
const ONE_TIME_GET_RE = /\.get\s*\(\s*[`'"][^`'"]*\b(state|nonce|ticket|once)\b/i

/** 模块级 `const/let/var x = new Map()`（缩进 0）。 */
const MODULE_CONTAINER_RE =
  /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*new\s+(?:Map|Set)\s*[(<]/

/** 类字段 `  private readonly x = new Map()`（缩进 2，且不是函数体里的局部声明）。 */
const CLASS_FIELD_CONTAINER_RE =
  /^ {2}(?!(?:const|let|var|return|await|yield)\b)(?:(?:private|public|protected|readonly|static|override|declare)\s+)*[#A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*new\s+(?:Map|Set)\s*[(<]/

/**
 * 扫一批文件。
 *
 * @returns 违规列表；空数组表示通过
 */
export function scanClusterSafety(
  files: readonly SourceFile[],
  options: ClusterSafetyOptions = {},
): ClusterSafetyViolation[] {
  const allowlist = options.timerAllowlist ?? DEFAULT_TIMER_ALLOWLIST
  const violations: ClusterSafetyViolation[] = []

  for (const file of files) {
    const normalizedPath = file.path.replace(/\\/g, '/')
    const timerAllowed = allowlist.some((suffix) => normalizedPath.endsWith(suffix))
    const lines = file.content.split(/\r?\n/)

    lines.forEach((line, index) => {
      const code = line.trim()
      // 注释行一律跳过：注释不执行，而在文档里举反例是好事，不该被自己的扫描器打回。
      if (isCommentLine(code)) return

      const lineNo = index + 1
      const marked = hasMarkerNear(lines, index, ALLOW_MARKER)

      if (TIMER_RE.test(line) && !timerAllowed && !marked && !isTypeOnly(line)) {
        violations.push({
          file: file.path,
          line: lineNo,
          rule: 'timer',
          code,
          message:
            '裸 setInterval / setTimeout 在多实例下会每个进程各跑一份（knowledge 线上活故障）。' +
            '定时任务请用 @LeaderCron；确实只是一次性延时/超时，请在上一行加 ' +
            `// ${ALLOW_MARKER} <理由>`,
        })
      }

      if (NEST_CRON_RE.test(line)) {
        violations.push({
          file: file.path,
          line: lineNo,
          rule: 'nest-cron',
          code,
          message:
            '@nestjs/schedule 的 @Cron / @Interval / @Timeout 没有 leader 选举，' +
            '4 个实例会同时执行。请改用 @taizan/nest-infra 的 @LeaderCron',
        })
      }

      if (ONE_TIME_GET_RE.test(line) && !marked) {
        violations.push({
          file: file.path,
          line: lineNo,
          rule: 'take-once',
          code,
          message:
            '一次性凭据（state / nonce / ticket / once）必须用 takeOnce（GETDEL 原子核销）。' +
            '先 get 再 del 时，两个进程可能同时判定同一个凭据有效',
        })
      }

      if (
        (MODULE_CONTAINER_RE.test(line) || CLASS_FIELD_CONTAINER_RE.test(line)) &&
        !hasMarkerNear(lines, index, PROCESS_LOCAL_MARKER)
      ) {
        violations.push({
          file: file.path,
          line: lineNo,
          rule: 'process-local',
          code,
          message:
            '长驻的 Map / Set 在多实例下每个进程各存一份（缓存不一致、限流额度 × 进程数）。' +
            `确实只该是进程内状态，请在上方加 // ${PROCESS_LOCAL_MARKER} <理由>；` +
            '需要跨进程共享请改用 CacheService / RedisService',
        })
      }
    })
  }

  return violations
}

/** 把违规列表渲染成一段可以直接塞进断言消息的中文报告。 */
export function formatViolations(violations: readonly ClusterSafetyViolation[]): string {
  if (violations.length === 0) return '（无）'
  return violations
    .map((v) => `  ${v.file}:${v.line} [${v.rule}] ${v.code}\n      → ${v.message}`)
    .join('\n')
}

/** 标记是否出现在本行或上方 5 行内。 */
function hasMarkerNear(lines: readonly string[], index: number, marker: string): boolean {
  for (let i = Math.max(0, index - 5); i <= index; i++) {
    if ((lines[i] ?? '').includes(marker)) return true
  }
  return false
}

/** 类型位置上的 `setTimeout`（例如 `typeof setTimeout`）不算调用。 */
function isTypeOnly(line: string): boolean {
  return /\btypeof\s+(setInterval|setTimeout)\b/.test(line)
}

/** 注释行（行注释、块注释的任意一行）。 */
function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}
