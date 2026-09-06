/**
 * `RawPrismaService`：无租户注入的句柄，单独做成一个可注入的类。
 *
 * ## 为什么值得单独一个类
 *
 * `prisma.raw` 和 `RawPrismaService` 拿到的是**同一个对象**，功能上完全等价。分出来
 * 只为一件事：**让「谁在绕过租户隔离」在源码里可扫描**。
 *
 * `prisma.raw.xxx` 这种写法藏在任意一行表达式里，扫描器要做数据流分析才认得出；
 * 而 `constructor(@Inject(RawPrismaService) private readonly raw: RawPrismaService)`
 * 是一个模块级的、静态可见的依赖声明——蓝图 §8 的 spec 3（`raw-usage.spec.ts`）
 * 直接按注入点列白名单即可。
 *
 * 白名单只有三类（蓝图 §4.2）：登录跨租户找账号、支付回调按参数定位租户、平台后台。
 * 每个注入点都要写 `// raw-reason: <理由>`。
 *
 * @packageDocumentation
 */

import { Inject, Injectable } from '@nestjs/common'
import { PrismaService, type ExtendedPrismaClient } from './prisma.service'
import type { PrismaArgs, PrismaClientLike } from './types'

/**
 * 无租户注入的 Prisma 句柄。
 *
 * 仍然保留软删过滤与 ULID 填充——绕过的只有租户隔离这一层，不是「什么都不管」。
 * 需要连软删的一起查就传 `withDeleted: true`，需要物理删除用 {@link RawPrismaService.hardDelete}。
 *
 * @typeParam TClient - 客户端类型，业务项目传自己生成的 Prisma 类型。
 */
@Injectable()
export class RawPrismaService<TClient = ExtendedPrismaClient> {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService<TClient>) {}

  /**
   * 无租户注入的客户端。
   *
   * @example
   * ```ts
   * // raw-reason: 登录时还不知道用户属于哪个租户，必须跨租户按手机号找账号
   * const staff = await this.raw.client.staff.findFirst({ where: { phone } })
   * ```
   */
  get client(): TClient {
    return this.prisma.raw
  }

  /** 物理删除逃生口，走完全未叠加扩展的 base 客户端。 */
  async hardDelete(model: string, args: PrismaArgs): Promise<unknown> {
    return this.prisma.hardDelete(model, args)
  }

  /** 物理批量删除逃生口。 */
  async hardDeleteMany(model: string, args: PrismaArgs): Promise<unknown> {
    return this.prisma.hardDeleteMany(model, args)
  }

  /** 事务。注意事务体里拿到的是**带租户注入**的客户端（`PrismaService.$transaction` 的语义）。 */
  async $transaction<T>(fn: (tx: TClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn)
  }

  /** 给需要结构化类型的地方用的逃生口。 */
  asClientLike(): PrismaClientLike {
    return this.prisma.raw as PrismaClientLike
  }
}
