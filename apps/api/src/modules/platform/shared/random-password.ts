/**
 * 平台后台各处「不给初始口令就随机生成一个」共用的小工具。
 *
 * 抽到这里是因为 T0-8 的 `tenant/platform-tenant.service.ts`（开店给店主）与 T1-7 新增的
 * 平台管理员创建/改密、重置店主口令都要这同一段逻辑——同一段逻辑散在三处，
 * 其中一处哪天调整了长度/字符集而其余两处没跟着改，就会出现「同一个产品里
 * 初始口令强度不一致」这种没人会主动去发现的漂移。
 *
 * @packageDocumentation
 */

/**
 * 生成一个供线下告知的一次性初始口令。
 *
 * 不用加密强度随机：这是一次性初始口令，收到的人首次登录后应当改掉。
 * 但也不要短到能被在线爆破——12 位 base36 约 62 bit。
 *
 * ## 为什么要显式保证「至少一个字母 + 至少一个数字」
 *
 * T1-8 之后建店走 `@taizan/provision` 的 `assertOwnerPasswordPolicy`，它要求
 * 「字母 / 数字 / 符号里至少两类」。纯 base36 随机 12 位有约 **2.2%** 的概率
 * 抽到全字母（(26/36)^12），也就是说平台后台每开五十家店就会有一家在
 * 「不给初始口令」这条分支上莫名其妙地失败一次——而那种概率性失败在 CI 上
 * 表现为「偶发 flaky」，最难查。所以这里把两类字符钉死，而不是指望运气。
 */
export function randomPassword(): string {
  const letters = 'abcdefghijkmnpqrstuvwxyz'
  const digits = '23456789'
  const all = letters + digits
  const pick = (set: string): string => set[Math.floor(Math.random() * set.length)] as string

  const chars = [pick(letters), pick(digits), ...Array.from({ length: 10 }, () => pick(all))]
  // 洗牌，免得「第一位一定是字母、第二位一定是数字」成为一条可利用的规律。
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[chars[i], chars[j]] = [chars[j] as string, chars[i] as string]
  }
  return chars.join('')
}
