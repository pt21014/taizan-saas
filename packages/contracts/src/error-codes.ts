/**
 * 7 位错误码方案（蓝图 §4.9）：`DD HHH NN` = 域段 2 位 + HTTP 语义 3 位 + 序号 2 位。
 *
 * 前端判定规则只有一行：`httpSemantic(code)`，`401` → 清态跳登录，`403` → 只提示不登出。
 * 之所以不直接复用 HTTP 状态码，是因为业务错误统一走 `HTTP 200 + 业务码`（见 `response.ts`），
 * 需要一段独立编码把「这是谁的错、该怎么处理」下沉到码值本身，而不是让前端按字符串 message 判断。
 */

/**
 * 错误码域段常量表：7 位错误码的前 2 位。`20–89` 为业务项目自定义预留段，不在此表内。
 */
export const ERROR_DOMAIN = {
  /** 10：通用 / 参数 */
  COMMON: 10,
  /** 11：认证与会话 */
  AUTH: 11,
  /** 12：租户与隔离 */
  TENANT: 12,
  /** 13：RBAC（权限点/数据范围） */
  RBAC: 13,
  /** 14：计费与套餐（到期闸门、只读、打烊） */
  BILLING: 14,
  /** 15：配额与功能开关 */
  QUOTA: 15,
  /** 16：支付 */
  PAYMENT: 16,
  /** 17：三方集成（微信/短信/对象存储等） */
  INTEGRATION: 17,
  /** 18：队列与任务 */
  QUEUE: 18,
  /** 19：平台运营 */
  PLATFORM: 19,
  /** 90：系统内部 */
  SYSTEM: 90,
} as const

/** {@link ERROR_DOMAIN} 中任一域段的取值类型。 */
export type ErrorDomain = (typeof ERROR_DOMAIN)[keyof typeof ERROR_DOMAIN]

/** 业务项目可自定义错误码的合法域段区间（含边界）。 */
export const BUSINESS_DOMAIN_RANGE = { min: 20, max: 89 } as const

/**
 * 从 7 位错误码中取出 HTTP 语义（中间 3 位），例如 `1440301` → `403`。
 *
 * 这是前端判定分流的唯一依据：`401` 清态跳登录，`403` 只提示不登出，
 * `404`/`429`/`500` 各自兜底处理。
 */
export function httpSemantic(code: number): number {
  return Math.floor((code % 100000) / 100)
}

/** 从 7 位错误码中取出域段（前 2 位），例如 `1440301` → `14`。 */
export function domainOf(code: number): number {
  return Math.floor(code / 100000)
}

/** 从 7 位错误码中取出序号（末 2 位），例如 `1440301` → `1`。 */
export function seqOf(code: number): number {
  return code % 100
}

/**
 * 传输层兜底码：**按规则现算，不进 {@link ErrorCode} 内置表**。
 *
 * 域段 `10`（通用）+ HTTP 状态码 + 序号 `00`，例：`401` → `1040100`、`404` → `1040400`。
 *
 * 为什么是规则而不是枚举：这条路径覆盖的是「没有被任何业务码接管」的 HttpException
 * （守卫直接抛 `UnauthorizedException`、路由不存在、body-parser 报 413 ……），状态码有几十个，
 * 逐个登记成常量只会得到一张永远不全的表。业务侧要区分「未登录」与「token 过期」时，
 * 应该主动抛 {@link ErrorCode.UNAUTHENTICATED} / {@link ErrorCode.TOKEN_EXPIRED}，
 * 而不是指望过滤器从状态码里猜。
 *
 * 前端不需要为它做任何特殊处理：`httpSemantic()` 解出来就是原状态码，与业务码同一条分流。
 */
export function transportErrorCode(status: number): number {
  return buildErrorCode(ERROR_DOMAIN.COMMON, status, 0)
}

/**
 * 按 域段 / HTTP 语义 / 序号 三段拼出完整 7 位错误码。
 *
 * @param domain - 域段（2 位，见 {@link ERROR_DOMAIN} 或业务自定义 20–89）
 * @param http - HTTP 语义（3 位，如 400/401/403/404/429/500）
 * @param seq - 序号（0–99）
 */
