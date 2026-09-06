/**
 * 限流档位表：每个档位三个维度的阈值与窗口。
 *
 * ## 三个维度的取舍（这是本文件唯一需要记住的事）
 *
 * 摘 knowledge `CLAUDE.md` 第 6 条后半段：
 *
 * > 限流同时按「客户端 IP + 入口 IP + 账号」三个维度计数，且入口/账号维度必须设得宽松——
 * > 否则会变成攻击者锁死整片地区用户或指定账号的工具。
 *
 * - **`clientLimit`（客户端 IP）**：卡得紧。正常人输错三五次不会触到。
 * - **`edgeLimit`（入口 IP，不可伪造）**：必须**足够宽松**。同一个 CDN 边缘节点后面可能
 *   有一整个城市的正常用户，卡紧了就等于给攻击者一个「让某地区所有人都登不上」的开关。
 *   它的职责只有一个：给「轮换伪造 XFF 的爆破」封顶。
 * - **`accountLimit`（账号）**：防换 IP 爆破单个账号，也必须**故意设得高**。
 *   卡紧了就变成「知道谁的手机号，就能把谁锁在门外」的骚扰工具——
 *   而攻击者做这件事的成本是零。
 *
 * 这三条不是风格问题，是 {@link assertTierSane} 会在启动/CI 上强制的硬约束。
 *
 * ## 窗口与「算什么」
 *
 * 每档只有一个窗口，三个维度共用。`counts` 字段说明这一档算的是**请求次数**还是
 * **失败次数**——它决定触顶时该对用户说哪句话（见 {@link RateLimitTier.message}）：
 * 一个连查三十张证书、一次也没错的 HR 被告知「失败次数过多」，他会以为是自己输错了，
 * 然后再试几遍。
 *
 * @packageDocumentation
 */

/** 框架内置的档位名。业务项目可以用 {@link defineTier} 自己加。 */
export type RateLimitTierName = 'login' | 'sms-code' | 'signup' | 'lookup' | 'public-default'

/** 一个限流档位。 */
export interface RateLimitTier {
  /** 档位名，同时是限流 key 的第一段。 */
  name: string
  /** 窗口长度（秒）。三个维度共用同一个窗口。 */
  windowSec: number
  /** 同一客户端 IP 在窗口内的额度。 */
  clientLimit: number
  /** 同一入口 IP 在窗口内的额度。必须 > `clientLimit * 5`，见 {@link EDGE_RATIO_FLOOR}。 */
  edgeLimit: number
  /** 同一账号在窗口内的额度。不设 = 这条路上没有账号概念（例如未登录的查重接口）。 */
  accountLimit?: number
  /** 这一档算的是什么：每次请求都算，还是只算失败。 */
  counts: 'requests' | 'failures'
  /** 触顶时说的话，`{sec}` 会被换成还要等多少秒。不写就用 {@link DEFAULT_TIER_MESSAGE}。 */
  message?: string
  /**
   * 允许 `accountLimit` 低于 {@link ACCOUNT_LIMIT_FLOOR} 的**书面理由**。
   *
   * 不写理由就不许低——这跟蓝图 §8 spec 1「白名单必须写理由」是同一个套路：
   * 例外可以有，但必须是一次需要动手写字、能被 code review 看见的动作，
   * 而不是某人某天顺手把 20 改成 3。理由至少 10 个字，{@link assertTierSane} 会查。
   */
  accountFloorExemptReason?: string
  /** 给人看的：这一档拦的是什么。 */
  note: string
}

/** 默认触顶文案。 */
export const DEFAULT_TIER_MESSAGE = '请求太频繁了，请 {sec} 秒后再试'

/**
 * `edgeLimit` 至少要是 `clientLimit` 的多少倍。
 *
 * 5 是 knowledge 那份 spec 用的数（`toBeGreaterThan(cfg.limit * 5)`），照搬。
 * 它的含义是「同一个入口后面至少要容得下 5 个各自把额度用满的正常用户」——
 * 对一个 CDN 边缘节点来说这个数其实很保守，但作为**下限**够用了。
 */
export const EDGE_RATIO_FLOOR = 5

/**
 * `accountLimit` 的下限。
 *
 * 20 同样来自 knowledge 那份 spec。低于它就得写理由：一个能被陌生人在 10 分钟内
 * 打满的账号额度，等于把「临时封停任意账号」这个能力免费送给了任何人。
 */
export const ACCOUNT_LIMIT_FLOOR = 20

