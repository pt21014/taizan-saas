/**
 * `ioredis-mock` 没有自带类型，社区的 `@types/ioredis-mock` 停在 ioredis v4 的形状上，
 * 装了反而会和 v5 打架。本包只在单测里用它，而且用完立刻 `as unknown as RedisClient`
 * 收窄，所以这里只声明「它导出一个可 new 的东西」就够了。
 */
declare module 'ioredis-mock' {
  const RedisMock: new (options?: unknown) => unknown
  export default RedisMock
}
