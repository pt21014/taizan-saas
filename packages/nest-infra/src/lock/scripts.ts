/**
 * 分布式锁用到的两段 Lua。
 *
 * 为什么必须是 Lua：`DEL` 和「比对 token」之间只要有一个网络往返，就存在这样一条时序——
 * A 读到 token 相同 → A 的锁在这一刻 TTL 到期 → B 抢到锁 → A 执行 `DEL` → **A 把 B 的锁删了**。
 * 之后 C 也能抢到锁，于是同一时刻有两个持有者。Lua 在 Redis 里是原子执行的，堵死这条缝。
 *
 * @packageDocumentation
 */

/** token 相同才删。返回 1 表示确实是自己的锁被释放了，0 表示锁已经不是自己的了。 */
export const RELEASE_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`.trim()

/** token 相同才续期（watchdog 用）。返回 1 续期成功，0 表示锁已易主/已过期。 */
export const RENEW_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
else
  return 0
end
`.trim()
