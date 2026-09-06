/**
 * 口令哈希：scrypt，格式 `scrypt$N$r$p$salt$hash`（salt/hash 均为 base64）。
 *
 * 为什么是 scrypt 而不是 bcrypt/argon2：node 内置 `node:crypto` 就有，
 * **不引入任何原生依赖**——框架的 seed 要能在裸 node、CI 容器、生成器产出的空项目里跑，
 * 一个需要编译的依赖就足以让 `pnpm install` 在某台机器上炸掉。
 *
 * 为什么把参数写进哈希串：以后调 N（成本参数）时，老口令还得能校验。参数存在串里，
 * 校验用串里的参数、下次改密时按当前参数重算，就能平滑升级；参数写死在代码里做不到。
 *
 * 本模块由 `@taizan/nest-auth` 复用（登录校验、改密），所以 `hashPassword` /
 * `verifyPassword` 的串格式是跨包契约，改格式等于破坏性变更。
 */

import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'

/** scrypt 参数。 */
export interface ScryptParams {
  /** CPU/内存成本，必须是大于 1 的 2 的幂。 */
  N: number
  /** 块大小。 */
  r: number
  /** 并行度。 */
  p: number
  /** 盐字节数。 */
  saltBytes: number
  /** 派生密钥字节数。 */
  keyBytes: number
}

/**
 * 默认参数：N=16384, r=8, p=1，约 16 MB 内存、单次 ~50–100 ms。
 *
 * node 的 scrypt 默认 `maxmem` 是 32 MB，`128 * N * r` = 16 MB 正好在限内；
 * 把 N 再翻一倍就必须同时抬 maxmem，属于要专门决策的事，不做默认。
 */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = {
  N: 16384,
  r: 8,
  p: 1,
  saltBytes: 16,
  keyBytes: 32,
}

/** 哈希串的算法前缀。 */
export const PASSWORD_HASH_ALGORITHM = 'scrypt'

/** 解析出来的哈希串。 */
export interface ParsedPasswordHash {
  /** 算法名，恒为 `scrypt`。 */
  algorithm: string
  /** CPU/内存成本。 */
  N: number
  /** 块大小。 */
  r: number
  /** 并行度。 */
  p: number
  /** 盐。 */
  salt: Buffer
  /** 派生密钥。 */
  hash: Buffer
}

function assertPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('口令必须是非空字符串。')
  }
}

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 1 && (value & (value - 1)) === 0
}

function assertParams(params: ScryptParams): void {
  if (!isPowerOfTwo(params.N)) {
    throw new RangeError(`scrypt 的 N 必须是大于 1 的 2 的幂，收到 ${params.N}。`)
  }
  if (!Number.isInteger(params.r) || params.r < 1)
    throw new RangeError('scrypt 的 r 必须是正整数。')
  if (!Number.isInteger(params.p) || params.p < 1)
    throw new RangeError('scrypt 的 p 必须是正整数。')
  if (!Number.isInteger(params.saltBytes) || params.saltBytes < 8) {
    throw new RangeError('盐至少 8 字节。')
  }
  if (!Number.isInteger(params.keyBytes) || params.keyBytes < 16) {
    throw new RangeError('派生密钥至少 16 字节。')
  }
}

/** `128 * N * r` 是 scrypt 的内存下限，留一倍余量传给 node，避免 ERR_CRYPTO_INVALID_SCRYPT_PARAMS。 */
function maxmemFor(params: ScryptParams): number {
  return Math.max(32 * 1024 * 1024, 256 * params.N * params.r)
}

function format(params: ScryptParams, salt: Buffer, hash: Buffer): string {
  return [
    PASSWORD_HASH_ALGORITHM,
    String(params.N),
    String(params.r),
    String(params.p),
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$')
}

/**
 * 解析哈希串。
 *
 * @param stored - 形如 `scrypt$16384$8$1$<saltB64>$<hashB64>` 的串
 * @returns 解析结果；格式不对、字段数不对、数字非法、base64 解不出来时返回 `undefined`
 */
export function parsePasswordHash(stored: unknown): ParsedPasswordHash | undefined {
  if (typeof stored !== 'string') return undefined
  const parts = stored.split('$')
  if (parts.length !== 6) return undefined
  const [algorithm, rawN, rawR, rawP, rawSalt, rawHash] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ]
  if (algorithm !== PASSWORD_HASH_ALGORITHM) return undefined

  const N = Number(rawN)
  const r = Number(rawR)
  const p = Number(rawP)
  if (!isPowerOfTwo(N)) return undefined
  if (!Number.isInteger(r) || r < 1) return undefined
  if (!Number.isInteger(p) || p < 1) return undefined

  const salt = Buffer.from(rawSalt, 'base64')
  const hash = Buffer.from(rawHash, 'base64')
  // base64 解码对垃圾输入不会抛错，只会解出短串，所以长度自己兜底。
  if (salt.length < 8 || hash.length < 16) return undefined
  // 防篡改：`Buffer.from(x, 'base64')` 会悄悄吞掉非法字符，回编码对不上就说明串被改过。
  if (salt.toString('base64') !== rawSalt || hash.toString('base64') !== rawHash) return undefined

  return { algorithm, N, r, p, salt, hash }
}

