/**
 * DI token。
 *
 * 单独一个文件是为了断开循环依赖：`prisma.module.ts` 要 import `PrismaService`，
 * `prisma.service.ts` 又要 import token——token 放模块文件里就成环了。
 *
 * 用 `Symbol.for` 而不是字符串：字符串 token 在两个包里撞名会**静默**互相覆盖，
 * 而 `Symbol.for` 带包名前缀，撞名概率约等于零。
 *
 * @packageDocumentation
 */

/**
 * 未叠加任何扩展的原始 Prisma 客户端。
 *
 * **业务代码不要注入它**：它没有租户隔离、没有软删过滤。它只服务两个内部用途——
 * `PrismaService` 在它之上叠扩展，以及归属探针 / {@link 物理删除} 逃生口。
 */
export const PRISMA_BASE_CLIENT = Symbol.for('@taizan/nest-prisma:PRISMA_BASE_CLIENT')

/** `PrismaModule.forRoot()` 的选项。 */
export const PRISMA_MODULE_OPTIONS = Symbol.for('@taizan/nest-prisma:PRISMA_MODULE_OPTIONS')
