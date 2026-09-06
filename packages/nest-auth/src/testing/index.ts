/**
 * `@taizan/nest-auth/testing`：给下游复用的测试替身。
 *
 * 业务侧写守卫/流程的单测时不该起真 Redis，也不该各造一个假的——
 * 语义（`getdel` 的原子性、惰性过期）复刻错了，测出来的绿是假的。统一用这里这一份。
 *
 * @packageDocumentation
 */

export { InMemoryAuthRedis, takeOnce, type AuthRedis } from '../redis'
export { systemClock, type Clock } from '../clock'
export { FakeClock } from './fake-clock'
export { FakeMembershipProvider } from './fake-membership'
