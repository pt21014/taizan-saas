import { z } from 'zod'
import { zhErrorMap } from './zh-error-map'

/**
 * 在一份基础 schema 之上合并业务扩展字段（蓝图 §4.10）。
 *
 * 之所以不让业务项目直接 `BASE_ENV_SCHEMA.extend({...})`，是为了留一个收口点：
 * 将来框架要给所有 env 加统一处理（比如自动 trim、自动读 `_FILE` 后缀的 docker secret），
 * 改这里一处即可，不用去每个项目里翻 extend 调用。
 *
 * @example
 * ```ts
 * export const AppEnvSchema = defineEnvSchema(BASE_ENV_SCHEMA, {
 *   WECHAT_APPID: z.string().describe('公众号 appid'),
 * })
 * ```
 */
export function defineEnvSchema<B extends z.ZodRawShape, E extends z.ZodRawShape>(
  base: z.ZodObject<B>,
  ext: E,
): z.ZodObject<B & E> {
  return base.extend(ext) as unknown as z.ZodObject<B & E>
}

/** 跨字段校验器：返回若干条中文错误（`字段: 原因`），无错则返回空数组。 */
export type EnvCrossCheck = (env: Record<string, unknown>) => string[]

/**
 * `CRYPTO_KEY_CURRENT` 必须指向 `CRYPTO_KEYS` 里真实存在的 keyId。
 *
 * 这条是跨字段的，塞不进单个字段的 schema。配错的后果是启动时看着一切正常，
 * 直到第一次写加密列才 `keyId not found` —— 那时候已经在生产了。
 */
export const checkCryptoKeyCurrent: EnvCrossCheck = (env) => {
  const keys = env.CRYPTO_KEYS
  const current = env.CRYPTO_KEY_CURRENT
  if (typeof current !== 'string' || keys === null || typeof keys !== 'object') {
    return []
  }
  if (!Object.prototype.hasOwnProperty.call(keys, current)) {
    const available = Object.keys(keys as Record<string, unknown>)
    return [
      `CRYPTO_KEY_CURRENT: "${current}" 不在 CRYPTO_KEYS 中（已配置的 keyId：${
        available.length > 0 ? available.join(', ') : '（空）'
      }）`,
    ]
  }
  return []
}

/** 三套 JWT 密钥必须互不相同——共用一把等于 member token 可以冒充 staff。 */
export const checkJwtSecretsDistinct: EnvCrossCheck = (env) => {
  const entries: Array<readonly [string, string]> = []
  for (const key of ['JWT_SECRET_PLATFORM', 'JWT_SECRET_STAFF', 'JWT_SECRET_MEMBER'] as const) {
    const value = env[key]
    if (typeof value === 'string') {
      entries.push([key, value] as const)
    }
  }
  const errors: string[] = []
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]
      const b = entries[j]
      if (a && b && a[1] === b[1]) {
        errors.push(`${b[0]}: 与 ${a[0]} 使用了同一把密钥，三套身份的密钥必须互相独立`)
      }
    }
  }
  return errors
}

/** 框架默认启用的跨字段校验。 */
export const BASE_ENV_CROSS_CHECKS: readonly EnvCrossCheck[] = [
  checkCryptoKeyCurrent,
  checkJwtSecretsDistinct,
]

/** env 校验失败时抛出的错误；`fields` 列出每一条问题，便于测试与结构化上报。 */
export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError'
  constructor(readonly fields: readonly string[]) {
    super(
      `环境变量校验失败，共 ${fields.length} 项：\n${fields.map((f) => `  - ${f}`).join('\n')}\n` +
        '请对照 `.env.example`（可用 `pnpm taizan:env-example` 重新生成）补齐后再启动。',
    )
  }
}

/** {@link loadEnv} 的可选项。 */
export interface LoadEnvOptions {
  /** 跨字段校验器，默认 {@link BASE_ENV_CROSS_CHECKS}。传空数组可关闭。 */
  crossChecks?: readonly EnvCrossCheck[]
}

/**
 * 校验并加载 env。失败时抛 {@link EnvValidationError}，报错文本是**中文**且逐字段列出。
 *
 * 一次性把所有问题都报出来，而不是修一个报一个——运维在服务器上改 `.env` 是很贵的往返。
 *
 * @param schema - env schema，通常是 `BASE_ENV_SCHEMA` 或 {@link defineEnvSchema} 的产物
 * @param source - 原始 env，默认 `process.env`
 */
export function loadEnv<T extends z.ZodTypeAny>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
  options: LoadEnvOptions = {},
): z.infer<T> {
  const parsed = schema.safeParse(source, { errorMap: zhErrorMap })
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(根)'
      return `${path}: ${issue.message}`
    })
    throw new EnvValidationError(fields)
  }

  const value = parsed.data as unknown
  const crossChecks = options.crossChecks ?? BASE_ENV_CROSS_CHECKS
  if (value !== null && typeof value === 'object') {
    const errors = crossChecks.flatMap((check) => check(value as Record<string, unknown>))
    if (errors.length > 0) {
      throw new EnvValidationError(errors)
    }
  }
  return parsed.data as z.infer<T>
}