/**
 * 内置档位表。
 *
 * 数值来自 knowledge `rate-limit.config.ts` 的实际线上配置，按框架的四类入口重新归并：
 * 原来的 `platform` / `admin` / `memberPassword` / `bindPhone` 合并成 `login`（取最宽的那档，
 * 因为框架不知道下游会把哪个入口挂上来，宁可松一点也不要在别人的登录页上误伤），
 * `redeem` / `liveWatchPassword` / `certVerify` 这些业务档不进框架，由业务项目自己 {@link defineTier}。
 */
export const RATE_LIMIT_TIERS: Readonly<Record<RateLimitTierName, RateLimitTier>> = {
  /**
   * 各端登录、换店、改密。卡的是「同一个人反复试口令」。
   *
   * 只在**失败**时额外记账号维度（成功登录不该消耗额度，否则频繁切店的老板会被自己拦下）；
   * 客户端/入口两个维度由守卫按请求计，见 `decide` 的 `dimensions` 参数。
   */
  login: {
    name: 'login',
    windowSec: 5 * 60,
    clientLimit: 10,
    edgeLimit: 200,
    accountLimit: 50,
    counts: 'failures',
    message: '登录失败次数过多，请 {sec} 秒后再试',
    note: '登录 / 换店 / 改密。同一个人反复试口令',
  },

  /**
   * 发短信验证码。**这一档花的是真钱**，所以比登录还紧。
   *
   * 60 秒重发间隔是另一层（业务侧自己做），这里管的是「10 分钟内总共能发几条」。
   */
  'sms-code': {
    name: 'sms-code',
    windowSec: 10 * 60,
    clientLimit: 5,
    edgeLimit: 120,
    accountLimit: 20,
    counts: 'requests',
    message: '验证码发得太频繁了，请 {sec} 秒后再试',
    note: '短信验证码。每条都是真金白银，也是短信轰炸机的目标',
  },

  /**
   * 自助注册。**方向和登录相反**：登录卡「同一个人反复试」，这里卡「一个人建出一堆店」。
   *
   * 所以 `counts: 'requests'`——**成功也要计数**。只算失败的话，真正要拦的那种行为
   * （每次都成功地建出一家店）反而一次额度都不消耗。
   */
  signup: {
    name: 'signup',
    windowSec: 24 * 60 * 60,
    clientLimit: 3,
    edgeLimit: 60,
    accountLimit: 3,
    counts: 'requests',
    message: '今天注册的次数太多了，请 {sec} 秒后再试',
    accountFloorExemptReason:
      '这一档的「账号」是注册用的手机号，计的是「今天用这个号建了几家店」，不是「试了几次口令」。' +
      '把它放宽到 20 就等于允许一个手机号一天建 20 家店，而这正是这一档要拦的那件事。' +
      '被别人用手机号打满额度的代价也只是「今天开不了新店」，与「登不进自己的店」不是一个量级。',
    note: '自助注册。卡的是「一个人建出一堆店」，成功也计数',
  },

  /**
   * 查重 / 查验类只读接口（店铺 slug 查重、证书查验、手机号是否已注册……）。
   *
   * 这一档**不是防爆破，是防「把库里的名单抄走」**：这些接口刻意不要求登录，
   * 于是它们同时也是枚举器——编号常常是连号的，姓名可以拿常见姓名表扫。
   * 所以按「查了几次」算，成功也计数。
   */
  lookup: {
    name: 'lookup',
    windowSec: 10 * 60,
    clientLimit: 30,
    edgeLimit: 600,
    counts: 'requests',
    message: '查询太频繁了，请 {sec} 秒后再试',
    note: '免登录的查重 / 查验接口。拦的是批量枚举，不是爆破',
  },

  /**
   * 其它公开接口的兜底档。
   *
   * `@Public()` 必须同时 `@RateLimited(tier)`（蓝图 §8 spec 5），但「站点配置」
   * 「公告列表」这种读接口不值得各配一档，统一挂这个。
   */
  'public-default': {
    name: 'public-default',
    windowSec: 60,
    clientLimit: 60,
    edgeLimit: 1200,
    counts: 'requests',
    note: '公开只读接口的兜底档。防的是把公开接口当免费 CDN 刷',
  },
} as const

/** 内置档位名清单（`ip-source` / spec 5 之类的静态检查用它比对 `@RateLimited` 的实参）。 */
export const RATE_LIMIT_TIER_NAMES = Object.keys(RATE_LIMIT_TIERS) as RateLimitTierName[]

/** 档位配置不合规。**启动时抛**，不要等到线上第一个爆破者来了才发现。 */
export class RateLimitConfigError extends Error {
  override readonly name = 'RateLimitConfigError'
}

