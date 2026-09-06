/**
 * `apps/api` 的 env 契约 = 框架基线（`BASE_ENV_SCHEMA`）+ 本应用自己的字段。
 *
 * 单一真源就是这个文件：`.env.example` 由它生成（`pnpm taizan:env-example`），
 * `CoreModule.forRoot({ envSchema: APP_ENV_SCHEMA })` 由它校验，
 * `ConfigService<AppEnv>` 的类型也来自它。手写 `.env.example` 必然漏字段，所以不手写。
 *
 * @packageDocumentation
 */

import { BILLING_ENV_SHAPE } from '@taizan/nest-billing'
import { INFRA_ENV_SHAPE } from '@taizan/nest-infra'
import { BASE_ENV_SCHEMA, defineEnvSchema } from '@taizan/nest-core'
import { z } from 'zod'

/** 从 env 字符串解析布尔（与 nest-core 的 `envBoolean` 同语义，那个没导出）。 */
function envBoolean(defaultValue: boolean): z.ZodTypeAny {
  return z
    .preprocess((raw) => {
      if (raw === undefined || raw === '') return defaultValue
      if (typeof raw === 'boolean') return raw
      const s = String(raw).trim().toLowerCase()
      if (['1', 'true', 'yes', 'on'].includes(s)) return true
      if (['0', 'false', 'no', 'off'].includes(s)) return false
      // 拼错（`ture`）不静默当 false——那种 bug 只会在出事的时候才被发现。
      return raw
    }, z.boolean())
    .default(defaultValue)
}

/** 本应用在框架基线之上追加的 env 字段。 */
export const APP_ENV_SHAPE = {
  APP_NAME: z
    .string()
    .min(1)
    .default('taizan-saas')
    .describe('应用名，出现在 Swagger 标题与日志里'),

  TENANT_BASE_DOMAIN: z
    .string()
    .optional()
    .describe(
      'C 端子域名解析的根域，例如 example.com（`shop-a.example.com` → slug `shop-a`）。本地不配即可，SubdomainResolver 会退化成不适用',
    ),

  CLIENT_DEV_LOGIN: envBoolean(false).describe(
    '【危险·联调用】开启 POST /api/client/auth/login-dev：只给手机号就签发会员 token，不发短信不校验。生产环境置真会拒启',
  ),

  SIGNUP_ENABLED: envBoolean(true).describe(
    '官网自助注册总开关（POST /api/public/signup、GET /api/public/signup/check-slug）。' +
      '关掉之后接口仍在、仍限流，但一律回 1040000 —— 这是唯一「谁都能调且会往库里写」的入口，' +
      '必须有一个不改代码、不改路由就能立刻关掉它的开关',
  ),

  SIGNUP_TRIAL_DAYS: z.coerce
    .number()
    .int()
    .min(0)
    .max(3650)
    .default(14)
    .describe(
      '自助注册开出来的店试用几天（落到 Tenant.trialEndAt = 当天最后一刻）。' +
        '0 表示「注册即到期」——那是一个可用的运营选择（先注册后付费），不是错误值',
    ),

  SIGNUP_TRIAL_AUTO_PLAN: z
    .string()
    .optional()
    .describe(
      '试用到期未购买时自动挂上的免费套餐 code（`Plan.code`）。不配（默认）= 试用到期后' +
        '保持 TRIAL 状态不动，由 `evaluateTenantGate` 现算打烊，续费白名单仍可写；' +
        '配了 = `trial-convert` cron 通过 PlanOrderService 的统一 fulfill 路径把这些' +
        '租户 0 元「续」到这档套餐上（见 `plan-lifecycle/trial-convert.cron.ts` 文件头）',
    ),

  PAY_FAKE_ENABLED: envBoolean(false).describe(
    '【危险·联调用】给 PaymentModule 装 FakeProvider 并暴露 FakePaymentTestKit：' +
      '带真 HMAC 签名的「假回调」可以直接兑现真权益（套餐续期）。e2e 与本地联调用，生产环境置真会拒启',
  ),
} as const