export function buildErrorCode(domain: number, http: number, seq: number): number {
  return domain * 100_000 + http * 100 + seq
}

function assertValidCodeShape(code: number, label: string): void {
  if (!Number.isInteger(code) || code < 1_000_000 || code > 9_999_999) {
    throw new Error(`[@taizan/contracts] 错误码 ${label}=${code} 不是合法的 7 位错误码`)
  }
}

/** 一个错误码定义：完整 7 位码 + 默认中文提示。 */
export interface ErrorCodeDef {
  /** 完整 7 位错误码 */
  code: number
  /** 默认中文提示；`response.ts` 的 `fail()` 通常直接取用这个文案 */
  message: string
}

/**
 * 装配一张错误码表：校验格式（7 位）、域段（由调用方传入的 `validateDomain` 决定规则）、
 * 码值不重复、`message` 非空，全部通过后返回冻结对象。
 *
 * 内部工具，供 {@link ErrorCode}（框架内置表，允许多个框架域段）与
 * {@link defineErrorCodes}（业务表，只允许 20–89 段）共用同一套校验逻辑。
 */
function assembleErrorCodes<const T extends Record<string, ErrorCodeDef>>(
  defs: T,
  validateDomain: (domain: number, key: string, code: number) => void,
): Readonly<T> {
  const seenCodes = new Map<number, string>()
  for (const [key, def] of Object.entries(defs)) {
    assertValidCodeShape(def.code, key)
    validateDomain(domainOf(def.code), key, def.code)
    const dupKey = seenCodes.get(def.code)
    if (dupKey !== undefined) {
      throw new Error(`[@taizan/contracts] 错误码 ${def.code} 重复注册："${dupKey}" 与 "${key}"`)
    }
    seenCodes.set(def.code, key)
    if (typeof def.message !== 'string' || def.message.length === 0) {
      throw new Error(`[@taizan/contracts] 错误码 ${key}=${def.code} 缺少 message`)
    }
  }
  const frozenEntries = Object.entries(defs).map(([k, v]) => [k, Object.freeze({ ...v })] as const)
  return Object.freeze(Object.fromEntries(frozenEntries)) as Readonly<T>
}

/**
 * 业务项目注册自己的错误码表（`20–89` 段）。
 *
 * 校验规则：
 * - 每个码必须是合法的 7 位错误码；
 * - 域段（前 2 位）必须落在 `20–89` 区间，否则会与框架保留段冲突；
 * - 同一张表内码值不允许重复。
 *
 * @example
 * ```ts
 * export const BizErrorCode = defineErrorCodes({
 *   GOODS_SOLD_OUT: { code: 2040001, message: '商品已售罄' },
 * })
 * ```
 */
export function defineErrorCodes<const T extends Record<string, ErrorCodeDef>>(
  defs: T,
): Readonly<T> {
  return assembleErrorCodes(defs, (domain, key, code) => {
    if (domain < BUSINESS_DOMAIN_RANGE.min || domain > BUSINESS_DOMAIN_RANGE.max) {
      throw new Error(
        `[@taizan/contracts] 错误码 ${key}=${code} 的域段 ${domain} 不在业务预留段 20–89 内`,
      )
    }
  })
}

const FRAMEWORK_DOMAIN_VALUES = new Set<number>(Object.values(ERROR_DOMAIN))

/**
 * 框架内置错误码表：**全仓框架码的唯一真源**。
 *
 * 覆盖通用、认证、隔离、RBAC、计费、配额、支付、三方集成、队列、平台运营、系统各段。
 * `@taizan/nest-rbac`、`@taizan/payment-core`、`@taizan/wechat-open` 里的
 * `RBAC_ERRORS` / `PAYMENT_ERROR` / `WechatOpenErrorCode` 都只是本表条目的别名，
 * 不再各自 `buildErrorCode()` 一遍——同一个码写在两个包里，改一处就会漂，
 * 而漂了不会报错，只会让前端按一张过时的表做分流。
 *
 * 唯一不在表内的是传输层兜底码：它按 {@link transportErrorCode} 的规则现算（`10` 段 + 状态码 + `00`）。
 *
 * 这几个码刻意分开、不合并成一个笼统的「无权限」——`1440301`（套餐到期只读）与
 * `1540301`（配额超限）触发的前端动作完全不同（前者弹「去续费」，后者弹「升级套餐」），
 * 合成一个码商家只会来问客服。
 */
