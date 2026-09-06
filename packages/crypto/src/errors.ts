/**
 * 本包的错误类型。
 *
 * 一条铁律：**错误信息里永远不出现明文、密文全文与密钥内容**。
 * 密钥类错误最常见的泄漏路径不是被人拖库，而是被自己的日志/Sentry 原样记下来——
 * xiaodian 的 `CRYPTO key 必须是 64 位 hex` 之所以安全，正因为它没有回显那把 key。
 * 这里把「只说哪一把、不说是什么」固化成类型。
 */

/** 本包所有错误的基类，便于调用方一次性 `catch (e) { if (e instanceof CryptoError) ... }`。 */
export class CryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/**
 * 密钥表本身不合法（不是 64 hex / currentKeyId 不在表里 / 表为空）。
 *
 * 在 {@link createVault} 时就抛，不留到第一次加密才炸——启动即失败比运行时失败便宜得多。
 */
export class InvalidKeyError extends CryptoError {
  /** 出问题的 keyId；表为空这类场景为 undefined。 */
  readonly keyId?: string

  constructor(message: string, keyId?: string) {
    super(message)
    this.keyId = keyId
  }
}

/**
 * 密文标注的 keyId 不在当前密钥表里。
 *
 * 典型场景：轮换到一半就把旧 keyId 从 `CRYPTO_KEYS` 里删了。
 * 这跟「密文被篡改」是两回事，所以单独一个类型——运维看到它应该去补密钥，而不是去查数据损坏。
 */
export class UnknownKeyIdError extends CryptoError {
  /** 密文里标注的、当前解不开的 keyId。 */
  readonly keyId: string

  constructor(keyId: string, knownKeyIds: readonly string[]) {
    super(
      `未知的加密密钥版本号 keyId=${keyId}；当前 CRYPTO_KEYS 里只有 [${knownKeyIds.join(', ')}]。` +
        `轮换期间不要删旧 keyId，等 executeRotation 把所有列都换完再删。`,
    )
    this.keyId = keyId
  }
}

/**
 * 解密失败：格式不对、被截断，或 GCM tag 校验不通过（密文/tag 被改过，或用错了密钥）。
 *
 * 刻意不区分「密钥不对」与「密文被篡改」——GCM 的 tag 校验失败在密码学上就是同一件事，
 * 分开报反而给攻击者送信息。
 */
export class DecryptError extends CryptoError {
  constructor(reason: string) {
    super(`密文解密失败：${reason}`)
  }
}
