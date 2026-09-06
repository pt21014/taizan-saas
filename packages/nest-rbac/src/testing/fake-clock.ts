import type { RbacClock } from '../role-permissions.service'

/**
 * 可手动推进的时钟。
 *
 * 「角色缓存 30 秒内旧权限仍生效」这类断言，靠真的 `await sleep(30_000)` 等于给测试
 * 套件加 30 秒；靠 `vi.useFakeTimers()` 又会连带劫持 Nest 内部的定时器。
 * 一个显式注入的时钟最干净（与 `@taizan/nest-auth/testing` 的 `FakeClock` 同一个形状）。
 */
export class FakeRbacClock implements RbacClock {
  private current: number

  /** @param startAt - 起始毫秒时间戳，默认一个固定值（让测试可复现）。 */
  constructor(startAt = Date.UTC(2026, 0, 1, 0, 0, 0)) {
    this.current = startAt
  }

  now(): number {
    return this.current
  }

  /** 往前推 `ms` 毫秒。 */
  advance(ms: number): void {
    this.current += ms
  }

  /** 往前推 `sec` 秒。 */
  advanceSeconds(sec: number): void {
    this.advance(sec * 1000)
  }
}
