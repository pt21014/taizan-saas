/**
 * 建租户——**全仓唯一的一条路**（蓝图 §8 spec 14、§9）。
 *
 * ## 为什么必须只有一条
 *
 * 平台后台开通、官网自助注册、批量导入存量商家，三条入口。分开写过一次就会漂：
 * 以后加一张初始化的表、改一次角色预设、多一个默认字段，只改一边就出事。
 * 而漂掉的表现**不是报错**，是「从注册进来的店」和「运营手工开的店」在数据上
 * 不是同一种东西——一边建了配额计数器另一边没建，一边下发了全套角色另一边只给了 owner——
 * 然后所有下游逻辑都默认它们一样。xiaodian 就是这么坏掉的。
 *
 * 所以：三条入口都调 {@link provisionTenant}，`source` 只影响审计，**不影响写进库里的任何一个字节**。
 * `provision.spec.ts` 逐条比对 `PLATFORM` 与 `SIGNUP` 的调用序列，
 * `single-path.scan.ts` 扫源码不许别处再出现 `tenant.create(`。
 *
 * ## 本函数不负责的事（刻意留给调用方）
 *
 * - **事务**：`tx` 由调用方给（`prisma.raw.$transaction(async (tx) => provisionTenant(tx, …))`）。
 *   自己开事务的话，调用方就没法把「同时写一条平台审计」放进同一个事务里。
 * - **限流**：三条入口的限流形状不同（自助注册按 IP+手机号一天 3 家，平台后台不限）。
 * - **审计**：`ip` / `traceId` / actor 名字只有 HTTP 层知道；本函数给出
 *   {@link buildProvisionAudit} 的载荷，由调用方在同一个事务里写。
 * - **口令哈希算法**：由 `deps.hashPassword` 注入（一般是 `@taizan/prisma-base` 的 scrypt），
 *   本包不引入任何 crypto 依赖，也就不会和登录那边的哈希格式各走各的。
 *
 * ## 不下发 token
 *
 * 注册成功后**强制走一次登录**。在这里签一个 token 等于开了第三条进后台的路：
 * 登录接口上挂着的验证码、失败限流、账号停用判定、换店重签逻辑，
 * 注册接口一条都没有；而它偏偏是全站唯一「谁都能调、而且会往库里写东西」的入口。
 * 一旦注册返回 token，「免验证码登录」就只差一个已存在的手机号 + 一次密码校验——
 * 那正是这条路上最脆弱的地方。
 *
 * @packageDocumentation
 */

import { computeTrialEnd } from '@taizan/billing-rules'

import {
  DEFAULT_GRACE_DAYS,
  DEFAULT_RETENTION_DAYS,
  assertOwnerPasswordPolicy,
  decideInitialStatus,
  normalizePhone,
  resolveTrialDays,
  validateSlug,
  validateTenantName,
  PHONE_PATTERN,
} from './rules'
import { ProvisionError } from './types'
import type {
  ProvisionInput,
  ProvisionResult,
  ProvisionTx,
  RolePresetSpec,
  RolePresetRow,
} from './types'

/** 店主角色的 code。与 `@taizan/prisma-base` 的 `OWNER_ROLE_CODE` 是同一个值，改一处必须改两处。 */
export const OWNER_ROLE_CODE = 'owner'

/**
 * 开通时初始化的配额维度。
 *
 * `CUSTOM` 不在里面：它的含义由业务层约定，框架替它建一行 `used=0` 的计数器毫无意义。
 */
export const DEFAULT_QUOTA_KINDS: readonly string[] = [
  'STAFF',
  'STORE',
  'MEMBER',
  'STORAGE_MB',
  'TRAFFIC_MB',
]

