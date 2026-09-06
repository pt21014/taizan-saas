/**
 * 租户开通的类型契约：事务鸭子类型、入参、产出、错误。
 *
 * ## 为什么 `ProvisionTx` 是鸭子类型而不是 `Prisma.TransactionClient`
 *
 * 本包**不 import `@prisma/client`**。三个理由，按重要性排：
 *
 * 1. 生成器产出的空项目、CI 的裸 node 环境里都能跑本包的单测——不需要先 `prisma generate`；
 * 2. `Prisma.TransactionClient` 上有几百个方法，用它做参数类型等于宣布「本函数可能动任何表」，
 *    而 `provisionTenant` 到底写了哪几张表，看一眼这个接口就完了；
 * 3. 测试里能塞一个内存 fake，**把调用序列逐条录下来**——「失败时不会部分创建」和
 *    「平台开通与自助注册写的东西一模一样」这两条断言只能这么写。
 *
 * 代价是字段名对不上时 TypeScript 帮不了忙（`data` 是 `Record<string, unknown>`）。
 * 这由 `provision.spec.ts` 里的 payload 断言兜底：字段名写错，断言先炸。
 *
 * ## `quotaCounter.createMany` 为什么是泛型
 *
 * `QuotaCounter.kind` 在 Prisma schema 里是一个枚举（`QuotaKind`），生成出来的
 * `QuotaCounterCreateManyInput.kind` 因此是一个字符串字面量联合类型，不是 `string`。
 * Prisma 的 `createMany` 本身又是**泛型方法**——泛型方法之间的赋值检查是严格的
 * 逆变检查，不走「方法双变」那条宽松路径，所以只要 `kind` 声明成 `string`
 * （哪怕外面包一层 `Record<string, unknown>`），真实 delegate 就赋不进来，
 * 调用方只能 `as unknown as ProvisionTx` 绕过去。
 *
 * 把 `ProvisionTx` 按 `kind` 的字面量类型开一个类型参数（默认 `string`，
 * 本包自己和测试假客户端都不需要管它），调用方把 `provisionTenant<Prisma.QuotaKind>(tx, …)`
 * 或者干脆让 TypeScript 从 `tx` 的真实类型推导出这个参数，真实 Prisma 客户端就能
 * **不加任何断言**地传进来——这不是绕过类型检查，是让类型检查算对。
 *
 * @packageDocumentation
 */

/** 建租户的来源。**只进审计与日志，不进任何写库 payload**（见 {@link ProvisionInput.source}）。 */
export type ProvisionSource = 'PLATFORM' | 'SIGNUP' | 'IMPORT'

/** 租户状态。与 `prisma-base` 的 `TenantStatus` 对齐，刻意没有 `EXPIRED`（到期现算）。 */
export type TenantStatusLike = 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'DEREGISTERED'

/** 角色模板归属侧。与 `prisma-base` 的 `MenuSide` 对齐。 */
export type RoleSide = 'ADMIN' | 'PLATFORM'

/**
 * 角色模板。
 *
 * 结构上兼容 `@taizan/rbac-core` 的 `RolePreset`（`defineRolePreset()` 的产物）
 * 与 `@taizan/prisma-base` 的 `RolePresetSeedSpec`，两边都能直接传进 {@link ProvisionDeps.rolePresets}。
 * 这里重新声明一遍而不是 import，是为了本包一个依赖都不加（见文件头）。
 */
export interface RolePresetSpec {
  readonly code: string
  readonly name: string
  readonly side: RoleSide
  /** 权限点 code；`['*']` = 全量（只给店主用）。 */
  readonly permissionCodes: readonly string[]
}

/** 建租户过程中只读的那几列 `StaffAccount`。 */
export interface StaffAccountRow {
  id: string
  phone: string
  passwordHash: string
  name: string
  /** `ACTIVE` / `DISABLED`。 */
  status: string
}

/** 从 `RolePreset` 表里读出来的一行。`permissionCodes` 是 Json 列，所以是 `unknown`。 */
export interface RolePresetRow {
  code: string
  name: string
  side: string
  permissionCodes: unknown
  builtin?: boolean
}

/** 建出来的租户行（只声明本包读得到的字段）。 */
export interface TenantRow {
  id: string
  slug: string
}

/**
 * `quotaCounter.createMany` 一行的形状。
 *
 * `TKind` 由 {@link ProvisionTx} 的类型参数带进来，默认 `string`——本包内部与
 * 测试用的内存假客户端都用默认值；接了真 Prisma 的调用方把它实例化成
 * 生成出来的 `Prisma.QuotaKind`（或者干脆不写，让 TypeScript 从 `tx` 推出来），
 * `kind` 字段就能收窄成真实的枚举字面量类型，真实 delegate 才赋得进来。
 */
export interface QuotaCounterCreateInput<TKind extends string = string> {
  id: string
  tenantId: string
  kind: TKind
  used: number
  version: number
}

