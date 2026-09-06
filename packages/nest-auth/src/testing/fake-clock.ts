import type { Clock } from '../clock'

/**
 * 可手动推进的时钟。
 *
 * 「成员被停用后 ≤30 秒内 401」这类断言，靠真的 `await sleep(30_000)` 就等于给
 * 测试套件加 30 秒；靠 `vi.useFakeTimers()` 又会连带把 Nest 内部的定时器一起劫持，
 * 引出一堆和被测行为无关的诡异现象。一个显式注入的时钟最干净。
 */
export class FakeClock implements Clock {
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

  /** 直接设定到某个时刻。 */
  setTo(ms: number): void {
    this.current = ms
  }
}
