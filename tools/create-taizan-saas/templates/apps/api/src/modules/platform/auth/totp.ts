/**
 * 最小 TOTP（RFC 6238 / HOTP RFC 4226）实现，零依赖（只用 `node:crypto`）。
 *
 * ## 为什么不用 `otplib`
 *
 * 任务书建议用 `otplib`，但仓库里没有这个依赖（`grep -r otplib` 全仓一个命中都没有），
 * 而本次改动的允许范围不含任何 `package.json`/`pnpm-lock.yaml`——加一个新依赖必须过
 * `pnpm install`，那本身就是一次不在允许改动范围内的写操作。TOTP 算法本身只有
 * HMAC-SHA1 + 一次动态截断 + base32 编解码，规范固定、没有第三方还能做得更好的空间，
 * 手写一份可测试的最小实现比引入一个未声明的依赖更安全。
 *
 * @packageDocumentation
 */

import { createHmac, randomBytes } from 'node:crypto'

/** RFC 4648 base32 字母表（不含 padding）。 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** TOTP 时间步长（秒），RFC 6238 的推荐值。 */
const STEP_SECONDS = 30
/** 输出位数。 */
const DIGITS = 6

/** 把一段字节编码成不带 padding 的 base32 字符串（TOTP secret 的标准外部表示）。 */
export function base32Encode(buffer: Buffer): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  }
  return output
}

/** base32 解码；忽略大小写与 padding（`=`），非法字符直接丢弃（宽松解析，够用即可）。 */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/g, '')
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index === -1) continue
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/** 生成一个随机 TOTP secret（160 位/20 字节，与大多数 authenticator app 的默认长度一致），base32 表示。 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

/** HOTP（RFC 4226）：对一个计数器值算出定长数字码。 */
function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const counterBuf = Buffer.alloc(8)
  // JS number 精度在 2^53 以内足够安全，counter 是「现在的秒数/30」，远够用。
  counterBuf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  counterBuf.writeUInt32BE(counter >>> 0, 4)

  const hmac = createHmac('sha1', secret).update(counterBuf).digest()
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f
  const b0 = hmac[offset] ?? 0
  const b1 = hmac[offset + 1] ?? 0
  const b2 = hmac[offset + 2] ?? 0
  const b3 = hmac[offset + 3] ?? 0
  const binary = ((b0 & 0x7f) << 24) | ((b1 & 0xff) << 16) | ((b2 & 0xff) << 8) | (b3 & 0xff)
  const code = (binary % 10 ** digits).toString().padStart(digits, '0')
  return code
}

/** 算出某一时刻（默认现在）的 TOTP 六位码，`secretBase32` 是 {@link generateTotpSecret} 生成的那种。 */
export function totp(secretBase32: string, at: number = Date.now()): string {
  const counter = Math.floor(at / 1000 / STEP_SECONDS)
  return hotp(base32Decode(secretBase32), counter)
}

/** {@link verifyTotp} 的选项。 */
export interface VerifyTotpOptions {
  /** 允许前后偏移几个时间步（时钟不同步的容错），默认 1（即 ±30s）。 */
  window?: number
  /** 校验基准时刻，默认现在；测试用。 */
  at?: number
}

/**
 * 校验一枚 TOTP 一次性码。
 *
 * 允许 `±window` 个时间步的偏移（默认 1，即 ±30 秒）——认证器 app 与服务器的时钟
 * 不可能永远严格同步，窗口为 0 会导致「码本身没错，就是慢了几秒钟」这种真实存在的
 * 用户投诉。窗口也不宜开太大：每多 1 步就多一次 6 位码的碰撞窗口。
 */
export function verifyTotp(
  secretBase32: string,
  token: string,
  opts: VerifyTotpOptions = {},
): boolean {
  const trimmed = token.trim()
  if (!/^\d{6}$/.test(trimmed)) return false
  const window = opts.window ?? 1
  const at = opts.at ?? Date.now()
  const secret = base32Decode(secretBase32)
  const counter = Math.floor(at / 1000 / STEP_SECONDS)
  for (let delta = -window; delta <= window; delta += 1) {
    if (hotp(secret, counter + delta) === trimmed) return true
  }
  return false
}

/** {@link buildOtpauthUrl} 的选项。 */
export interface OtpauthUrlOptions {
  /** 认证器 app 里显示的发行方名字。 */
  issuer: string
  /** 认证器 app 里显示的账号名。 */
  accountName: string
}

/** 拼一条 `otpauth://totp/...` URL，扫码 app（Google/Microsoft Authenticator 等）通用格式。 */
export function buildOtpauthUrl(secretBase32: string, opts: OtpauthUrlOptions): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.accountName}`)
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer: opts.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}