/**
 * 事务客户端：**只声明 `provisionTenant` 真正用到的那几个方法**。
 *
 * 传进来的一般是 `prisma.raw.$transaction(async (tx) => …)` 里的 `tx`——
 * Prisma 生成的 delegate 结构上满足这个接口，直接传即可，不需要断言。
 *
 * @typeParam TQuotaKind - `quotaCounter.createMany` 那一行 `kind` 字段的类型，
 *   见 {@link QuotaCounterCreateInput}。默认 `string`；接真 Prisma 时可以显式传
 *   `ProvisionTx<Prisma.QuotaKind>`，也可以不写——`provisionTenant()` 是泛型函数，
 *   会从传进来的 `tx` 自动推导。
 */
export interface ProvisionTx<TQuotaKind extends string = string> {
  tenant: {
    findUnique(args: { where: { slug: string } }): Promise<{ id: string } | null>
    create(args: { data: Record<string, unknown> }): Promise<TenantRow>
  }
  staffAccount: {
    findUnique(args: { where: { phone: string } }): Promise<StaffAccountRow | null>
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>
  }
  role: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string; code: string }>
  }
  staff: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>
  }
  rolePreset: {
    findMany(args: {
      where: { side: RoleSide; builtin: boolean }
      orderBy: { code: 'asc' }
    }): Promise<RolePresetRow[]>
  }
  /**
   * 可选：给了就在同一个事务里把配额计数器初始化出来。
   *
   * 不给也不会漏——`@taizan/nest-billing` 在第一次消耗时会 `findFirst` 不到再 `create`。
   * 初始化只是让商家开店第一天后台的配额条就有数，而不是一片空白。
   */
  quotaCounter?: {
    createMany(args: {
      data: Array<QuotaCounterCreateInput<TQuotaKind>>
      skipDuplicates?: boolean
    }): Promise<unknown>
  }
}

/** {@link provisionTenant} 的入参。 */
export interface ProvisionInput {
  /** 店铺路径，全局唯一且不可改。会被 `trim().toLowerCase()` 后校验，见 `rules.ts`。 */
  slug: string
  /** 商家主体名 / 店名。 */
  name: string
  /** 店主手机号。会被 {@link normalizePhone} 归一化（去掉空格、连字符、`+86`）。 */
  ownerPhone: string
  /**
   * 店主口令明文。
   *
   * - 手机号**没有**账号：必填，按 {@link assertOwnerPasswordPolicy} 校验后哈希入库；
   * - 手机号**已有**账号（一号多店）：也必填，且必须是**他现有的口令**——校验通过才让开新店，
   *   **永不覆盖**已有口令。少了这一步，任何人填上别人的手机号就能在别人账号下开店。
   */
  ownerPassword?: string
  /** 店主显示名；不给时回落到 {@link ProvisionInput.name}。已有账号时**不改**它的名字。 */
  ownerName?: string
  /** 套餐 id。给了且没给 `trialDays` = 按套餐付费开通（`ACTIVE`），见 {@link decideInitialStatus}。 */
  planId?: string
  /** 试用天数（非负整数）。显式给了就一定是 `TRIAL`；不给且没有 `planId` 时用 {@link DEFAULT_TRIAL_DAYS}。 */
  trialDays?: number
  /**
   * 套餐到期日。**`ACTIVE` 时必填**：`ACTIVE` 且没有任何到期日的租户在
   * `evaluateTenantGate` 里算出来是 `PENDING`（未开通），开出来就是打烊的。
   * `TRIAL` 时忽略（用试用到期日）。
   */
  planExpireAt?: Date
  /**
   * 来源。**它不参与任何写库 payload**——三条入口写进库里的东西必须逐字节相同，
   * 这是「建租户只有一条路」的可执行定义（`provision.spec.ts` 逐调用比对 PLATFORM 与 SIGNUP）。
   * 它只用来：`PLATFORM` 要求 `operatorId`、以及调用方写审计时的 action 归类
   * （见 {@link buildProvisionAudit}）。
   */
  source: ProvisionSource
  /** 操作者 id（`PlatformAdmin.id`）。`source === 'PLATFORM'` 时必填：谁开的店必须留痕。 */
  operatorId?: string
  /** 算「当天最后一刻」用的时区，默认跟 `@taizan/billing-rules` 走（`Asia/Shanghai`）。 */
  timezone?: string
  /**
   * 平台后台**显式**绑定一个已有账号，跳过「一号多店必须验原口令」这一步。
   *
   * 只在 `source === 'PLATFORM'` 且 `operatorId` 有值时允许为 `true`——
   * 别处（`SIGNUP` / `IMPORT`）传 `true` 一律抛 `ProvisionError('ATTACH_NOT_ALLOWED')`：
   * 自助注册开这个口子等于任何人填别人的手机号就能在别人账号下开店，
   * 批量导入是离线任务，没有「操作者事后可查」这个前提，两条路都不该有这个开关。
   *
   * 为 `true` 且手机号**没有**账号时抛 `ProvisionError('ATTACH_ACCOUNT_NOT_FOUND')`——
   * 这个开关只用来「挂到已有账号下」，绝不会退化成「拿一个占位口令建一个新账号」。
   *
   * 生效时 {@link ProvisionResult.attachedExistingAccount} 回 `true`，
   * `buildProvisionAudit()` 的 action 也会换成 `tenant.create-attach-existing`，
   * 好让这条「跳过了口令校验」的口子能被单独 `where action = ...` 巡检出来。
   */
  attachExistingAccount?: boolean
}

