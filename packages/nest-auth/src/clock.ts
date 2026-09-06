/**
 * 可注入的时钟。
 *
 * 缓存过期、token 过期这类逻辑必须能在测试里**推进时间**而不是真的 sleep 30 秒。
 * 只有 `now()` 一个方法，够用且不给自己留发挥空间。
 */
export interface Clock {
  /** 当前毫秒时间戳。 */
  now(): number
}

/** 生产用的系统时钟。 */
export const systemClock: Clock = {
  now: () => Date.now(),
}