export const ErrorCode = assembleErrorCodes(
  {
    /** 参数错误 */
    BAD_REQUEST: { code: buildErrorCode(ERROR_DOMAIN.COMMON, 400, 0), message: '参数错误' },
    /** 请求过于频繁（限流命中） */
    TOO_MANY_REQUESTS: {
      code: buildErrorCode(ERROR_DOMAIN.COMMON, 429, 0),
      message: '请求过于频繁，请稍后再试',
    },
    /** 未登录 */
    UNAUTHENTICATED: {
      code: buildErrorCode(ERROR_DOMAIN.AUTH, 401, 0),
      message: '未登录',
    },
    /** token 已过期 */
    TOKEN_EXPIRED: {
      code: buildErrorCode(ERROR_DOMAIN.AUTH, 401, 1),
      message: '登录已过期，请重新登录',
    },
    /** token 类型（kind）与接口要求不符，例如拿 member token 打 admin 接口 */
    TOKEN_KIND_MISMATCH: {
      code: buildErrorCode(ERROR_DOMAIN.AUTH, 401, 2),
      message: '凭证类型不符',
    },
    /** 跨租户越权：token 所属租户与请求目标资源租户不一致 */
    CROSS_TENANT_FORBIDDEN: {
      code: buildErrorCode(ERROR_DOMAIN.TENANT, 403, 0),
      message: '无权访问该租户资源',
    },
    /** 租户不存在 */
    TENANT_NOT_FOUND: {
      code: buildErrorCode(ERROR_DOMAIN.TENANT, 404, 0),
      message: '租户不存在',
    },
    /**
     * 无权限：RBAC 权限点判定不通过（`@taizan/nest-rbac` 的 `PermissionsGuard`）。
     *
     * **只有这一个「无权限」**。曾经在 11 段（认证）也有一条 `1140301`，两个码同时存在的后果是
     * 前端表里躺着两个「无权限」、而实际只会收到 13 段这个——11 段那条已删除。
     * 域段选 13 不选 11 是因为「谁的错」不同：11 段让前端以为是登录态问题（可能触发
     * 静默刷新 token 后重试），13 段才是「你登录得好好的，只是这个按钮不该你点」。
     */
    RBAC_FORBIDDEN: {
      code: buildErrorCode(ERROR_DOMAIN.RBAC, 403, 0),
      message: '无权限',
    },
    /**
     * 数据范围配置错误：`@DataScope({ ownerField })` 写错字段名、`SUB_TREE` 忘了给 `groupField` 之类。
     *
     * 失败关闭：宁可 403 也不能退化成「不加条件」——后者会把全租户的数据发出去。
     */
    RBAC_DATA_SCOPE_MISCONFIGURED: {
      code: buildErrorCode(ERROR_DOMAIN.RBAC, 403, 1),
      message: '数据范围配置错误',
    },
    /** 套餐到期，商家后台转只读（续费白名单路径永远可写） */
    PLAN_READONLY: {
      code: buildErrorCode(ERROR_DOMAIN.BILLING, 403, 1),
      message: '套餐已到期，后台暂只读，请续费',
    },
    /** 套餐到期，C 端打烊 */
    SHOP_CLOSED: {
      code: buildErrorCode(ERROR_DOMAIN.BILLING, 403, 2),
      message: '店铺已打烊',
    },
    /** 配额超限（`limit=0` 或 `used+delta>limit`） */
    QUOTA_EXCEEDED: {
      code: buildErrorCode(ERROR_DOMAIN.QUOTA, 403, 1),
      message: '已达到套餐配额上限',
    },
    /** 当前套餐 features 不含该功能项 */
    FEATURE_NOT_INCLUDED: {
      code: buildErrorCode(ERROR_DOMAIN.QUOTA, 403, 2),
      message: '当前套餐不包含该功能',
    },
    // ── 16 支付（真源在此；`@taizan/payment-core` 的 `PAYMENT_ERROR` 只是本表的别名）──
    // HTTP 语义段的选取原则是「谁的错」：伪造回调是调用方的错（400），
    // 上游微信/支付宝挂了是系统的错（500），订单查无此单是 404。
    /** 通用支付参数错误（金额非法、outTradeNo 不合规等） */
    PAYMENT_BAD_REQUEST: {
      code: buildErrorCode(ERROR_DOMAIN.PAYMENT, 400, 0),
      message: '支付参数错误',
    },
    /** 回调验签失败（含序列号对不上、签名被伪造）。**绝不能落库** */
    PAYMENT_SIGNATURE_INVALID: {
      code: buildErrorCode(ERROR_DOMAIN.PAYMENT, 400, 1),
      message: '支付回调验签失败',
    },
    /** 验签过了但报文解不开/字段缺失（解密失败、JSON 坏、algorithm 不支持） */
    PAYMENT_CALLBACK_PARSE_FAILED: {
      code: buildErrorCode(ERROR_DOMAIN.PAYMENT, 400, 2),
      message: '支付回调解析失败',
    },
    /** outTradeNo 前缀没有注册领域处理器 */
    PAYMENT_ROUTE_NOT_FOUND: {
      code: buildErrorCode(ERROR_DOMAIN.PAYMENT, 400, 3),
      message: '支付单号前缀未注册领域处理器',
    },
    /** 该渠道没有装配对应的 Provider */
    PAYMENT_PROVIDER_NOT_FOUND: {
      code: buildErrorCode(ERROR_DOMAIN.PAYMENT, 400, 4),
      message: '支付渠道未配置',
    },
    /** Provider 配置缺字段/形状不对（narrow 失败） */
    PAYMENT_CONFIG_INVALID: {
      code: buildErrorCode(ERROR_DOMAIN.PAYMENT, 400, 5),
      message: '支付渠道配置不完整',
    },
    /** 查无此单 */
    PAYMENT_ORDER_NOT_FOUND: {
      code: buildErrorCode(ERROR_DOMAIN.PAYMENT, 404, 0),
      message: '支付订单不存在',
    },
    /** 上游支付网关报错/超时 */
    PAYMENT_UPSTREAM_ERROR: {
      code: buildErrorCode(ERROR_DOMAIN.PAYMENT, 500, 0),
      message: '支付网关调用失败',
    },

    // ── 17 三方集成（微信开放平台；`@taizan/wechat-open` 的 `WechatOpenErrorCode` 是本表的别名）──
    // 刻意分得细：这些错误的**处理人不同**。「ticket 还没收到」要平台去开放平台后台改回调 URL；
    // 「state 无效」是让用户重来一次；「redirect_uri 不安全」是我们自己的代码写错了。
    /** 尚未收到微信推送的 component_verify_ticket */
    WECHAT_TICKET_MISSING: {
      code: buildErrorCode(ERROR_DOMAIN.INTEGRATION, 400, 0),
      message: '尚未收到微信推送的 component_verify_ticket',
    },
    /** 微信开放平台接口返回了 errcode */
    WECHAT_API_FAILED: {
      code: buildErrorCode(ERROR_DOMAIN.INTEGRATION, 400, 1),
      message: '微信开放平台调用失败',
    },
    /** access_token 失效（40001 / 42001），可自愈重试 */
    WECHAT_TOKEN_INVALID: {
      code: buildErrorCode(ERROR_DOMAIN.INTEGRATION, 400, 2),
      message: '微信 access_token 已失效',
    },
    /** 授权码校验失败 */
    WECHAT_AUTH_CODE_INVALID: {
      code: buildErrorCode(ERROR_DOMAIN.INTEGRATION, 400, 3),
      message: '授权码校验失败，请重新发起授权',
    },
    /** EncodingAESKey 配错 / 密文不合法 */
    WECHAT_MSG_DECRYPT_FAILED: {
      code: buildErrorCode(ERROR_DOMAIN.INTEGRATION, 400, 4),
      message: '微信消息解密失败',
    },
    /** 密文里的 receiveId 与本平台不符 */
    WECHAT_RECEIVE_ID_MISMATCH: {
      code: buildErrorCode(ERROR_DOMAIN.INTEGRATION, 400, 5),
      message: '消息不属于本平台，已拒绝处理',
    },
    /** 消息签名校验不通过 */
    WECHAT_MSG_SIGNATURE_INVALID: {
      code: buildErrorCode(ERROR_DOMAIN.INTEGRATION, 400, 6),
      message: '微信消息签名校验失败',
    },
    /** 调用方给的回跳路径不安全（带 scheme / host / 协议相对） */
    WECHAT_UNSAFE_REDIRECT: {
      code: buildErrorCode(ERROR_DOMAIN.INTEGRATION, 400, 7),
      message: '回跳地址不合法',
    },
    /** 当前请求的 Host 形状不合法，拒绝用它拼 redirect_uri */
    WECHAT_UNSAFE_HOST: {
      code: buildErrorCode(ERROR_DOMAIN.INTEGRATION, 400, 8),
      message: '请求 Host 不合法',
    },
    /** state 不存在 / 已被用过 / 已过期 */
    WECHAT_STATE_INVALID: {
      code: buildErrorCode(ERROR_DOMAIN.INTEGRATION, 400, 9),
      message: '登录校验失败，请重新发起授权',
    },
    /** 中转站调用失败 */
    WECHAT_RELAY_FAILED: {
      code: buildErrorCode(ERROR_DOMAIN.INTEGRATION, 400, 10),
      message: '中转站登录失败，请稍后重试',
    },
    /** 中转站会话不存在（sid 过期或已交付过 token） */
    WECHAT_RELAY_SESSION_GONE: {
      code: buildErrorCode(ERROR_DOMAIN.INTEGRATION, 400, 11),
      message: '二维码已过期，请刷新重试',
    },
    /** 一条公众号来源都不可用 */
    WECHAT_MP_SOURCE_UNAVAILABLE: {
      code: buildErrorCode(ERROR_DOMAIN.INTEGRATION, 400, 12),
      message: '尚未配置微信公众号，无法完成微信登录',
    },
    /** state 绑定的租户与当前租户不一致（拿 A 店的 state 去 B 店换登录） */
    WECHAT_STATE_TENANT_MISMATCH: {
      code: buildErrorCode(ERROR_DOMAIN.INTEGRATION, 403, 0),
      message: '登录校验失败，请重新发起授权',
    },

    // ── 18 队列与任务 ──
    /**
     * 死信重放失败（`@taizan/nest-infra` 的 `DeadLetterService.replay`）。
     *
     * 500 而不是 404：平台后台点「重放」时死信 id 是从列表里带过来的，走到这一步还找不到、
     * 或者 payload 不是合法信封，都说明是我们这边的数据出了问题，不是操作者点错了。
     */
    JOB_REPLAY_FAILED: {
      code: buildErrorCode(ERROR_DOMAIN.QUEUE, 500, 0),
      message: '任务重放失败',
    },

    // ── 19 平台运营 ──
    /** 平台公告不存在（已下架或 id 写错） */
    ANNOUNCEMENT_NOT_FOUND: {
      code: buildErrorCode(ERROR_DOMAIN.PLATFORM, 404, 0),
      message: '公告不存在',
    },

    /** 系统内部错误 */
    INTERNAL_ERROR: {
      code: buildErrorCode(ERROR_DOMAIN.SYSTEM, 500, 0),
      message: '系统内部错误',
    },
  } as const,
  (domain, key, code) => {
    if (!FRAMEWORK_DOMAIN_VALUES.has(domain)) {
      throw new Error(`[@taizan/contracts] 内置错误码 ${key}=${code} 使用了未登记的域段 ${domain}`)
    }
  },
)

/** {@link ErrorCode} 的键名类型，便于业务代码里做穷举。 */
export type ErrorCodeName = keyof typeof ErrorCode