/** {@link provisionTenant} 的外部依赖。全部注入，本包不读时钟、不生成 id、不做哈希。 */
export interface ProvisionDeps {
  /** 现在。注入而不是 `new Date()`：试用到期落在哪一天是要能测边界的。 */
  now(): Date
  /** 主键生成器，一般是 `@taizan/contracts` 的 `ulid`。 */
  ulid(): string
  /** 口令哈希，一般是 `@taizan/prisma-base` 的 `hashPassword`（scrypt）。 */
  hashPassword(plain: string): Promise<string> | string
  /**
   * 口令校验，一般是 `@taizan/prisma-base` 的 `verifyPassword`。
   * 一号多店时用来核对**已有账号**的口令，必给。
   */
  verifyPassword(plain: string, hash: string): Promise<boolean> | boolean
  /**
   * `RolePreset` 表为空时的回落模板（一般传 `@taizan/prisma-base` 的 `BASE_ROLE_PRESETS`）。
   *
   * 不在本包里硬编一份：那就成了角色预设的第二个真源，而「两个真源」正是本文件在防的事。
   * 两边都空就抛 `ROLE_PRESET_EMPTY`——开出一个进去什么都点不了的租户比开不出来更糟。
   */
  rolePresets?: readonly RolePresetSpec[]
  /** 要初始化的配额维度，默认 {@link DEFAULT_QUOTA_KINDS}。传 `[]` 表示不建。 */
  quotaKinds?: readonly string[]
}

