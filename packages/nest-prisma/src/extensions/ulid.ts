/**
 * 主键自动填充扩展：create 类操作没给 `id` 时补一个 ULID（蓝图 §3.1）。
 *
 * ## 为什么主键由应用层生成
 *
 * - 单调递增、字典序即时间序，做游标分页不用再排 `createdAt`；
 * - 插入前就知道 id，一次事务里能先拿 id 再拼关联数据，不用「插完再读回来」；
 * - 26 位定长字符串，跨服务传递不会像自增 int 那样暴露业务量。
 *
 * 代价是「谁生成」这件事必须只有一处。放在扩展里而不是每个 service 里手写，
 * 是因为漏写不会报错——数据库会用自己的默认值（或直接报缺列），等发现时数据已经混了两种格式。
 *
 * ## 叠加位置
 *
 * 放在**最内层**（最后一个 `$extends`）。它只关心最终落库的 `data`，前面的租户注入、
 * 软删改写都做完之后再补 id 最省事；反过来放外层的话，软删把 `delete` 改写成 `update`
 * 时它已经跑过了，白跑一次。
 *
 * @packageDocumentation
 */

import { ulid } from '@taizan/contracts'
import { defineQueryExtension, type PrismaExtension } from '../define-extension'
import { isPlainObject, toArgsObject, type QueryHookParams } from '../types'

/** {@link createUlidExtension} 的选项。 */
export interface UlidExtensionOptions {
  /**
   * 判断某个模型的 `id` 是不是 `String`。默认 `() => true`——蓝图 §3.1 规定全仓主键
   * 一律 `String @id` ULID，所以默认全填。
   *
   * 接了遗留库、有 `Int @id @default(autoincrement())` 的表时，在这里把它们排除掉；
   * 否则给自增主键塞一个 26 位字符串，Prisma 会直接报类型错。
   */
  hasStringId?: (model: string) => boolean

  /** 主键字段名，默认 `id`。 */
  field?: string

  /** 生成器，默认 `@taizan/contracts` 的 `ulid`。测试里可以注入固定序列。 */
  generate?: () => string
}

/** create 类操作：`data` 里每一行都要过一遍填充。 */
const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn'])

/**
 * 给一行待写入的数据补 `id`。
 *
 * 只在**完全没有这个键**时补。调用方显式写了 `id`（哪怕是 `undefined`）就不覆盖——
 * 显式传 `undefined` 通常意味着「让数据库默认值生效」，扩展不该替他做主。
 */
function fillRow(row: unknown, field: string, generate: () => string): unknown {
  if (!isPlainObject(row)) return row
  if (field in row) return row
  return { ...row, [field]: generate() }
}

/**
 * 创建主键填充扩展。
 *
 * 覆盖 `create.data`、`createMany.data`（数组或单对象）、`createManyAndReturn.data`
 * 与 `upsert.create`。**不覆盖**嵌套写里的 `create`——嵌套那层由 Prisma 自己的
 * `@default` 或业务侧负责；扩展递归改嵌套结构风险大于收益，见「已知未覆盖点」。
 *
 * @param options - 见 {@link UlidExtensionOptions}
 * @returns 可以直接喂给 `client.$extends(...)` 的扩展
 */
export function createUlidExtension(options: UlidExtensionOptions = {}): PrismaExtension {
  const hasStringId = options.hasStringId ?? ((): boolean => true)
  const field = options.field ?? 'id'
  const generate = options.generate ?? ulid

  return defineQueryExtension(
    'taizan-ulid-id',
    async ({ model, operation, args, query }: QueryHookParams): Promise<unknown> => {
      if (!CREATE_OPERATIONS.has(operation) && operation !== 'upsert') return query(args)
      if (!hasStringId(model)) return query(args)

      const next = toArgsObject(args, `${model}.${operation}`)

      if (operation === 'upsert') {
        next.create = fillRow(next.create, field, generate)
        return query(next)
      }

      if (operation === 'create') {
        next.data = fillRow(next.data, field, generate)
        return query(next)
      }

      next.data = Array.isArray(next.data)
        ? next.data.map((row) => fillRow(row, field, generate))
        : fillRow(next.data, field, generate)
      return query(next)
    },
  )
}
