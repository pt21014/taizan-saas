/**
 * 自实现 ULID（Universally Unique Lexicographically Sortable Identifier）。
 *
 * 蓝图 §3.2：全部主键 `String @id`，应用层生成 ULID（而非数据库自增或裸 UUID），
 * 因为 ULID 按时间字典序排列，分库分表/日志排查时天然按时间排序，还比 UUID 短且无连字符。
 *
 * 结构：48 位毫秒时间戳（10 位 Crockford Base32）+ 80 位随机数（16 位 Crockford Base32），
 * 共 26 位。同一毫秒内多次调用时，随机部分在前一次基础上 `+1` 递增，保证单调递增而不是
 * 完全随机——否则同一毫秒生成的两个 ULID 谁先谁后是不确定的，索引局部性会变差。
 *
 * 随机源固定用 `globalThis.crypto.getRandomValues`（Node 18+ 与浏览器均原生提供），
 * 不引入任何 npm 依赖。
 */

/** Crockford's Base32：排除易混淆的 I / L / O / U。 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ENCODING_LEN = ENCODING.length
/** 时间戳部分编码后的字符数（48 位时间戳，每字符 5 位，48/5 向上取整为 10）。 */
const TIME_LEN = 10
/** 随机数部分的字节数（80 位 = 10 字节）。 */
const RANDOM_BYTES = 10
/** ULID 总长度。 */
const ULID_LEN = 26

const ULID_PATTERN = new RegExp(`^[${ENCODING}]{${ULID_LEN}}$`)

// TS 5.7 起 TypedArray 带了 ArrayBuffer 泛型参数；这里统一用 ArrayBufferLike，
// 避免 `new Uint8Array(existingTypedArray)` 复制构造出的类型与字面量构造的类型对不上。
type Bytes = Uint8Array<ArrayBufferLike>

// 模块级状态：记录上一次生成时使用的毫秒时间戳与随机字节，
// 用于同毫秒内的单调递增。这与业界 ulid 实现（如 ulid.js）的做法一致。
let lastTime = -1
let lastRandom: Bytes = new Uint8Array(RANDOM_BYTES)

function getRandomValuesOrThrow(bytes: Bytes): Bytes {
  const cryptoObj = globalThis.crypto
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
    throw new Error(
      '[@taizan/contracts] 当前环境缺少 globalThis.crypto.getRandomValues，无法生成 ULID',
    )
  }
  cryptoObj.getRandomValues(bytes)
  return bytes
}

function encodeTime(time: number): string {
  if (!Number.isSafeInteger(time) || time < 0) {
    throw new Error(`[@taizan/contracts] ulid() 时间戳非法：${time}`)
  }
  let remaining = time
  let out = ''
  for (let i = 0; i < TIME_LEN; i++) {
    const mod = remaining % ENCODING_LEN
    out = ENCODING[mod] + out
    remaining = (remaining - mod) / ENCODING_LEN
  }
  return out
}

function decodeTime(timePart: string): number {
  let time = 0
  for (const ch of timePart) {
    time = time * ENCODING_LEN + ENCODING.indexOf(ch)
  }
  return time
}

function encodeRandom(bytes: Bytes): string {
  let bitBuffer = 0
  let bitCount = 0
  let out = ''
  for (const byte of bytes) {
    bitBuffer = (bitBuffer << 8) | byte
    bitCount += 8
    while (bitCount >= 5) {
      out += ENCODING[(bitBuffer >>> (bitCount - 5)) & 0x1f]
      bitCount -= 5
    }
  }
  return out
}

/** 对 80 位随机数 `+1`，用于同毫秒内的单调递增；理论溢出概率极低，溢出时直接报错。 */
function incrementRandom(bytes: Bytes): Bytes {
  const next: Bytes = new Uint8Array(bytes)
  for (let i = next.length - 1; i >= 0; i--) {
    const current = next[i]
    if (current === undefined) {
      continue
    }
    if (current < 0xff) {
      next[i] = current + 1
      return next
    }
    next[i] = 0
  }
  throw new Error('[@taizan/contracts] ULID 同一毫秒内随机数已溢出，请检查调用频率是否异常')
}

/**
 * 生成一个 26 位 ULID。同一毫秒内连续调用会得到单调递增（字典序更大）的结果。
 *
 * @param time - 可选，指定毫秒时间戳（主要用于测试）；默认 `Date.now()`。
 */
export function ulid(time: number = Date.now()): string {
  if (time === lastTime) {
    lastRandom = incrementRandom(lastRandom)
  } else {
    lastTime = time
    lastRandom = getRandomValuesOrThrow(new Uint8Array(RANDOM_BYTES))
  }
  return encodeTime(time) + encodeRandom(lastRandom)
}

/** 校验一个字符串是否是格式合法的 ULID（26 位 Crockford Base32，大小写均可）。 */
export function isUlid(value: string): boolean {
  if (typeof value !== 'string' || value.length !== ULID_LEN) {
    return false
  }
  return ULID_PATTERN.test(value.toUpperCase())
}

/**
 * 从 ULID 还原出生成时的毫秒时间戳。
 *
 * @throws 当 `id` 不是合法 ULID 时抛出。
 */
export function ulidTime(id: string): number {
  if (!isUlid(id)) {
    throw new Error(`[@taizan/contracts] "${id}" 不是合法的 ULID`)
  }
  return decodeTime(id.slice(0, TIME_LEN).toUpperCase())
}
