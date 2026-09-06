import { describe, expect, it } from 'vitest'

import {
  buildErrorCode,
  BUSINESS_DOMAIN_RANGE,
  defineErrorCodes,
  domainOf,
  ERROR_DOMAIN,
  ErrorCode,
  httpSemantic,
  seqOf,
  transportErrorCode,
} from './error-codes'

describe('httpSemantic', () => {
  it('1440301 → 403（验收点原文）', () => {
    expect(httpSemantic(1440301)).toBe(403)
  })

  it('1140100 → 401', () => {
    expect(httpSemantic(1140100)).toBe(401)
  })

  it('1240400 → 404', () => {
    expect(httpSemantic(1240400)).toBe(404)
  })

  it('9050000 → 500', () => {
    expect(httpSemantic(9050000)).toBe(500)
  })
})

describe('domainOf', () => {
  it('1440301 → 14', () => {
    expect(domainOf(1440301)).toBe(14)
  })

  it('1240300 → 12', () => {
    expect(domainOf(1240300)).toBe(12)
  })
})

describe('seqOf', () => {
  it('1440301 → 1', () => {
    expect(seqOf(1440301)).toBe(1)
  })

  it('1440302 → 2', () => {
    expect(seqOf(1440302)).toBe(2)
  })
})

describe('buildErrorCode', () => {
  it('按 domain/http/seq 拼出完整 7 位码', () => {
    expect(buildErrorCode(14, 403, 1)).toBe(1440301)
    expect(buildErrorCode(11, 401, 0)).toBe(1140100)
  })
})

