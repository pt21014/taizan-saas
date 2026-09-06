/**
 * 大陆手机号校验与脱敏。
 *
 * 只认 1[3-9]开头的 11 位号码——这是当前大陆号段分配的公开规则，不含 +86 前缀
 * （前缀由各 provider 自己在拼接请求时加，不同厂商要求的写法不一样：
 * 腾讯云要 `+86xxxxxxxxxxx`，阿里云直接传 11 位）。
 */
const CN_MOBILE = /^1[3-9]\d{9}$/

/** 是否是合法的大陆手机号（11 位，不含区号/国际前缀）。 */
export function isValidCnPhone(phone: string): boolean {
  return CN_MOBILE.test(phone)
}

/**
 * 校验，不合法则抛。
 *
 * @throws phone 不是 11 位大陆手机号时抛
 */
export function assertValidCnPhone(phone: string): void {
  if (!isValidCnPhone(phone)) {
    throw new Error(`[@taizan/sms] 不是合法的大陆手机号：${maskPhone(phone)}`)
  }
}

/** 脱敏：保留前 3 后 4，中间 4 位替换成 `****`。用于日志与 NotifyRecord.to。 */
export function maskPhone(phone: string): string {
  if (phone.length !== 11) return phone.replace(/./g, '*')
  return `${phone.slice(0, 3)}****${phone.slice(7)}`
}
