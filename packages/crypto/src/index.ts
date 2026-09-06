/**
 * `@taizan/crypto` —— 租户级密钥的加密、脱敏与轮换。
 *
 * 零框架依赖，只用 `node:crypto`，可在裸 node 环境跑单测。三块内容：
 *
 * | 模块 | 出口 | 干什么 |
 * |---|---|---|
 * | `vault` | {@link createVault} → {@link CredentialVault} | AES-256-GCM + keyId 多密钥的加解密与 {@link maskSecret} 脱敏 |
 * | `rotate` | {@link planRotation} / {@link executeRotation} | 幂等的密钥轮换：按 keyId 列挑行，第二次跑改动数为 0 |
 * | `columns` | {@link verifyEncryptedColumns} | 加密列三处对账（蓝图 §8 第 11 条），漏一列 = 换完密钥读不出来 |
 *
 * 最小用法：
 *
 * ```ts
 * import { createVault } from '@taizan/crypto'
 *
 * const vault = createVault({
 *   keys: JSON.parse(env.CRYPTO_KEYS),    // {"k1":"<64 hex>","k2":"<64 hex>"}
 *   currentKeyId: env.CRYPTO_KEY_CURRENT, // "k2"
 * })
 *
 * // 落库：密文与 keyId 必须成对写进 `*Enc` 列与配对的 keyId 列
 * const { valueEnc, keyId } = vault.encrypt(appSecret)
 * // 回给前端：永远是脱敏值，不是明文
 * const maskedHint = vault.mask(appSecret) // 32 位 secret → 前 4 + 24 个星 + 后 4
 * ```
 *
 * 轮换命令行见 `taizan-rotate-key --help`。
 */

export { CryptoError, DecryptError, InvalidKeyError, UnknownKeyIdError } from './errors'

export {
  CIPHER_VERSION,
  createVault,
  isEncryptedValue,
  maskSecret,
  type CredentialVault,
  type EncryptResult,
  type MaskOptions,
  type VaultOptions,
} from './vault'

export {
  DEFAULT_KEY_ID_OVERRIDES,
  ENCRYPTED_COLUMN_SUFFIX,
  formatEncryptedColumnsReport,
  keyIdColumnFor,
  parsePrismaModels,
  verifyEncryptedColumns,
  type ColumnRef,
  type EncryptedColumn,
  type EncryptedColumnsReport,
  type MissingKeyIdEntry,
  type ParsedModel,
  type VerifyEncryptedColumnsInput,
} from './columns'

export {
  DEFAULT_BATCH_SIZE,
  executeRotation,
  formatRotationPlan,
  formatRotationResult,
  planRotation,
  RotationPlanError,
  type ExecuteOptions,
  type RotationColumnResult,
  type RotationFailure,
  type RotationIo,
  type RotationOptions,
  type RotationPlan,
  type RotationPlanItem,
  type RotationQuery,
  type RotationResult,
  type RotationRow,
} from './rotate'