/**
 * 校验一个档位是否「理智」。
 *
 * 查五件事，每一件对应一种真实事故：
 *
 * 1. 窗口与额度必须是正整数——`limit: 0` 会把所有人挡在外面，`windowSec: 0` 会让计数永不过期；
 * 2. `edgeLimit > clientLimit * `{@link EDGE_RATIO_FLOOR}——入口维度卡紧 =
 *    「让某个地区所有人都登不上」的开关；
 * 3. `accountLimit >= clientLimit`——账号维度比客户端维度还紧的话，
 *    单个 IP 都还没被拦，账号先被锁了，那个账号的主人什么也没做；
 * 4. `accountLimit >= `{@link ACCOUNT_LIMIT_FLOOR}，除非写了 `accountFloorExemptReason`；
 * 5. 理由至少 10 个字（`// TODO` 和空串不算理由）。
 *
 * @throws {@link RateLimitConfigError} 任何一条不满足
 */
export function assertTierSane(tier: RateLimitTier): void {
  const where = `限流档位 ${tier.name}`

  for (const [field, value] of [
    ['windowSec', tier.windowSec],
    ['clientLimit', tier.clientLimit],
    ['edgeLimit', tier.edgeLimit],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RateLimitConfigError(`${where} 的 ${field} 必须是正整数，实际是 ${String(value)}`)
    }
  }

  if (tier.edgeLimit <= tier.clientLimit * EDGE_RATIO_FLOOR) {
    throw new RateLimitConfigError(
      `${where} 的 edgeLimit（${tier.edgeLimit}）必须大于 clientLimit（${tier.clientLimit}）的 ` +
        `${EDGE_RATIO_FLOOR} 倍。入口 IP 是不可伪造但粒度极粗的维度：同一个 CDN 节点后面可能是` +
        `一整个城市的正常用户，卡紧了等于给攻击者一个「让某地区所有人都登不上」的开关。` +
        `它的职责只是给爆破封顶，不是拦人。`,
    )
  }

  if (tier.accountLimit === undefined) return

  if (!Number.isInteger(tier.accountLimit) || tier.accountLimit <= 0) {
    throw new RateLimitConfigError(
      `${where} 的 accountLimit 必须是正整数，实际是 ${String(tier.accountLimit)}`,
    )
  }

  if (tier.accountLimit < tier.clientLimit) {
    throw new RateLimitConfigError(
      `${where} 的 accountLimit（${tier.accountLimit}）比 clientLimit（${tier.clientLimit}）还小。` +
        `那意味着攻击者自己的 IP 还没被拦，被攻击账号先被锁了——受害的是那个什么也没做的人。`,
    )
  }

  if (tier.accountLimit < ACCOUNT_LIMIT_FLOOR) {
    const reason = tier.accountFloorExemptReason?.trim() ?? ''
    if (reason.length < 10) {
      throw new RateLimitConfigError(
        `${where} 的 accountLimit（${tier.accountLimit}）低于下限 ${ACCOUNT_LIMIT_FLOOR}，` +
          `必须在 accountFloorExemptReason 里写明理由（至少 10 个字）。` +
          `一个能被陌生人在一个窗口内打满的账号额度，等于把「临时封停任意账号」免费送给任何人。`,
      )
    }
  }
}

/** 校验整张表。`AuthModule.forRoot` 启动时跑一次，spec 里也跑一次。 */
export function assertAllTiersSane(
  tiers: Readonly<Record<string, RateLimitTier>> = RATE_LIMIT_TIERS,
): void {
  for (const tier of Object.values(tiers)) {
    assertTierSane(tier)
  }
}

/**
 * 业务项目定义自己的档位。**定义即校验**——写歪了在 import 阶段就抛，
 * 不会活到「线上被爆破了才发现 edgeLimit 配成了 5」。
 */
export function defineTier(tier: RateLimitTier): RateLimitTier {
  assertTierSane(tier)
  return Object.freeze({ ...tier })
}

/** 按名字取内置档位；不认识返回 `undefined`（调用方决定是报错还是退回兜底档）。 */
export function findTier(name: string): RateLimitTier | undefined {
  return (RATE_LIMIT_TIERS as Record<string, RateLimitTier | undefined>)[name]
}

/** 这个名字是不是内置档位。静态扫描比对 `@RateLimited('x')` 用。 */
export function isKnownTier(name: string): name is RateLimitTierName {
  return findTier(name) !== undefined
}

/** 把 `{sec}` 换成真实秒数。 */
export function renderTierMessage(tier: RateLimitTier, retryAfterSec: number): string {
  return (tier.message ?? DEFAULT_TIER_MESSAGE).replace('{sec}', String(retryAfterSec))
}