describe('ErrorCode 内置表', () => {
  it('全部是合法 7 位错误码，且无重复', () => {
    const codes = Object.values(ErrorCode).map((def) => def.code)
    expect(codes.length).toBeGreaterThan(0)
    for (const code of codes) {
      expect(Number.isInteger(code)).toBe(true)
      expect(code).toBeGreaterThanOrEqual(1_000_000)
      expect(code).toBeLessThanOrEqual(9_999_999)
    }
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('每个码都带非空中文 message', () => {
    for (const def of Object.values(ErrorCode)) {
      expect(typeof def.message).toBe('string')
      expect(def.message.length).toBeGreaterThan(0)
    }
  })

  it('蓝图给出的示例码逐一匹配', () => {
    expect(ErrorCode.UNAUTHENTICATED.code).toBe(1140100)
    expect(ErrorCode.TOKEN_EXPIRED.code).toBe(1140101)
    expect(ErrorCode.TOKEN_KIND_MISMATCH.code).toBe(1140102)
    expect(ErrorCode.RBAC_FORBIDDEN.code).toBe(1340300)
    expect(ErrorCode.CROSS_TENANT_FORBIDDEN.code).toBe(1240300)
    expect(ErrorCode.TENANT_NOT_FOUND.code).toBe(1240400)
    expect(ErrorCode.PLAN_READONLY.code).toBe(1440301)
    expect(ErrorCode.SHOP_CLOSED.code).toBe(1440302)
    expect(ErrorCode.QUOTA_EXCEEDED.code).toBe(1540301)
    expect(ErrorCode.FEATURE_NOT_INCLUDED.code).toBe(1540302)
    expect(ErrorCode.INTERNAL_ERROR.code).toBe(9050000)
  })

  it('BAD_REQUEST/TOO_MANY_REQUESTS 的 httpSemantic 正确解码为 400/429', () => {
    // 这两个码的具体数值由本包按 DD-HHH-NN 公式生成，
    // 关键约束是 httpSemantic() 必须能正确解出 400/429，而不是某个具体数字。
    expect(httpSemantic(ErrorCode.BAD_REQUEST.code)).toBe(400)
    expect(httpSemantic(ErrorCode.TOO_MANY_REQUESTS.code)).toBe(429)
    expect(domainOf(ErrorCode.BAD_REQUEST.code)).toBe(ERROR_DOMAIN.COMMON)
  })

  it('全部内置码的域段都在 ERROR_DOMAIN 登记表内', () => {
    // 域段不在表里 = 前端拿到一个它不认识的段。`assembleErrorCodes` 在模块求值时就会拦，
    // 这条用例是防止有人为了塞一个码顺手往 ERROR_DOMAIN 里加一段却没同步蓝图 §4.9 与生成器。
    const registered = new Set<number>(Object.values(ERROR_DOMAIN))
    expect(registered.size).toBe(11)
    for (const [key, def] of Object.entries(ErrorCode)) {
      expect(registered.has(domainOf(def.code)), `${key}=${def.code} 的域段未登记`).toBe(true)
    }
  })

  it('每个内置码的 HTTP 语义段都是真实存在的状态码', () => {
    // 语义段决定前端行为。写成 `4003` 这种手滑值时，httpSemantic() 解出来是个没人处理的数，
    // 表现是「什么都不发生」——比报错难查得多。
    const allowed = new Set([400, 401, 403, 404, 409, 422, 429, 500, 502, 503])
    for (const [key, def] of Object.entries(ErrorCode)) {
      expect(allowed.has(httpSemantic(def.code)), `${key}=${def.code} 的语义段可疑`).toBe(true)
    }
  })

  it('收编：RBAC / 支付 / 三方集成 / 队列 / 平台运营各段都在内置表里', () => {
    // 这五段曾经散在 @taizan/nest-rbac、@taizan/payment-core、@taizan/wechat-open 里各写一遍。
    // 同一个码写在两个包，改一处就会漂，而漂了不报错——只会让前端按过时的表分流。
    const domains = new Set(Object.values(ErrorCode).map((def) => domainOf(def.code)))
    for (const d of [
      ERROR_DOMAIN.RBAC,
      ERROR_DOMAIN.PAYMENT,
      ERROR_DOMAIN.INTEGRATION,
      ERROR_DOMAIN.QUEUE,
      ERROR_DOMAIN.PLATFORM,
    ]) {
      expect(domains.has(d), `域段 ${d} 在内置表里一个码都没有`).toBe(true)
    }
  })

  it('收编后码值不变：三个包原先的码逐一对得上', () => {
    // 前端与 e2e 里已经写死了这些数值，收编只是搬家，不许漂。
    expect(ErrorCode.RBAC_DATA_SCOPE_MISCONFIGURED.code).toBe(1340301)
    expect(ErrorCode.PAYMENT_BAD_REQUEST.code).toBe(1640000)
    expect(ErrorCode.PAYMENT_SIGNATURE_INVALID.code).toBe(1640001)
    expect(ErrorCode.PAYMENT_ORDER_NOT_FOUND.code).toBe(1640400)
    expect(ErrorCode.PAYMENT_UPSTREAM_ERROR.code).toBe(1650000)
    expect(ErrorCode.WECHAT_TICKET_MISSING.code).toBe(1740000)
    expect(ErrorCode.WECHAT_MP_SOURCE_UNAVAILABLE.code).toBe(1740012)
    expect(ErrorCode.WECHAT_STATE_TENANT_MISMATCH.code).toBe(1740300)
    expect(ErrorCode.JOB_REPLAY_FAILED.code).toBe(1850000)
    expect(ErrorCode.ANNOUNCEMENT_NOT_FOUND.code).toBe(1940400)
  })

  it('1140301 不再存在：「无权限」全仓只有 1340300 一个码', () => {
    // 两个「无权限」并存时，contracts 里躺着 1140301、实际抛出的是 1340300，
    // 前端照着表写分流就会漏掉真正会收到的那个。
    expect('FORBIDDEN' in ErrorCode).toBe(false)
    const codes = Object.values(ErrorCode).map((def) => def.code)
    expect(codes).not.toContain(1140301)
    expect(codes.filter((c) => c === 1340300)).toHaveLength(1)
    // 11 段只留认证与会话（都是 401），不再有 403。
    const authCodes = codes.filter((c) => domainOf(c) === ERROR_DOMAIN.AUTH)
    expect(authCodes.length).toBeGreaterThan(0)
    for (const c of authCodes) expect(httpSemantic(c)).toBe(401)
  })

  it('对象已冻结，不可变更', () => {
    expect(Object.isFrozen(ErrorCode)).toBe(true)
    expect(Object.isFrozen(ErrorCode.RBAC_FORBIDDEN)).toBe(true)
  })
})

describe('transportErrorCode', () => {
  it('按规则现算：10 段 + 状态码 + 00', () => {
    expect(transportErrorCode(401)).toBe(1040100)
    expect(transportErrorCode(403)).toBe(1040300)
    expect(transportErrorCode(404)).toBe(1040400)
    expect(transportErrorCode(413)).toBe(1041300)
  })

  it('现算出来的码，httpSemantic() 解回原状态码（前端不需要特判）', () => {
    for (const status of [400, 401, 403, 404, 413, 415, 429, 500]) {
      expect(httpSemantic(transportErrorCode(status))).toBe(status)
      expect(domainOf(transportErrorCode(status))).toBe(ERROR_DOMAIN.COMMON)
    }
  })

  it('刻意不进内置表：401/403/404 兜底码在 ErrorCode 里查不到', () => {
    // 这三个是过滤器最常发出的兜底码，一旦有人把它们也登记进内置表，
    // 就会出现「同一个码两个真源」——正是这次整改要根治的病。
    const codes = new Set(Object.values(ErrorCode).map((def) => def.code))
    for (const status of [401, 403, 404]) {
      expect(codes.has(transportErrorCode(status))).toBe(false)
    }
  })

  it('400 / 429 与 BAD_REQUEST / TOO_MANY_REQUESTS 本来就是同一个码', () => {
    // 不是巧合也不是冲突：两者都是「10 段 + 状态码 + 00」，语义也完全一致
    // （参数错误、请求过于频繁）。刻意断言下来，免得日后有人以为撞码了去改其中一个。
    expect(transportErrorCode(400)).toBe(ErrorCode.BAD_REQUEST.code)
    expect(transportErrorCode(429)).toBe(ErrorCode.TOO_MANY_REQUESTS.code)
  })
})

describe('defineErrorCodes', () => {
  it('20–89 段内的合法定义可以正常注册', () => {
    const codes = defineErrorCodes({
      GOODS_SOLD_OUT: { code: 2040001, message: '商品已售罄' },
      GOODS_OFF_SHELF: { code: 2040002, message: '商品已下架' },
    })
    expect(codes.GOODS_SOLD_OUT.code).toBe(2040001)
    expect(Object.isFrozen(codes)).toBe(true)
  })

  it('拒绝域段不在 20–89 内的码', () => {
    expect(() =>
      defineErrorCodes({
        BAD: { code: buildErrorCode(10, 400, 0), message: '不该用通用域' },
      }),
    ).toThrow(/20–89/)

    expect(() =>
      defineErrorCodes({
        BAD: { code: buildErrorCode(90, 500, 0), message: '不该用系统域' },
      }),
    ).toThrow(/20–89/)
  })

  it('拒绝边界外的域段（19 与 90 都不合法，20 与 89 合法）', () => {
    expect(BUSINESS_DOMAIN_RANGE.min).toBe(20)
    expect(BUSINESS_DOMAIN_RANGE.max).toBe(89)
    expect(() =>
      defineErrorCodes({ X: { code: buildErrorCode(19, 400, 0), message: 'x' } }),
    ).toThrow()
    expect(() =>
      defineErrorCodes({ X: { code: buildErrorCode(90, 400, 0), message: 'x' } }),
    ).toThrow()
    expect(() =>
      defineErrorCodes({ X: { code: buildErrorCode(20, 400, 0), message: 'x' } }),
    ).not.toThrow()
    expect(() =>
      defineErrorCodes({ X: { code: buildErrorCode(89, 400, 0), message: 'x' } }),
    ).not.toThrow()
  })

  it('拒绝同一张表内重复的码值', () => {
    expect(() =>
      defineErrorCodes({
        A: { code: 2040001, message: '第一个' },
        B: { code: 2040001, message: '重复的' },
      }),
    ).toThrow(/重复注册/)
  })

  it('拒绝非法格式（非 7 位整数）', () => {
    expect(() => defineErrorCodes({ A: { code: 40001, message: '太短' } })).toThrow()
    expect(() => defineErrorCodes({ A: { code: 20400013, message: '太长' } })).toThrow()
    expect(() => defineErrorCodes({ A: { code: 2040001.5, message: '非整数' } })).toThrow()
  })

  it('拒绝空 message', () => {
    expect(() => defineErrorCodes({ A: { code: 2040001, message: '' } })).toThrow()
  })
})