/**
 * 完整的应用 env schema = 框架基线 + 计费片段 + 基础设施片段 + 本应用字段。
 *
 * ## 为什么要显式合 `BILLING_ENV_SHAPE` / `INFRA_ENV_SHAPE`
 *
 * 两个包各自导出「我读哪些环境变量」的 zod 片段，而不是去改 `BASE_ENV_SCHEMA`
 * （那是 `@taizan/nest-core` 的契约，包不该互改）。装配方（也就是这个文件）
 * 负责把用到的包的片段合进来——**合了才会被启动期校验、才会出现在 `.env.example` 里**。
 * 漏合的后果是：`CRON_ENABLED=ture` 这种拼写错误不再拒启，而是被
 * `readEnvBoolean` 在第一次用到时才抛，或者更糟——静默变成 false，定时任务全不跑。
 *
 * 顺序：`BILLING_ENV_SHAPE.BILLING_ENFORCE` 与 `BASE_ENV_SCHEMA` 里那份是**同形状副本**
 * （nest-billing 的 `env.ts` 里写了理由），后写覆盖先写，覆盖无害。
 * `APP_ENV_SHAPE` 放最后：本应用自己的字段有最终解释权。
 */
export const APP_ENV_SCHEMA = defineEnvSchema(BASE_ENV_SCHEMA, {
  ...BILLING_ENV_SHAPE,
  ...INFRA_ENV_SHAPE,
  ...APP_ENV_SHAPE,
})

/** 校验通过后的 env 类型。`ConfigService<AppEnv>` 用它拿字段提示。 */
export type AppEnv = z.infer<typeof APP_ENV_SCHEMA>

/**
 * 本应用自己的 dev 后门开关清单。
 *
 * 形状照抄 `@taizan/nest-core` 的 `FORBIDDEN_DEV_FLAGS`——那个常量是框架级的、
 * 只列框架自己认识的开关（短信验证码回传、微信假登录），业务项目新增的后门它管不到。
 * 与其去改框架包，不如在应用侧再挂一份同形状的清单 + 一次断言。
 */
export const APP_FORBIDDEN_DEV_FLAGS: ReadonlyArray<{ key: string; consequence: string }> = [
  {
    key: 'CLIENT_DEV_LOGIN',
    consequence: '只凭手机号就能拿到任意会员的 token → 任意人可冒充任意会员',
  },
  {
    key: 'PAY_FAKE_ENABLED',
    consequence:
      'FakeProvider 的签名 secret 是包里写死的常量 → 任何人都能构造一份验得过签的「已付款」回调，' +
      '白嫖任意租户的套餐续期（钱一分没收，权益照发）',
  },
]

/** {@link assertAppDevFlagsInProd} 检测到违规时抛出。 */
export class AppDevFlagInProductionError extends Error {
  override readonly name = 'AppDevFlagInProductionError'
  constructor(readonly violations: readonly string[]) {
    super(
      '安全保护：生产环境（NODE_ENV=production）禁止开启以下开关，请移除后再启动：' +
        violations.map((v) => `\n  - ${v}`).join(''),
    )
  }
}

function isTruthyFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string')
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
  return false
}

/**
 * 生产环境开着应用级后门就拒绝启动。
 *
 * 由 `main.ts` 在 `NestFactory.create` 之前显式调一次。框架的
 * `assertNoDevCodeInProd` 由 `CoreModule.forRoot()` 自动调，两者并列不合并。
 *
 * @param env - 已校验的 env（也接受裸 `process.env`）
 * @throws {@link AppDevFlagInProductionError}
 */
export function assertAppDevFlagsInProd(env: Record<string, unknown>): void {
  if (env.NODE_ENV !== 'production') return
  const violations = APP_FORBIDDEN_DEV_FLAGS.filter((flag) => isTruthyFlag(env[flag.key])).map(
    (flag) => `${flag.key}=${String(env[flag.key])}（${flag.consequence}）`,
  )
  if (violations.length > 0) throw new AppDevFlagInProductionError(violations)
}
