/**
 * `CredentialVault`：AES-256-GCM + keyId 多密钥的密文金库。
 *
 * 与老项目的两点差别，都是为了「能换密钥」：
 *
 * 1. **密钥表而不是单把密钥**。xiaodian 的 `CRYPTO_KEY` 是一把裸密钥，换密钥要停机，
 *    换到一半的行分不清新旧。这里配置的是 `CRYPTO_KEYS='{"k1":"…","k2":"…"}'` +
 *    `CRYPTO_KEY_CURRENT=k2`（zod 校验见 `@taizan/nest-core` 的 `env.schema.ts`），
 *    每条密文旁边都有一列 keyId 记着它是谁加的，轮换因此可以按行推进、随时中断续跑。
 * 2. **密文带版本前缀**。格式 `v1:<iv b64>:<tag b64>:<data b64>`。
 *    xiaodian 存的是裸 base64，将来想换算法（比如上 KMS 信封加密）没有任何余地——
 *    只能靠长度猜，猜错就是解不出来。`v1:` 这三个字节买的是「以后能换」。
 *
 * 零框架依赖，只用 `node:crypto`，可在裸 node 环境跑单测。
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import { DecryptError, InvalidKeyError, UnknownKeyIdError } from './errors'

/** 加密算法。改这里必须同时升 {@link CIPHER_VERSION}，否则老密文解不出来。 */
const ALGORITHM = 'aes-256-gcm'

/** GCM 推荐的 IV 长度（字节）。12 字节是 NIST SP 800-38D 的推荐值，不要改成 16。 */
const IV_LENGTH = 12

/** GCM 认证标签长度（字节）。 */
const TAG_LENGTH = 16

/** AES-256 的密钥长度（字节），对应 64 位 hex。 */
const KEY_LENGTH = 32

/** 当前密文格式版本。密文以 `v1:` 开头，换算法时升成 `v2:` 并保留 v1 的解密分支。 */
export const CIPHER_VERSION = 'v1'

/** 64 位 hex 的密钥格式。与 `@taizan/nest-core` 的 `CRYPTO_KEYS` zod 校验保持一致。 */
const HEX_KEY_RE = /^[0-9a-fA-F]{64}$/

/** {@link CredentialVault.mask} 的选项。 */
export interface MaskOptions {
  /** 保留的开头字符数，默认 4。 */
  head?: number
  /** 保留的结尾字符数，默认 4。 */
  tail?: number
}

/** {@link CredentialVault.encrypt} 的返回：密文与它对应的密钥版本号，两者必须成对落库。 */
export interface EncryptResult {
  /** 密文，格式 `v1:<iv b64>:<tag b64>:<data b64>`，写进 `*Enc` 列。 */
  valueEnc: string
  /** 加密所用的密钥版本号，写进配对的 keyId 列。 */
  keyId: string
}

/** {@link createVault} 的入参。 */
export interface VaultOptions {
  /** keyId → 64 位 hex 密钥。对应环境变量 `CRYPTO_KEYS` 解析后的对象。 */
  keys: Record<string, string>
  /** 当前用于加密的 keyId，必须是 `keys` 里已存在的键。对应 `CRYPTO_KEY_CURRENT`。 */
  currentKeyId: string
}

/**
 * 密文金库。蓝图 §4.10 的 `CredentialVault`，在其基础上补了轮换与展示要用的几个方法。
 */
export interface CredentialVault {
  /** 当前用于加密的 keyId。 */
  readonly currentKeyId: string
  /** 密钥表里全部 keyId（按配置顺序），用于排错与 CLI 打印，**不含密钥内容**。 */
  readonly keyIds: readonly string[]

  /**
   * 用当前密钥加密。
   *
   * 同一段明文两次加密的密文一定不同（每次随机 12 字节 IV），
   * 所以**不能**拿密文做等值查询或唯一索引——要查重请另存哈希列。
   *
   * @param plain - 明文。空串是合法输入，会得到一段合法密文。
   * @returns 密文与密钥版本号，两者必须一起落库。
   */
  encrypt(plain: string): EncryptResult

  /**
   * 用指定 keyId 加密。轮换时把明文重新加到**目标**密钥上，走的就是这个口。
   *
   * @param plain - 明文
   * @param keyId - 目标密钥版本号，必须在密钥表里
   * @throws {UnknownKeyIdError} keyId 不在密钥表里
   */
  encryptWith(plain: string, keyId: string): EncryptResult