function derive(
  password: string,
  salt: Buffer,
  params: Pick<ScryptParams, 'N' | 'r' | 'p'>,
  keyBytes: number,
): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    scrypt(
      password,
      salt,
      keyBytes,
      {
        N: params.N,
        r: params.r,
        p: params.p,
        maxmem: maxmemFor({ ...DEFAULT_SCRYPT_PARAMS, ...params }),
      },
      (error, key) => {
        if (error) rejectPromise(error)
        else resolvePromise(key)
      },
    )
  })
}

/**
 * 生成口令哈希（异步，不占事件循环）。
 *
 * @param password - 明文口令，非空
 * @param params - scrypt 参数，默认 {@link DEFAULT_SCRYPT_PARAMS}
 * @returns `scrypt$N$r$p$salt$hash`
 * @throws {@link TypeError} 口令为空 / 非字符串；{@link RangeError} 参数非法
 */
export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  assertPassword(password)
  assertParams(params)
  const salt = randomBytes(params.saltBytes)
  const hash = await derive(password, salt, params, params.keyBytes)
  return format(params, salt, hash)
}

/**
 * 生成口令哈希（同步版）。
 *
 * 会阻塞事件循环约 50–100 ms，**只给 seed / 一次性脚本用**；HTTP 请求路径上一律用
 * {@link hashPassword}。
 *
 * @param password - 明文口令，非空
 * @param params - scrypt 参数，默认 {@link DEFAULT_SCRYPT_PARAMS}
 * @returns `scrypt$N$r$p$salt$hash`
 */
export function hashPasswordSync(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): string {
  assertPassword(password)
  assertParams(params)
  const salt = randomBytes(params.saltBytes)
  const hash = scryptSync(password, salt, params.keyBytes, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: maxmemFor(params),
  })
  return format(params, salt, hash)
}

/**
 * 校验口令（异步）。
 *
 * 用 `timingSafeEqual` 比对，且**任何异常都只回 false**：把「串坏了」和「口令错了」
 * 在返回值上合并，免得错误信息本身变成账号是否存在的旁道。
 *
 * @param password - 用户输入的明文
 * @param stored - 库里存的哈希串
 * @returns 是否匹配
 */
export async function verifyPassword(password: unknown, stored: unknown): Promise<boolean> {
  if (typeof password !== 'string' || password.length === 0) return false
  const parsed = parsePasswordHash(stored)
  if (parsed === undefined) return false
  try {
    const actual = await derive(password, parsed.salt, parsed, parsed.hash.length)
    return actual.length === parsed.hash.length && timingSafeEqual(actual, parsed.hash)
  } catch {
    return false
  }
}

/**
 * 校验口令（同步版，只给脚本用）。
 *
 * @param password - 用户输入的明文
 * @param stored - 库里存的哈希串
 * @returns 是否匹配
 */
export function verifyPasswordSync(password: unknown, stored: unknown): boolean {
  if (typeof password !== 'string' || password.length === 0) return false
  const parsed = parsePasswordHash(stored)
  if (parsed === undefined) return false
  try {
    const actual = scryptSync(password, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: maxmemFor({ ...DEFAULT_SCRYPT_PARAMS, N: parsed.N, r: parsed.r, p: parsed.p }),
    })
    return actual.length === parsed.hash.length && timingSafeEqual(actual, parsed.hash)
  } catch {
    return false
  }
}

/**
 * 这份哈希是不是用当前默认参数生成的。
 *
 * 登录成功时顺手调一下：`false` 就用用户刚输入的明文按新参数重算一遍写回，
 * 成本参数才能真正随时间提上去。
 *
 * @param stored - 库里存的哈希串
 * @param params - 当前默认参数
 * @returns 需要重算时返回 `true`（串坏了也返回 `true`）
 */
export function needsRehash(
  stored: unknown,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): boolean {
  const parsed = parsePasswordHash(stored)
  if (parsed === undefined) return true
  return (
    parsed.N !== params.N ||
    parsed.r !== params.r ||
    parsed.p !== params.p ||
    parsed.salt.length !== params.saltBytes ||
    parsed.hash.length !== params.keyBytes
  )
}