/** {@link provisionTenant} 的产出。 */
export interface ProvisionResult {
  /** 新租户 id。 */
  tenantId: string
  /** 店主的 `StaffAccount.id`（一号多店时是**已有**账号的 id）。 */
  ownerAccountId: string
  /** 店主在本店的 `Staff.id`。 */
  ownerStaffId: string
  /** 店主角色（`Role.code = 'owner'`）的 id。 */
  ownerRoleId: string
  created: {
    /**
     * 这次是不是**新建**了登录账号。
     *
     * `false` = 一号多店，成功页要换一句话：他刚才填的是**已有**的口令，
     * 说成「用刚才设置的密码登录」会让他以为口令被改了。
     */
    account: boolean
  }
  /**
   * 这次是不是走的 {@link ProvisionInput.attachExistingAccount} 那条口子——
   * 跳过口令校验、直接绑到已有账号下。
   *
   * 恒等于入参的 `attachExistingAccount === true`（为 `true` 时必然复用已有账号，
   * 见 {@link ProvisionInput.attachExistingAccount} 的 TSDoc）；单独开一个字段
   * 而不是让调用方去反推，是因为「这次开通跳过了口令校验」是审计与前端文案都要看的事实，
   * 不该藏在一堆布尔值的组合里让人猜。
   */
  attachedExistingAccount: boolean
}

/** {@link ProvisionError} 的原因码。**稳定值**，调用方按它映射错误码与文案。 */
export type ProvisionErrorReason =
  /** slug 格式不合法（小写字母数字连字符、3–32、不以连字符开头结尾）。 */
  | 'SLUG_INVALID'
  /** slug 命中保留字。 */
  | 'SLUG_RESERVED'
  /** slug 已被占用。 */
  | 'SLUG_TAKEN'
  /** 手机号不是 11 位大陆号码。 */
  | 'PHONE_INVALID'
  /** 店名不合法（2–30 字）。 */
  | 'NAME_INVALID'
  /** 没给口令：新账号要设一个，已有账号要验一个。 */
  | 'OWNER_PASSWORD_REQUIRED'
  /** 口令太弱（长度 / 最小复杂度）。 */
  | 'OWNER_PASSWORD_WEAK'
  /** 已有账号，但给的口令不对。 */
  | 'OWNER_PASSWORD_MISMATCH'
  /** 已有账号被停用，不能再开店。 */
  | 'OWNER_ACCOUNT_DISABLED'
  /** `trialDays` 不是非负整数。 */
  | 'TRIAL_DAYS_INVALID'
  /** 判定为 `ACTIVE` 却没给 `planExpireAt`。 */
  | 'PLAN_EXPIRE_REQUIRED'
  /** 一个 ADMIN 侧的内置角色模板都没有（DB 空且没给 `deps.rolePresets`）。 */
  | 'ROLE_PRESET_EMPTY'
  /** 角色模板里没有店主（`owner`）那一条。 */
  | 'ROLE_PRESET_MISSING_OWNER'
  /** `source === 'PLATFORM'` 却没给 `operatorId`。 */
  | 'OPERATOR_REQUIRED'
  /** `attachExistingAccount: true` 用在了 `PLATFORM` 以外的 `source` 上。 */
  | 'ATTACH_NOT_ALLOWED'
  /** `attachExistingAccount: true`，但这个手机号根本没有账号。 */
  | 'ATTACH_ACCOUNT_NOT_FOUND'

/**
 * 开通失败。
 *
 * 带 `reason` 而不是只带一句话：调用方要按它决定 HTTP 语义与错误码
 * （`SLUG_TAKEN` 是 400 给商家看的提示，`ROLE_PRESET_EMPTY` 是 500 该叫人）。
 * 比对错误文案来分辨类型的代码，改一个字就静默失效。
 */
export class ProvisionError extends Error {
  /** 稳定原因码。 */
  readonly reason: ProvisionErrorReason
  /** 出问题的那个值（slug、手机号…），**不含口令**。 */
  readonly detail: string | undefined

  constructor(reason: ProvisionErrorReason, message: string, detail?: string) {
    super(message)
    this.name = 'ProvisionError'
    this.reason = reason
    this.detail = detail
  }
}

/** 判定一个异常是不是 {@link ProvisionError}（跨包 `instanceof` 不可靠时用它）。 */
export function isProvisionError(error: unknown): error is ProvisionError {
  return error instanceof Error && error.name === 'ProvisionError' && 'reason' in error
}