  /**
   * 解密。
   *
   * @param valueEnc - 密文（`*Enc` 列的值）
   * @param keyId - 该行配对 keyId 列的值
   * @throws {UnknownKeyIdError} keyId 不在密钥表里（多半是旧 keyId 被提前删了）
   * @throws {DecryptError} 格式不对、被截断，或 GCM tag 校验不通过
   */
  decrypt(valueEnc: string, keyId: string): string

  /**
   * 脱敏展示。接口回给前端的永远是它，不是明文。
   *
   * 32 位的 secret 在默认参数下只露前 4 后 4；
   * 短于 `head + tail + 2` 的值全打星——留头留尾对短值等于直接把它交出去。
   *
   * @param plain - 明文
   * @param opts - 保留的头尾长度，默认各 4
   */
  mask(plain: string, opts?: MaskOptions): string

  /**
   * 这个值看起来是不是本包加密过的密文（认 `v1:` 前缀与四段结构）。
   *
   * 用途是识别历史明文列（存量数据加密迁移时会遇到明文/密文混存），
   * **不是**安全校验——真伪只有 {@link CredentialVault.decrypt} 的 tag 校验说了算。
   */
  isEncrypted(value: unknown): boolean

  /**
   * 这个 keyId 是否已经落后于当前密钥（即需要轮换）。
   *
   * @throws {UnknownKeyIdError} keyId 不在密钥表里
   */
  needsRotation(keyId: string): boolean
}

/**
 * 脱敏展示（独立函数版，不需要密钥表也能用）。
 *
 * 按 **Unicode 码点**而不是 UTF-16 code unit 切，中文与 emoji 不会被劈成半个字符。
 *
 * @param plain - 明文；空串原样返回空串
 * @param opts - 保留的头尾长度，默认各 4
 * @returns 脱敏后的字符串，长度与原文码点数一致
 */
export function maskSecret(plain: string, opts: MaskOptions = {}): string {
  const head = opts.head ?? 4
  const tail = opts.tail ?? 4
  if (!Number.isInteger(head) || head < 0 || !Number.isInteger(tail) || tail < 0) {
    throw new RangeError('mask 的 head/tail 必须是非负整数')
  }
  const chars = Array.from(plain)
  if (chars.length === 0) return ''
  // 少于 head + tail + 2 个字符时留头留尾等于没脱敏（中间最多剩 1 个字符），直接全打星。
  if (chars.length < head + tail + 2) return '*'.repeat(chars.length)
  return (
    chars.slice(0, head).join('') +
    '*'.repeat(chars.length - head - tail) +
    chars.slice(chars.length - tail).join('')
  )
}

/**
 * 这个值看起来是不是本包加密过的密文（独立函数版）。
 *
 * 认的是 `v1:` 前缀 + 四段冒号结构，不做密码学校验。
 */
export function isEncryptedValue(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const parts = value.split(':')
  if (parts.length !== 4) return false
  if (parts[0] !== CIPHER_VERSION) return false
  // data 段允许为空（空明文加出来就是空 data），iv 与 tag 段不允许。
  return parts[1] !== '' && parts[2] !== ''
}

/**
 * 校验单把密钥并转成 Buffer。
 *
 * 报错只说是哪个 keyId 出的问题，**绝不回显密钥内容**——这行错误信息大概率会进日志。
 */
function toKeyBuffer(keyId: string, hex: unknown): Buffer {
  if (typeof hex !== 'string' || !HEX_KEY_RE.test(hex)) {
    throw new InvalidKeyError(
      `加密密钥 keyId=${keyId} 格式不合法：必须是 64 位 hex（32 字节 AES-256 密钥），` +
        '可用 `openssl rand -hex 32` 生成',
      keyId,
    )
  }
  const buf = Buffer.from(hex, 'hex')
  /* c8 ignore next 3 -- 正则已保证 64 hex，这里只是防御性兜底 */
  if (buf.length !== KEY_LENGTH) {
    throw new InvalidKeyError(`加密密钥 keyId=${keyId} 解析出来不是 32 字节`, keyId)
  }
  return buf
}

