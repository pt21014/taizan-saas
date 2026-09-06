/**
 * 金额工具（蓝图 §3.1）：全仓金额一律用「分」表示的 `Int`，字段名以 `Cents` 结尾，
 * 禁用浮点/`Decimal`。本模块负责「分」与展示用「元」字符串之间的互转，
 * 且互转全部走字符串/整数运算，不经过浮点除法，避免 `0.1 + 0.2 !== 0.3` 这类误差。
 */

/** {@link formatCents} 的可选格式化选项。 */
export interface FormatCentsOptions {
  /** 是否加千分位分隔符（如 `1,234.56`），默认 `false`。 */
  grouping?: boolean
  /** 货币符号前缀（如 `'¥'`），默认不加。 */
  currencySymbol?: string
}

/**
 * 断言一个数值是合法的「分」金额：必须是安全整数（正负均可，0 也合法）。
 *
 * @param value - 待校验的数值
 * @param label - 出错信息里用于标识来源的字段名，默认 `'cents'`
 * @throws 当不是安全整数时抛出
 */
export function assertCents(value: number, label = 'cents'): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw new Error(
      `[@taizan/contracts] ${label}=${String(value)} 不是合法的「分」金额（必须是安全整数）`,
    )
  }
}

/**
 * 把「分」整数格式化为形如 `'12.34'` 的展示字符串（不带正负号以外的其他修饰，除非通过 opts 指定）。
 *
 * @example
 * ```ts
 * formatCents(1234)                              // '12.34'
 * formatCents(-1234)                              // '-12.34'
 * formatCents(123456789, { grouping: true })      // '1,234,567.89'
 * formatCents(1234, { currencySymbol: '¥' })      // '¥12.34'
 * ```
 */
export function formatCents(cents: number, opts: FormatCentsOptions = {}): string {
  assertCents(cents)
  const negative = cents < 0
  const abs = Math.abs(cents)
  const yuan = Math.floor(abs / 100)
  const fraction = String(abs % 100).padStart(2, '0')
  let yuanStr = String(yuan)
  if (opts.grouping) {
    yuanStr = yuanStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  }
  const symbol = opts.currencySymbol ?? ''
  return `${negative ? '-' : ''}${symbol}${yuanStr}.${fraction}`
}

// 严格金额字符串：可选负号 + 至少一位整数 + 可选 1~2 位小数。
// 不接受科学计数法（'1e2'）、多于 2 位小数、空字符串等——「严格」意味着宁可拒绝也不猜。
const STRICT_AMOUNT_PATTERN = /^-?\d+(?:\.\d{1,2})?$/

/**
 * 把形如 `'12.34'` 的金额字符串严格解析为「分」整数。
 *
 * 严格体现在：
 * - 拒绝科学计数法（`'1e2'`）、拒绝超过 2 位小数、拒绝空字符串/非数字字符；
 * - 全程走字符串拆分 + 整数乘加，不经过 `parseFloat` 之类的浮点运算，避免浮点误差；
 * - 结果超出安全整数范围时拒绝，而不是静默产出一个不精确的值。
 *
 * 允许千分位分隔符（如 `'1,234.56'`）以便与 {@link formatCents} 的 `grouping` 输出往返。
 *
 * @throws 当输入不是合法金额字符串，或换算结果超出安全整数范围时抛出
 */
export function parseToCents(input: string): number {
  if (typeof input !== 'string') {
    throw new Error(`[@taizan/contracts] parseToCents() 需要字符串输入，收到 ${typeof input}`)
  }
  const trimmed = input.trim().replace(/,/g, '')
  if (!STRICT_AMOUNT_PATTERN.test(trimmed)) {
    throw new Error(`[@taizan/contracts] "${input}" 不是合法的金额字符串（形如 '12.34'）`)
  }
  const negative = trimmed.startsWith('-')
  const unsigned = negative ? trimmed.slice(1) : trimmed
  const [intPart, fracPartRaw = ''] = unsigned.split('.')
  const fracPart = fracPartRaw.padEnd(2, '0')
  const cents = Number(intPart) * 100 + Number(fracPart)
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`[@taizan/contracts] "${input}" 换算后的分值超出安全整数范围`)
  }
  if (cents === 0) {
    return 0 // 避免 '-0.00' 解析出 -0
  }
  return negative ? -cents : cents
}
