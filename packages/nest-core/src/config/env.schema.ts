import { z } from 'zod'

/**
 * 框架基础 env 契约（蓝图 §4.10）。
 *
 * 三条不可退让：
 * 1. 三套 JWT 密钥各自 ≥32 位、互相独立——共用一把密钥意味着 member token 可以冒充 staff。
 * 2. `CRYPTO_KEYS` 是 **keyId → 64 hex** 的 JSON 映射（不是单把裸密钥），
 *    配合 `CRYPTO_KEY_CURRENT` 支持幂等轮换；老项目那种单 `CRYPTO_KEY` 换密钥要停机。
 * 3. dev 后门开关（`SMS_RETURN_DEV_CODE` / `WECHAT_DEV_FAKE_LOGIN`）默认关，
 *    且由 {@link assertNoDevCodeInProd} 在生产环境二次拒启。
 *
 * 每个字段都写了 `.describe()`——`taizan-env-example` 靠它生成 `.env.example`，
 * 不写描述的字段生成出来只有一个光秃秃的 key，等于没有文档。
 */

/** 从 env 字符串解析布尔值：`1/true/yes/on` 为真，`0/false/no/off/空` 为假。 */
function envBoolean(defaultValue: boolean) {
  return z
    .preprocess((raw) => {
      if (raw === undefined || raw === '') {
        return defaultValue
      }
      if (typeof raw === 'boolean') {
        return raw
      }
      const s = String(raw).trim().toLowerCase()
      if (['1', 'true', 'yes', 'on'].includes(s)) {
        return true
      }
      if (['0', 'false', 'no', 'off'].includes(s)) {
        return false
      }
      // 交给 z.boolean() 去报「类型不正确」，而不是在这里默默当成 false——
      // `BILLING_ENFORCE=ture`（拼错）静默变成 false 是收不到钱的那种 bug。
      return raw
    }, z.boolean())
    .default(defaultValue)
}

/** JWT 密钥字段：≥32 位，中文报错。 */
function jwtSecret(label: string) {
  return z
    .string({ required_error: `缺少必填项（${label} 的 JWT 签名密钥）` })
    .min(32, `${label} 的 JWT 密钥至少 32 位，当前太短，可用 \`openssl rand -base64 48\` 生成`)
}

/** `CRYPTO_KEYS` 的值：keyId → 64 位 hex（32 字节 AES-256 密钥）。 */
const CRYPTO_KEY_MAP = z.record(
  z.string().min(1),
  z.string().regex(/^[0-9a-fA-F]{64}$/, '必须是 64 位 hex（32 字节 AES-256 密钥）'),
)

/** {@link BASE_ENV_SCHEMA} 的原始 shape，供 {@link defineEnvSchema} 合并扩展字段。 */
export const BASE_ENV_SHAPE = {
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development')
    .describe('运行环境。production 会触发一系列安全硬检查（见 assertNoDevCodeInProd）'),

  API_PORT: z.coerce.number().int().positive().default(3000).describe('api 进程监听端口'),

  API_BASE_URL: z
    .string()
    .url()
    .default('http://localhost:3000')
    .describe('api 对外可访问的基址，用于拼接回调地址与 Swagger server'),

  DATABASE_URL: z
    // 文案说 MySQL 而不是 PostgreSQL：本框架的 Prisma datasource 就是 mysql
    // （`@taizan/prisma-base` 的 `00-datasource.prisma`），本地 compose 起的也是
    // MySQL 8。写错的代价不是校验放宽（`.url()` 两种都过），而是有人照着这句提示
    // 去配了一个连不上的库，然后从连接错误里反推我们到底用的哪个数据库。
    .string({ required_error: '缺少必填项（MySQL 连接串）' })
    .url()
    .describe('MySQL 连接串，例：mysql://user:pass@127.0.0.1:3306/taizan'),

  REDIS_URL: z
    .string({ required_error: '缺少必填项（Redis 连接串）' })
    .url()
    .describe('Redis 连接串，例：redis://127.0.0.1:6379/0'),

  JWT_SECRET_PLATFORM: jwtSecret('平台超管').describe(
    '平台超管 token 签名密钥，≥32 位，必须与另两套不同',
  ),
  JWT_SECRET_STAFF: jwtSecret('商家员工').describe(
    '商家员工 token 签名密钥，≥32 位，必须与另两套不同',
  ),
  JWT_SECRET_MEMBER: jwtSecret('C 端会员').describe(
    'C 端会员 token 签名密钥，≥32 位，必须与另两套不同',
  ),

  CRYPTO_KEYS: z
    .preprocess((raw) => {
      if (typeof raw !== 'string' || raw.trim() === '') {
        return raw
      }
      try {
        return JSON.parse(raw) as unknown
      } catch {
        // 让下面的 record 校验去报「类型不正确」，同时保留原文便于排查。
        return raw
      }
    }, CRYPTO_KEY_MAP)
    .describe(
      '加密列密钥表，JSON：{"k1":"<64 hex>","k2":"<64 hex>"}。轮换时新增 keyId 而不是改旧值',
    ),

  CRYPTO_KEY_CURRENT: z
    .string({ required_error: '缺少必填项（当前使用的加密 keyId）' })
    .min(1)
    .describe('当前用于加密的 keyId，必须是 CRYPTO_KEYS 里已存在的键'),

  CORS_ORIGINS: z
    .preprocess(
      (raw) =>
        typeof raw === 'string'
          ? raw
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
          : (raw ?? []),
      z.array(z.string()),
    )
    .default([])
    .describe(
      '允许跨域的 Origin 白名单，逗号分隔；支持 https://*.example.com 通配。生产环境留空会拒启',
    ),

  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(1).describe(
    '可信反代层数。resolveIps 从 X-Forwarded-For 末尾倒数这么多跳取真实客户端 IP，配错等于限流可被伪造绕过', // ip-source-ok: 这是给运维看的 env 说明文案，不是在读这个头
  ),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info')
    .describe('pino 日志级别'),

  BILLING_ENFORCE: envBoolean(false).describe(
    '计费闸门总开关。false 时到期租户仍可写（只记 reason），上线收费前才置 true',
  ),

  SMS_RETURN_DEV_CODE: envBoolean(false).describe(
    '【危险·联调用】把短信验证码回传给调用方 = 任意手机号免验证登录。生产环境置真会拒启',
  ),

  WECHAT_DEV_FAKE_LOGIN: envBoolean(false).describe(
    '【危险·联调用】跳过微信 jscode2session 直接签发会员 token。生产环境置真会拒启',
  ),

  SWAGGER_ENABLED: envBoolean(false).describe(
    '是否开启 Swagger。非 production 默认开；production 只有显式置真才开（会暴露全部接口形状）',
  ),
} as const

/** 框架基础 env schema。业务项目用 {@link defineEnvSchema} 在此之上追加自己的字段。 */
export const BASE_ENV_SCHEMA = z.object(BASE_ENV_SHAPE)

/** 校验通过后的基础 env 类型。 */
export type BaseEnv = z.infer<typeof BASE_ENV_SCHEMA>