/**
 * 建一个密文金库。
 *
 * ```ts
 * const vault = createVault({
 *   keys: JSON.parse(env.CRYPTO_KEYS),    // {"k1":"<64 hex>","k2":"<64 hex>"}
 *   currentKeyId: env.CRYPTO_KEY_CURRENT, // "k2"
 * })
 * const { valueEnc, keyId } = vault.encrypt('wx_secret_xxx')
 * ```
 *
 * @param options - 密钥表与当前 keyId
 * @throws {InvalidKeyError} 密钥表为空、某把密钥不是 64 hex、或 currentKeyId 不在表里
 */
export function createVault(options: VaultOptions): CredentialVault {
  const { keys, currentKeyId } = options
  const keyIds = Object.keys(keys ?? {})
  if (keyIds.length === 0) {
    throw new InvalidKeyError('加密密钥表为空：CRYPTO_KEYS 至少要有一把密钥')
  }
  if (typeof currentKeyId !== 'string' || currentKeyId === '') {
    throw new InvalidKeyError('缺少 CRYPTO_KEY_CURRENT：必须指明当前用哪个 keyId 加密')
  }

  const buffers = new Map<string, Buffer>()
  for (const keyId of keyIds) {
    buffers.set(keyId, toKeyBuffer(keyId, keys[keyId]))
  }
  if (!buffers.has(currentKeyId)) {
    throw new InvalidKeyError(
      `CRYPTO_KEY_CURRENT=${currentKeyId} 不在 CRYPTO_KEYS 里；` +
        `当前可用的 keyId 有 [${keyIds.join(', ')}]`,
      currentKeyId,
    )
  }

  function keyOf(keyId: string): Buffer {
    const buf = buffers.get(keyId)
    if (!buf) throw new UnknownKeyIdError(keyId, keyIds)
    return buf
  }

  function encryptWith(plain: string, keyId: string): EncryptResult {
    if (typeof plain !== 'string') {
      throw new TypeError('encrypt 只接受字符串明文；结构化数据请调用方先 JSON.stringify')
    }
    const key = keyOf(keyId)
    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv(ALGORITHM, key, iv)
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    const valueEnc = [
      CIPHER_VERSION,
      iv.toString('base64'),
      tag.toString('base64'),
      data.toString('base64'),
    ].join(':')
    return { valueEnc, keyId }
  }

  return {
    currentKeyId,
    keyIds,

    encrypt(plain) {
      return encryptWith(plain, currentKeyId)
    },

    encryptWith,

    decrypt(valueEnc, keyId) {
      const key = keyOf(keyId)
      if (typeof valueEnc !== 'string' || valueEnc === '') {
        throw new DecryptError('密文为空')
      }
      const parts = valueEnc.split(':')
      if (parts.length !== 4) {
        throw new DecryptError('格式不合法，期望 `v1:<iv>:<tag>:<data>` 四段')
      }
      // 上面已确认是四段；给默认值只是为了满足 noUncheckedIndexedAccess。
      const [version = '', ivB64 = '', tagB64 = '', dataB64 = ''] = parts
      if (version !== CIPHER_VERSION) {
        throw new DecryptError(`不认识的密文版本 ${version}，本包只能解 ${CIPHER_VERSION}`)
      }
      const iv = Buffer.from(ivB64, 'base64')
      const tag = Buffer.from(tagB64, 'base64')
      if (iv.length !== IV_LENGTH) throw new DecryptError('IV 长度不合法')
      if (tag.length !== TAG_LENGTH) throw new DecryptError('认证标签长度不合法')
      const data = Buffer.from(dataB64, 'base64')
      try {
        const decipher = createDecipheriv(ALGORITHM, key, iv)
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
      } catch {
        // 刻意不透传 node 的原始错误，也不回显密文：GCM 里「密钥不对」与「密文被改」
        // 本来就是同一件事，分开报等于给攻击者送信息。
        throw new DecryptError('认证标签校验不通过（密文被改动，或这行的 keyId 记错了）')
      }
    },

    mask(plain, opts) {
      return maskSecret(plain, opts)
    },

    isEncrypted(value) {
      return isEncryptedValue(value)
    },

    needsRotation(keyId) {
      keyOf(keyId)
      return keyId !== currentKeyId
    },
  }
}
