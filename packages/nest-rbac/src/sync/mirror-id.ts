/**
 * 镜像行主键的生成。
 *
 * @packageDocumentation
 */

import { createHash } from 'node:crypto'

/** Crockford base32（与 ULID 同一张表）。 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 主键长度，对齐 `04-rbac.prisma` 里的 `@db.VarChar(26)`。 */
const LENGTH = 26

/**
 * 由「表名 + 业务 key」算出一个**确定性**的 26 位主键。
 *
 * ## 为什么不用 `ulid()`
 *
 * `Permission` / `Menu` 是**镜像表**：同一份注册表同步一百次，结果必须完全一样。
 * 用随机 ULID 的话，`upsert` 的 `create` 分支每次都带一个新 id——虽然只有首次插入
 * 会用到，但这让「同步命令是幂等的」这句话在**参数层面**无法被断言（第二次跑的 args
 * 与第一次不同），架构测试只能退化成「查库比对结果」，那就要连库。
 * 确定性 id 还有一个额外好处：dev 库与 prod 库里同一个权限点的 id 相同，
 * 导数据 / 对日志时不用做映射。
 *
 * 碰撞概率：取 sha256 的前 130 位，同一张表里几千个 key 的碰撞概率可以忽略。
 *
 * @param table - 表名（`'Permission'` / `'Menu'`），把两张表的命名空间分开
 * @param key - 业务唯一键（权限点 code / 菜单 key）
 */
export function mirrorId(table: string, key: string): string {
  const digest = createHash('sha256').update(`${table} ${key}`).digest('hex')
  // 130 bits = 26 个 base32 字符。从最低位往高位取，顺序无所谓，只要确定。
  let value = BigInt(`0x${digest}`) & ((1n << 130n) - 1n)
  let out = ''
  for (let i = 0; i < LENGTH; i += 1) {
    out = `${ALPHABET[Number(value & 31n)] as string}${out}`
    value >>= 5n
  }
  return out
}
