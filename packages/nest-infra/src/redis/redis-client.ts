/**
 * 「长得像 ioredis」的最小结构约束。
 *
 * 为什么不直接 `import type Redis from 'ioredis'`：`ioredis` 在本包里是 **peer**，
 * 装配它的是业务应用（生产用真 ioredis、单测用 `ioredis-mock`、将来换 `iovalkey`
 * 也不该动框架）。把它写进类型签名会让「用别的客户端」变成类型错误，
 * 而这几个命令的形状十几年没变过，用结构化类型约束成本更低。
 *
 * `redis-client.spec.ts` 里有一条静态断言，保证真 ioredis 仍然满足这个接口——
 * 结构化类型最怕的就是上游改了签名而我们毫无察觉。
 *
 * @packageDocumentation
 */

/** 扫描一页的结果：`[下一个游标, 这一页的 key]`。 */
export type ScanPage = [cursor: string, keys: string[]]

/**
 * 本包用到的 Redis 命令子集。
 *
 * **只列真正用到的命令**：多列一个就多一分「换客户端时对不上」的风险，
 * 而且这份清单本身就是「基础设施层依赖了 Redis 的哪些能力」的文档。
 */
export interface RedisClient {
  get(key: string): Promise<string | null>
  /** `SET key value PX ttl`。 */
  set(key: string, value: string, px: 'PX', milliseconds: number): Promise<'OK' | null>
  /** `SET key value PX ttl NX`——分布式锁与幂等占位就靠它的原子性。 */
  set(key: string, value: string, px: 'PX', milliseconds: number, nx: 'NX'): Promise<'OK' | null>
  del(...keys: string[]): Promise<number>
  /** `GETDEL`：取一次就删，一次性凭据的唯一正确姿势。 */
  getdel(key: string): Promise<string | null>
  pexpire(key: string, milliseconds: number): Promise<number>
  pttl(key: string): Promise<number>
  /** `SCAN cursor MATCH pattern COUNT count`。 */
  scan(
    cursor: string | number,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number | string,
  ): Promise<ScanPage>
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>
  ping(): Promise<string>
  quit(): Promise<'OK'>
}
