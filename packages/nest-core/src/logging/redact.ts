/**
 * 日志脱敏（蓝图 §4.11）。
 *
 * 为什么不用 pino 自带的 `redact` 选项：pino 底层是 fast-redact，它的 path 语法里
 * `*` 只能匹配**整段** key（`a.*.b`），没法表达 `*Secret` / `*Enc` 这种**后缀**匹配。
 * 而加密列的命名约定就是 `xxxEnc`（`valueEnc`、`tokenEnc`…），一个个列举必然漏。
 * 所以改成自己深度遍历，挂在 pino 的 `formatters.log` 上。
 *
 * 手机号是**打码**而不是整个抹掉：客服拿着日志要能和商家对上是哪个用户，
 * 全抹成 `[REDACTED]` 就没法排查了；全留又是明文 PII。前 3 后 4 是行业通行折中。
 */

/** 脱敏后的占位符。 */
export const REDACTED = '[REDACTED]'

/** 完全抹掉的字段名（小写比较，任意层级命中即生效）。 */
export const REDACT_EXACT_KEYS: readonly string[] = [
  'password',
  'secret',
  'token',
  'authorization',
  'idcard',
  'refreshtoken',
  'accesstoken',
  'cookie',
  'setcookie',
]

/** 完全抹掉的字段名**后缀**（小写比较）：`clientSecret`、`valueEnc`、`apiToken`… */
export const REDACT_KEY_SUFFIXES: readonly string[] = [
  'secret',
  'enc',
  'token',
  'password',
  'apikey',
  'appsecret',
]

/** 走打码（而非抹除）的字段名后缀：手机号。 */
export const MASK_PHONE_KEY_SUFFIXES: readonly string[] = ['phone', 'mobile', 'tel']

/**
 * 手机号打码：只留前 3 后 4，中间一律 `*`。
 *
 * 长度不足 8 位的（座机、脏数据）直接整个抹掉——留前 3 后 4 等于几乎全留。
 */
export function maskPhone(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return REDACTED
  }
  const s = String(value)
  if (s.length < 8) {
    return REDACTED
  }
  return `${s.slice(0, 3)}${'*'.repeat(s.length - 7)}${s.slice(-4)}`
}

function normalizeKey(key: string): string {
  // `id_card` / `ID-Card` / `idCard` 归一成 `idcard`，避免换个写法就绕过。
  return key.toLowerCase().replace(/[_\-\s]/g, '')
}

/** 判定某个字段名该怎么处理。导出便于测试与业务侧复用同一套判定。 */
export function classifyKey(key: string): 'redact' | 'mask-phone' | 'keep' {
  const k = normalizeKey(key)
  if (REDACT_EXACT_KEYS.includes(k)) {
    return 'redact'
  }
  if (REDACT_KEY_SUFFIXES.some((suffix) => k.endsWith(suffix))) {
    return 'redact'
  }
  if (MASK_PHONE_KEY_SUFFIXES.some((suffix) => k.endsWith(suffix))) {
    return 'mask-phone'
  }
  return 'keep'
}

/** 遍历深度上限。日志对象再深也没有排查价值，超过就截断，同时防御异常深的结构。 */
const MAX_DEPTH = 8

/**
 * 深度脱敏一个即将进日志的对象。
 *
 * 不修改入参（返回新对象），并且用 `WeakSet` 处理循环引用——
 * 日志对象里带自引用（比如把 express `req` 整个塞进去）并不罕见，遇到就写 `[Circular]`。
 */
export function redactObject<T>(input: T): T {
  return walk(input, 0, new WeakSet<object>()) as T
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (depth >= MAX_DEPTH) {
    return '[Truncated]'
  }
  if (seen.has(value)) {
    return '[Circular]'
  }
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, depth + 1, seen))
  }
  // Error / Date / Buffer 这类内建对象原样保留，别把 Error 拆成 {} 丢掉堆栈。
  if (value instanceof Error || value instanceof Date || Buffer.isBuffer(value)) {
    return value
  }

  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    switch (classifyKey(key)) {
      case 'redact':
        out[key] = REDACTED
        break
      case 'mask-phone':
        out[key] = maskPhone(child)
        break
      default:
        out[key] = walk(child, depth + 1, seen)
    }
  }
  return out
}
