/**
 * 蓝图 §8 **spec 12**：集群安全静态扫描。
 *
 * 守的是 knowledge 那条线上活故障：pm2 cluster 起 4 个进程之后，
 * `order-close.service.ts` / `profit-sharing.service.ts` 里的裸 `setInterval`
 * 变成了「同一笔订单被关 4 次、同一笔分账被发起 4 次」。那不是「浪费点 CPU」，
 * 是**重复的对外副作用**——钱真的多付了。
 *
 * 四条规则（判定在 `@taizan/nest-infra/testing` 的 `scanClusterSafety`，
 * 本文件只负责把 `apps/api/src` 喂给它）：
 *
 * | # | 规则 | 例外 |
 * |---|---|---|
 * | 1 | 禁止裸 `setInterval` / `setTimeout` 做调度 | 加 `// cluster-safe-allow: 理由` |
 * | 2 | 禁止 `@nestjs/schedule` 的 `@Cron` / `@Interval` / `@Timeout`，必须 `@LeaderCron` | 无 |
 * | 3 | 一次性凭据（state / nonce / ticket / once）禁止 `get(`，必须 `takeOnce` | 加 allow 标记 |
 * | 4 | 长驻的 `new Map()` / `new Set()` 必须标 `// process-local: 理由` | 无 |
 *
 * ## 为什么用框架包里的扫描器而不是自己写正则
 *
 * 同 spec 5 / spec 6 的取舍：规则漂移了就等于没守。生成器产出的项目里会有一份
 * **一模一样**的 spec（T4-2），两边共用同一个扫描器，规则改一次两边一起变。
 *
 * ## 规则 4 是个启发式，它的错误方向是安全的
 *
 * 扫描器只认「模块级 const/let/var」与「缩进 2 的类字段」两种形状。
 * 误报只是逼人写一行注释说明为什么这份状态可以每进程各存一份；
 * 漏报才会出事故（缓存不一致、限流额度 × 进程数）。所以宁可误报。
 */

import { collectSourceFiles, formatViolations, scanClusterSafety } from '@taizan/nest-infra/testing'
import { describe, expect, it } from 'vitest'

import { SRC_DIR } from './_helpers'

/**
 * 允许出现调度定时器的文件（后缀匹配）。
 *
 * **现在一条都没有**，这正是想要的状态：`apps/api` 里所有定时执行都该走
 * `@LeaderCron`，所有延迟投递都该走 `QueueService.add({ delayMs })`。
 * 真需要一次性超时（比如给一次外部 HTTP 调用加个 deadline），
 * 在那一行上方写 `// cluster-safe-allow: <理由>` 即可，不必动这份白名单——
 * 白名单是**整个文件**的豁免，粒度太粗。
 */
const TIMER_ALLOWLIST: readonly string[] = []

const files = collectSourceFiles(SRC_DIR)
const violations = scanClusterSafety(files, { timerAllowlist: TIMER_ALLOWLIST })

describe('spec 12：集群安全（多实例下不重复执行）', () => {
  it('哨兵：扫描器本身没坏（四条规则各造一个反例）', () => {
    const sentinel = scanClusterSafety(
      [
        {
          path: 'sentinel.ts',
          content: [
            'setInterval(() => close(), 30000)',
            '@Cron("0 * * * *")',
            'const s = await redis.get(`oauth:state:${x}`)',
            'const CACHE = new Map<string, string>()',
          ].join('\n'),
        },
      ],
      { timerAllowlist: [] },
    )
    expect(sentinel.map((v) => v.rule).sort()).toEqual([
      'nest-cron',
      'process-local',
      'take-once',
      'timer',
    ])
  })

  it('哨兵：注释里举反例不算违规（文档要能自由地写「不要这样写」）', () => {
    const sentinel = scanClusterSafety(
      [{ path: 'doc.ts', content: '// 不要写 setInterval(fn, 1000)\n * @Cron("* * * * *")' }],
      { timerAllowlist: [] },
    )
    expect(sentinel).toEqual([])
  })

  it('真的扫到了源码（一个都没扫到会让下面全绿）', () => {
    expect(files.length).toBeGreaterThanOrEqual(30)
    expect(files.some((f) => f.path.endsWith('.controller.ts'))).toBe(true)
  })

  it('零违规', () => {
    expect(violations.length, `\n${formatViolations(violations)}\n`).toBe(0)
  })

  it('定时器白名单是空的（有了第一条就该有人停下来想一想）', () => {
    expect(
      TIMER_ALLOWLIST,
      'apps/api 里不该有任何调度定时器：周期执行用 @LeaderCron，延迟投递用 QueueService。' +
        '一次性超时请用行级的 // cluster-safe-allow 标记，别整个文件豁免。',
    ).toEqual([])
  })
})
