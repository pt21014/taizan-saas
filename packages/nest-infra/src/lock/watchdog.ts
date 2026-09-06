/**
 * 锁续期看门狗。
 *
 * 长任务的两难：TTL 设短了，任务还没跑完锁就过期，另一个实例接管 → 同一个任务跑两遍；
 * TTL 设长了，持有者进程崩溃后要等很久才有人接管 → 任务在这段时间里根本不跑。
 * watchdog 的解法是「短 TTL + 活着就续期」：TTL 只需要覆盖住一次续期周期，
 * 进程一崩，续期立刻停止，锁在一个 TTL 内自动释放。
 *
 * 续期周期取 `ttl/3`：至少要能连丢两次续期（网络抖动）还不至于让锁过期。
 *
 * @packageDocumentation
 */

/** 续期动作：返回 `false` 表示锁已经不是自己的了（易主或已过期）。 */
export type RenewFn = () => Promise<boolean>

/** 看门狗句柄。 */
export interface WatchdogHandle {
  /** 停止续期。**必须在 finally 里调用**，否则定时器会一直活着。 */
  stop(): void
  /** 期间是否发生过「锁已易主」。调用方据此决定要不要把结果作废。 */
  readonly lost: boolean
}

/**
 * 起一个续期看门狗。
 *
 * @param ttlMs - 锁的 TTL
 * @param renew - 续期动作（内部用 Lua 比对 token）
 * @param onLost - 检测到锁易主时的回调（只会调一次）
 */
export function startWatchdog(ttlMs: number, renew: RenewFn, onLost?: () => void): WatchdogHandle {
  const intervalMs = Math.max(50, Math.floor(ttlMs / 3))
  let lost = false
  let stopped = false

  // cluster-safe-allow: 锁续期看门狗本身就是定时器；它不调度业务，只在持有锁期间续命
  const timer = setInterval(() => {
    void (async () => {
      if (stopped) return
      let ok = false
      try {
        ok = await renew()
      } catch {
        // 续期失败按「这一轮没续上」处理：下一轮还会再试，真丢了会由 ok=false 那条分支兜住。
        ok = true
      }
      if (!ok && !lost) {
        lost = true
        onLost?.()
      }
    })()
  }, intervalMs)

  // 不要因为一个后台续期定时器就把进程钉住不退出。
  timer.unref?.()

  return {
    stop(): void {
      stopped = true
      clearInterval(timer)
    },
    get lost(): boolean {
      return lost
    },
  }
}
