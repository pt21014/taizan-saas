/**
 * 生产环境后门开关硬检查（蓝图 §4.10）。
 *
 * 这几个开关任何一个在生产为真，都等价于「任意人可以登录任意账号」：
 * - `SMS_RETURN_DEV_CODE`：接口把短信验证码回传给调用方 → 拿任意手机号就能登录；
 * - `WECHAT_DEV_FAKE_LOGIN`：跳过 jscode2session 直接签发会员 token → 任意人可登录该租户。
 *
 * 所以不是打个 warn 了事，而是**直接拒绝启动**。少数需要在类生产环境联调的场景，
 * 请把 `NODE_ENV` 设成 `staging` 之外的值，或者临时关掉开关——不给「加个白名单绕过去」的口子。
 */

/** 生产环境禁止开启的 dev 后门开关，以及打开后的实际后果（写进报错文本给运维看）。 */
export const FORBIDDEN_DEV_FLAGS: ReadonlyArray<{ key: string; consequence: string }> = [
  {
    key: 'SMS_RETURN_DEV_CODE',
    consequence: '把短信验证码回传给调用方 → 任意手机号免验证登录',
  },
  {
    key: 'WECHAT_DEV_FAKE_LOGIN',
    consequence: '跳过微信 jscode2session 直接签发会员 token → 任意人可登录该租户',
  },
]

/** 判定一个 env 值是否「为真」。字符串 `'1'/'true'/'yes'/'on'` 与布尔 `true` 都算。 */
function isTruthyFlag(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return value !== 0
  }
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
  }
  return false
}

/** {@link assertNoDevCodeInProd} 检测到违规时抛出。 */
export class DevCodeInProductionError extends Error {
  override readonly name = 'DevCodeInProductionError'
  constructor(readonly violations: readonly string[]) {
    super(
      '安全保护：生产环境（NODE_ENV=production）禁止开启以下开关，请移除后再启动：' +
        violations.map((v) => `\n  - ${v}`).join(''),
    )
  }
}

/**
 * `NODE_ENV=production` 且任一 dev 后门开关为真时抛 {@link DevCodeInProductionError}。
 *
 * 由 `CoreModule.forRoot()` 在装配阶段自动调用；`main.ts` 里也可以再显式调一次，
 * 这条检查便宜到多跑几遍也无所谓，而漏跑一次的代价是全站账号可被任意登录。
 *
 * @param env - 已校验的 env 对象（也接受裸 `process.env`）
 */
export function assertNoDevCodeInProd(env: Record<string, unknown>): void {
  if (env.NODE_ENV !== 'production') {
    return
  }
  const violations = FORBIDDEN_DEV_FLAGS.filter((flag) => isTruthyFlag(env[flag.key])).map(
    (flag) => `${flag.key}=${String(env[flag.key])}（${flag.consequence}）`,
  )
  if (violations.length > 0) {
    throw new DevCodeInProductionError(violations)
  }
}

/**
 * `BILLING_ENFORCE` 在生产为假时返回一条中文告警文本，否则返回 `null`。
 *
 * 蓝图 §4.10 把 `BILLING_ENFORCE` 误配也列进了这一节，但它和上面两个开关性质不同：
 * 开着后门是**安全漏洞**（必须拒启），不开计费闸门是**收不到钱**（不该拦住启动——
 * 上线初期本来就要先跑一段不收费的）。所以这里只产出告警，由 `CoreModule` 打 warn 日志，
 * 不抛错。真要强制，业务项目可以自己在 `main.ts` 里把它升级成 throw。
 */
export function warnIfBillingNotEnforcedInProd(env: Record<string, unknown>): string | null {
  if (env.NODE_ENV !== 'production' || isTruthyFlag(env.BILLING_ENFORCE)) {
    return null
  }
  return 'BILLING_ENFORCE=false：生产环境未开启计费闸门，到期租户依然可写（只记 reason 不拦截）。确认这是有意为之'
}
