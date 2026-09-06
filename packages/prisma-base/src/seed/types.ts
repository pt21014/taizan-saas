/**
 * seed 的鸭子类型接口。
 *
 * **刻意不 import `PrismaClient`**：`@taizan/prisma-base` 不生成 client、不依赖
 * `@prisma/client` 的运行时类型，否则每个业务项目都要保证自己的 client 版本与框架一致，
 * 而 client 类型是随业务 schema 生成的，框架根本不该知道它长什么样。
 *
 * 于是这里只声明「seed 用到的那几个方法」，业务项目直接把 `prisma` 传进来即可：
 * 真实的 `PrismaClient` 在结构上满足这套接口（`upsert` 返回的模型里有 `id: string`）。
 *
 * ⚠️ 传进来的必须是**未经租户隔离扩展包装**的原始 client：seed 要跨租户建数据，
 * 隔离扩展在没有租户上下文时会直接抛错（这是它的正确行为）。
 */

/** 一次 upsert 的入参。字段结构与 Prisma 的 `upsert` 一致。 */
export interface SeedUpsertArgs {
  /** 唯一定位条件。 */
  where: Record<string, unknown>
  /** 不存在时创建的数据（含 `id`，ULID 由本包生成）。 */
  create: Record<string, unknown>
  /** 已存在时更新的数据。seed 幂等的关键：只更新「应该被框架接管」的列。 */
  update: Record<string, unknown>
}

/** upsert 的返回值：只要拿得到 id 就够了。 */
export interface SeedRow {
  /** 主键。 */
  id: string
}

/** 一个模型的 delegate（`prisma.tenant` 这种）。 */
export interface SeedDelegate {
  /**
   * 幂等写入。
   *
   * @param args - 见 {@link SeedUpsertArgs}
   * @returns 写入或命中的行
   */
  upsert(args: SeedUpsertArgs): Promise<SeedRow>
}

/** {@link seedBase} 需要的 delegate 集合。 */
export interface SeedContext {
  /** `prisma.platformAdmin` */
  platformAdmin: SeedDelegate
  /** `prisma.plan` */
  plan: SeedDelegate
  /** `prisma.tenant` */
  tenant: SeedDelegate
  /** `prisma.staffAccount` */
  staffAccount: SeedDelegate
  /** `prisma.staff` */
  staff: SeedDelegate
  /** `prisma.role` */
  role: SeedDelegate
  /** `prisma.rolePreset`，给了就顺带下发内置角色模板。 */
  rolePreset?: SeedDelegate
  /**
   * `prisma.permission`，可选。
   *
   * 平时**不该传**：权限点的真源是代码注册表，DB 只是镜像，由启动期同步任务覆盖写
   * （蓝图附录 #3）。留这个口子只为「先把库跑起来看看」的临时场景。
   */
  permission?: SeedDelegate
  /**
   * `prisma.notifyTemplate`，可选。传了才写通知模板（T2-7），见 `notify-templates.ts`。
   *
   * 与 `rolePreset` 同一个取舍：不传就跳过，不强迫所有消费方都装配一份 delegate。
   */
  notifyTemplate?: SeedDelegate
}

/** {@link seedBase} 的可选参数。全部有默认值，一个都不传也能跑。 */
export interface SeedBaseOptions {
  /** 基准时间，默认当前时刻。测试里传固定值好断言。 */
  now?: Date
  /** 主键生成器，默认 `@taizan/contracts` 的 `ulid()`。 */
  newId?: () => string
  /** 平台管理员用户名。 */
  adminUsername?: string
  /** 平台管理员初始口令。**上线前必须改**。 */
  adminPassword?: string
  /** 平台管理员显示名。 */
  adminName?: string
  /** 演示租户的 slug。 */
  tenantSlug?: string
  /** 演示租户名。 */
  tenantName?: string
  /** 演示租户的试用天数。 */
  trialDays?: number
  /** 店主手机号（同时是 StaffAccount 的登录名）。 */
  ownerPhone?: string
  /** 店主初始口令。**上线前必须改**。 */
  ownerPassword?: string
  /** 店主显示名。 */
  ownerName?: string
  /** 是否创建演示租户。生产环境初始化时传 `false`，只要管理员与套餐。 */
  withDemoTenant?: boolean
}

/** {@link seedBase} 的产出。 */
export interface SeedBaseResult {
  /** 平台管理员。 */
  platformAdmin: { id: string; username: string }
  /** 两档套餐。 */
  plans: { trial: { id: string; code: string }; standard: { id: string; code: string } }
  /** 下发的内置角色模板数量（没传 `rolePreset` 时为 0）。 */
  rolePresetCount: number
  /** 写入的通知模板条数（没传 `notifyTemplate` 时为 0）。 */
  notifyTemplateCount: number
  /** 演示租户及其店主；`withDemoTenant: false` 时为 `undefined`。 */
  demo?: {
    /** 租户。 */
    tenant: { id: string; slug: string }
    /** 店主登录账号。 */
    ownerAccount: { id: string; phone: string }
    /** 店内的店主角色。 */
    ownerRole: { id: string; code: string }
    /** 店主的成员关系。 */
    ownerStaff: { id: string }
  }
}
