/**
 * 加密列注册表。
 *
 * 守的是蓝图 spec 11 的那条：**密钥轮换漏列 = 换完密钥读不出来**。
 * 三处必须对得上——本注册表 ↔ schema 里的 `*Enc` 列 ↔ `@taizan/crypto` 的轮换脚本覆盖列。
 * `schema.spec.ts` 负责前两处的双向对账（注册表里的列在 schema 里要存在、schema 里的
 * `*Enc` 列都要在注册表里、每个 `*Enc` 列都要有配对的 keyId 列）。
 *
 * xiaodian 的密钥轮换缺的就是 keyId：没有版本号，轮换到一半的行分不清是新密钥还是旧密钥。
 * 所以这里把 keyId 列名当成一等字段登记，而不是靠命名约定猜。
 */

/** 一条加密列登记。 */
export interface EncryptedColumn {
  /** Prisma 模型名。 */
  model: string
  /** 密文列名，约定以 `Enc` 结尾。 */
  column: string
  /** 与之配对的密钥版本号列名。轮换时按它挑行、写回。 */
  keyIdColumn: string
  /** 这列存的是什么，给轮换脚本与安全审计看。 */
  description: string
}

/** 密文列的命名约定后缀。`schema.spec.ts` 按它扫 schema 反查漏登记。 */
export const ENCRYPTED_COLUMN_SUFFIX = 'Enc'

/**
 * 框架基础表里的全部加密列。
 *
 * 业务项目自己的加密列在项目侧另建一份注册表，与本表合并后再喂给轮换脚本。
 */
export const ENCRYPTED_COLUMNS: readonly EncryptedColumn[] = [
  {
    model: 'TenantCredential',
    column: 'valueEnc',
    keyIdColumn: 'keyId',
    description: '租户级三方密钥（微信/支付/短信/对象存储）的密文，接口只回 maskedHint。',
  },
  {
    model: 'PlatformSetting',
    column: 'valueEnc',
    keyIdColumn: 'keyId',
    description: '平台级三方密钥的密文，与明文配置列 value 分开存。',
  },
  {
    model: 'PlatformAdmin',
    column: 'mfaSecretEnc',
    keyIdColumn: 'mfaKeyId',
    description: '平台管理员 TOTP 种子的密文；泄漏等于二次验证失效。',
  },
]