/** 落库前整理好的角色定义。 */
interface RoleDef {
  code: string
  name: string
  permissionCodes: string[]
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/** DB 行 / 回落模板 → 统一的角色定义，按 code 排序保证任何机器上的写入顺序一致。 */
function toRoleDefs(
  rows: readonly RolePresetRow[],
  fallback: readonly RolePresetSpec[],
): RoleDef[] {
  const defs: RoleDef[] =
    rows.length > 0
      ? rows.map((row) => ({
          code: row.code,
          name: row.name,
          permissionCodes: toStringArray(row.permissionCodes),
        }))
      : fallback
          .filter((preset) => preset.side === 'ADMIN')
          .map((preset) => ({
            code: preset.code,
            name: preset.name,
            permissionCodes: [...preset.permissionCodes],
          }))

  return defs.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
}

/**
 * 开通一家店。**在调用方给的事务里**跑完，任何一步失败都抛 {@link ProvisionError}，
 * 由调用方的 `$transaction` 整体回滚。
 *
 * ## 顺序不是随便排的
 *
 * ```text
 * 校验（纯函数）
 *   → slug 查重           ┐
 *   → 找/验店主账号        ├ 只读：拦下时库里什么都还没建
 *   → 读角色模板           ┘
 *   → 建账号（仅新号）→ 建租户 → 建角色 → 建店主成员 → 初始化配额计数器
 * ```
 *
 * **所有只读判定排在所有写之前**：口令错、slug 被占、角色模板坏掉这三种失败，
 * 应该在什么都没建出来的时候停下。虽然外层事务会回滚，但依赖顺序也逼着这么排——
 * `Tenant.ownerAccountId` 依赖 `StaffAccount`，`Staff.roleIds` 依赖 `Role`。
 *
 * ## 一号多店
 *
 * 手机号已经有账号时**复用**它，不重建、不改名、**不改口令**。改口令在这里会是一个后门：
 * 平台运营给某个手机号开新店，顺带就把他别的店的登录口令改掉了。
 * 代价是他必须填对现有口令——包括平台后台那条路（运营得让商家自己填，或者用邀请流程）。
 *
 * @param tx - 事务客户端，见 {@link ProvisionTx}
 * @param input - 见 {@link ProvisionInput}
 * @param deps - 见 {@link ProvisionDeps}
 * @returns 见 {@link ProvisionResult}。**刻意不含 token**，见文件头。
 * @throws {@link ProvisionError}
 *
 * @example
 * ```ts
 * // raw-reason: 建租户是跨租户操作——这一刻租户还不存在，注入不了 tenantId。
 * const result = await prisma.raw.$transaction((tx) =>
 *   provisionTenant(tx, { slug, name, ownerPhone, ownerPassword, source: 'SIGNUP' }, deps),
 * )
 * ```
 */
export async function provisionTenant<TQuotaKind extends string = string>(
  tx: ProvisionTx<TQuotaKind>,
  input: ProvisionInput,
  deps: ProvisionDeps,
): Promise<ProvisionResult> {
  // ── 1. 纯函数校验 ─────────────────────────────────────────────────────────
  const slugCheck = validateSlug(input.slug)
  if (!slugCheck.ok) throw new ProvisionError(slugCheck.reason, slugCheck.message, input.slug)
  const slug = slugCheck.value

  const nameCheck = validateTenantName(input.name)
  if (!nameCheck.ok) throw new ProvisionError(nameCheck.reason, nameCheck.message)
  const name = nameCheck.value

  const phone = normalizePhone(input.ownerPhone)
  if (!PHONE_PATTERN.test(phone)) {
    throw new ProvisionError('PHONE_INVALID', '手机号填错了，要 11 位', phone)
  }

  if (input.source === 'PLATFORM' && (input.operatorId ?? '') === '') {
    // 平台开通是有人按下去的，谁按的必须留痕；漏了的话审计表里会出现一批「不知道谁开的店」。
    throw new ProvisionError('OPERATOR_REQUIRED', '平台后台开通租户必须带 operatorId')
  }

  const attach = input.attachExistingAccount === true
  if (attach && input.source !== 'PLATFORM') {
    // 不给 SIGNUP / IMPORT 开这个口子：自助注册开了它，任何人填别人的手机号就能
    // 在别人账号下开店；批量导入是离线任务，没有「操作者事后可查」这个前提。
    throw new ProvisionError(
      'ATTACH_NOT_ALLOWED',
      '只有平台后台开通（source = PLATFORM）才能绑定既有账号并跳过口令校验',
    )
  }

  const status = decideInitialStatus({ planId: input.planId, trialDays: input.trialDays })
  const trialEndAt =
    status === 'TRIAL'
      ? computeTrialEnd(deps.now(), resolveTrialDays(input.trialDays), input.timezone)
      : null
  // ACTIVE 且没有任何到期日的租户，在 evaluateTenantGate 里算出来是 PENDING（未开通），
  // 开出来就是打烊的——而这是一家刚收过钱的店。宁可在这里失败。
  if (status === 'ACTIVE' && input.planExpireAt === undefined) {
    throw new ProvisionError(
      'PLAN_EXPIRE_REQUIRED',
      '按套餐开通（ACTIVE）必须给 planExpireAt，否则闸门算出来是未开通',
    )
  }
  const planExpireAt = status === 'TRIAL' ? trialEndAt : (input.planExpireAt ?? null)

  // ── 2. 只读：查重、认账号、读模板 ────────────────────────────────────────
  const taken = await tx.tenant.findUnique({ where: { slug } })
  if (taken !== null) {
    throw new ProvisionError('SLUG_TAKEN', `店铺路径「${slug}」已经被占用了`, slug)
  }

  const account = await tx.staffAccount.findUnique({ where: { phone } })
  const password = input.ownerPassword ?? ''

  if (attach) {
    // 这个开关只用来「挂到已有账号下」：账号不存在就直接拒绝，绝不会退化成
    // 「拿一个占位口令建一个新账号」——那正是这个口子最怕被滥用成的样子。
    if (account === null) {
      throw new ProvisionError(
        'ATTACH_ACCOUNT_NOT_FOUND',
        `手机号 ${phone} 还没有登录账号，不能用「绑定既有账号」开通`,
        phone,
      )
    }
    if (account.status !== 'ACTIVE') {
      throw new ProvisionError('OWNER_ACCOUNT_DISABLED', '这个账号已被停用，不能再开店', phone)
    }
    // 跳过 verifyPassword：这条口子的安全性建立在「操作者显式按下开关 + 事后留痕」上，
    // 不建立在「操作者恰好知道商家的口令」上——平台后台本来就拿不到商家的口令。
  } else if (account !== null) {
    if (password === '') {
      throw new ProvisionError(
        'OWNER_PASSWORD_REQUIRED',
        '这个手机号已经注册过了，请填写它现有的登录密码，新店会挂在同一个账号下',
      )
    }
    if (account.status !== 'ACTIVE') {
      throw new ProvisionError('OWNER_ACCOUNT_DISABLED', '这个账号已被停用，不能再开店', phone)
    }
    const matched = await deps.verifyPassword(password, account.passwordHash)
    if (!matched) {
      // 不区分「没有这个账号」与「口令不对」的文案：区分了，这个接口就是一个手机号枚举器。
      throw new ProvisionError('OWNER_PASSWORD_MISMATCH', '手机号或密码不对')
    }
  } else {
    if (password === '') {
      throw new ProvisionError('OWNER_PASSWORD_REQUIRED', '请为店主账号设置登录密码')
    }
    assertOwnerPasswordPolicy(password)
  }

  const presetRows = await tx.rolePreset.findMany({
    where: { side: 'ADMIN', builtin: true },
    orderBy: { code: 'asc' },
  })
  const roleDefs = toRoleDefs(presetRows, deps.rolePresets ?? [])
  if (roleDefs.length === 0) {
    throw new ProvisionError(
      'ROLE_PRESET_EMPTY',
      'RolePreset 表里没有 ADMIN 侧的内置角色模板，也没给 deps.rolePresets：先跑一次 seed',
    )
  }
  if (!roleDefs.some((def) => def.code === OWNER_ROLE_CODE)) {
    // 角色预设被改坏时早失败：别建出一个没有店主角色、进去什么都点不了的租户。
    throw new ProvisionError(
      'ROLE_PRESET_MISSING_OWNER',
      `角色模板里缺少店主（code = ${OWNER_ROLE_CODE}）`,
    )
  }

  // ── 3. 写：账号 → 租户 → 角色 → 成员 → 配额 ──────────────────────────────
  const trimmedOwnerName = (input.ownerName ?? '').trim()
  const ownerName = trimmedOwnerName === '' ? name : trimmedOwnerName

  let ownerAccountId: string
  const accountCreated = account === null
  if (account === null) {
    const passwordHash = await deps.hashPassword(password)
    const created = await tx.staffAccount.create({
      data: {
        id: deps.ulid(),
        phone,
        passwordHash,
        name: ownerName,
        status: 'ACTIVE',
      },
    })
    ownerAccountId = created.id
  } else {
    ownerAccountId = account.id
  }

  const tenant = await tx.tenant.create({
    data: {
      id: deps.ulid(),
      slug,
      name,
      status,
      planId: input.planId ?? null,
      planExpireAt,
      trialEndAt,
      graceDays: DEFAULT_GRACE_DAYS,
      retentionDays: DEFAULT_RETENTION_DAYS,
      ownerAccountId,
    },
  })

  let ownerRoleId = ''
  for (const def of roleDefs) {
    const role = await tx.role.create({
      data: {
        id: deps.ulid(),
        tenantId: tenant.id,
        code: def.code,
        name: def.name,
        permissionCodes: def.permissionCodes,
        menuKeys: null,
        builtin: true,
      },
    })
    if (def.code === OWNER_ROLE_CODE) ownerRoleId = role.id
  }

  const staff = await tx.staff.create({
    data: {
      id: deps.ulid(),
      tenantId: tenant.id,
      accountId: ownerAccountId,
      name: ownerName,
      status: 'ACTIVE',
      // 只给店主角色。其余模板已经建好挂在店里，等他自己去分配给员工——
      // 全都塞给店主的话，将来「店主有哪些角色」这个列表会长得莫名其妙。
      roleIds: [ownerRoleId],
      dataScope: 'ALL',
      scopeTargets: null,
      // isOwner 只能从这里产生：它不是一个可勾选的角色（见 rbac-core 的 ASSIGNABLE_ROLE_RULE），
      // 转让店铺是另一条带二次确认的路。
      isOwner: true,
      invitedBy: null,
      joinedAt: deps.now(),
    },
  })

  const quotaKinds = deps.quotaKinds ?? DEFAULT_QUOTA_KINDS
  if (tx.quotaCounter !== undefined && quotaKinds.length > 0) {
    await tx.quotaCounter.createMany({
      data: quotaKinds.map((kind) => ({
        id: deps.ulid(),
        tenantId: tenant.id,
        // `deps.quotaKinds` 是纯字符串（本包不认识调用方的枚举类型），`TQuotaKind` 由
        // 调用方实例化（一般是 Prisma 生成的 `QuotaKind`）。这一处收窄由本包自己担着，
        // 好过让调用方在外面对整个 tx 做一次 `as unknown as`。
        kind: kind as TQuotaKind,
        // 店主本人就是第一个员工。从 0 开始的话，这家店的员工配额从出生起就少算一个人。
        used: kind === 'STAFF' ? 1 : 0,
        version: 0,
      })),
      skipDuplicates: true,
    })
  }

  return {
    tenantId: tenant.id,
    ownerAccountId,
    ownerStaffId: staff.id,
    ownerRoleId,
    created: { account: accountCreated },
    attachedExistingAccount: attach,
  }
}

/** {@link buildProvisionAudit} 的产出：拼进 `PlatformAuditLog.create` 的那几列。 */
export interface ProvisionAuditPayload {
  action: string
  targetTenantId: string
  targetType: 'Tenant'
  targetId: string
  actorId: string
  after: Record<string, unknown>
}

/**
 * 拼一条开通租户的审计载荷，交给调用方在**同一个事务里**写 `PlatformAuditLog`。
 *
 * 审计不在 {@link provisionTenant} 里写，是因为 `ip` / `traceId` / actor 显示名只有 HTTP 层知道，
 * 而 `PlatformAuditLog` 上 `ip` 与 `traceId` 都是非空列。把它们塞进 `ProvisionInput`
 * 会让一个纯逻辑函数开始认识 HTTP。
 *
 * `source` 与 `operatorId` **只在这里**被用到——它们不进任何写库 payload，
 * 这正是「三条入口写出来的租户完全一样」的实现方式。
 *
 * ## `action` 只有两种值，`source` 不参与拼接
 *
 * `action` 定死是 `tenant.create` 或者（{@link ProvisionInput.attachExistingAccount}
 * 生效时）`tenant.create-attach-existing`——`@taizan/nest-audit` 的 `defineAuditActions()`
 * 要求动作码是 `module.action` 两段式（恰好一个点），把 `source` 拼进去会变成
 * `tenant.provision.platform` 这种三段式，进不了那张校验。`source` 本来就已经在
 * `after.source` 里，两处都塞一遍没有必要。
 */
export function buildProvisionAudit(
  input: ProvisionInput,
  result: ProvisionResult,
): ProvisionAuditPayload {
  return {
    action: result.attachedExistingAccount ? 'tenant.create-attach-existing' : 'tenant.create',
    targetTenantId: result.tenantId,
    targetType: 'Tenant',
    targetId: result.tenantId,
    // 自助注册没有操作者：记成新店主自己的账号 id。
    actorId: input.operatorId ?? result.ownerAccountId,
    after: {
      slug: String(input.slug).trim().toLowerCase(),
      name: input.name,
      source: input.source,
      planId: input.planId ?? null,
      ownerAccountId: result.ownerAccountId,
      accountCreated: result.created.account,
      ...(result.attachedExistingAccount ? { attachedExistingAccount: true } : {}),
    },
  }
}
