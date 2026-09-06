/**
 * 应用侧的 Prisma 类型收窄。
 *
 * `@taizan/nest-prisma` 是框架包，编译时拿不到 `prisma generate` 的产物，所以它对
 * 客户端只做结构化约束（`PrismaService<TClient = ExtendedPrismaClient>`）。
 * 业务项目在这里把泛型参数填成自己生成的 `PrismaClient`，从此
 * `prisma.tenant.goods.findMany({...})` 就有完整的字段提示与编译期检查。
 *
 * 注入写法（**必须显式 `@Inject`**，见 `tsup.config.ts` 文件头）：
 *
 * ```ts
 * constructor(@Inject(PrismaService) private readonly prisma: AppPrismaService) {}
 * ```
 *
 * @packageDocumentation
 */

import type { PrismaClient } from '@prisma/client'
import type { PrismaService } from '@taizan/nest-prisma'

/** 本应用生成出来的 Prisma 客户端类型。 */
export type AppPrismaClient = PrismaClient

/**
 * 带类型的 `PrismaService`。
 *
 * 注意 `prisma.tenant` 与 `prisma.raw` 的类型都是 `AppPrismaClient`——它们**结构上**
 * 确实一样，区别只在运行时叠了哪些扩展。类型系统区分不了这一点，所以「只准用 tenant」
 * 这条约束靠 `test/arch/raw-usage.spec.ts` 扫源码，而不是靠编译器。
 */
export type AppPrismaService = PrismaService<AppPrismaClient>

/** 事务回调里拿到的客户端。与 `AppPrismaClient` 同形，但它绑在一个打开的事务上。 */
export type AppPrismaTx = AppPrismaClient

/**
 * 由扩展在运行时自动填的列：ULID 主键与租户列。
 *
 * Prisma 生成的 `XxxCreateInput` 把它们标成必填，但业务代码**一个都不许写**：
 * `id` 由 `createUlidExtension` 填，`tenantId` 由 `createTenantExtension` 从请求上下文注入。
 * 于是「按类型写对」和「按约定写对」在 create 这一处是矛盾的。
 */
export type AutoInjectedColumns = 'id' | 'tenantId'

/**
 * 把一份「不含 `id` / `tenantId`」的 create data 标注成 Prisma 要的完整类型。
 *
 * 它在运行时**什么都不做**，存在的意义全在类型上：
 * - 让业务代码写 `data: autoTenantData<Prisma.GoodsCreateInput>({ name, priceCents })` 能编译；
 * - 同时让「多写了一个 `tenantId`」变成一个**编译错误**（`Omit` 掉的键传进去会报 excess property）。
 *
 * 第二条才是重点：裸 `as` 转换会把手写 `tenantId` 一起放过去，而那正是
 * 「禁止手写 tenantId 过滤条件」这条约定要挡的东西。
 *
 * @param data - 不含自动注入列的创建数据
 */
export function autoTenantData<T extends object>(data: Omit<T, AutoInjectedColumns>): T {
  return data as T
}
