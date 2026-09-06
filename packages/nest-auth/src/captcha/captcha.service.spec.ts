/** `CaptchaService` 单测（用例⑬：一次性核销）。 */

import { beforeEach, describe, expect, it } from 'vitest'
import { InMemoryAuthRedis } from '../redis'
import { FakeClock } from '../testing/fake-clock'
import { captchaKey, CaptchaService, CAPTCHA_TTL_SEC } from './captcha.service'

let clock: FakeClock
let redis: InMemoryAuthRedis
let captcha: CaptchaService

/** 从 Redis 里偷看答案（只有测试能这么干）。 */
async function answerOf(id: string): Promise<string | null> {
  return redis.get(captchaKey(id))
}

beforeEach(() => {
  clock = new FakeClock()
  redis = new InMemoryAuthRedis(() => clock.now())
  captcha = new CaptchaService(redis)
})

describe('出图', () => {
  it('回一个 26 位 id 和一段合法 SVG', async () => {
    const { id, svg } = await captcha.issue()
    expect(id).toHaveLength(26)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
  })

  it('默认 4 个字符，且都在剔除易混字符后的表里', async () => {
    const { id } = await captcha.issue()
    const answer = (await answerOf(id)) as string
    expect(answer).toHaveLength(4)
    // 剔除的是 0 o 1 l i 2 z 5 s（大小写），它们一个都不该出现。
    expect(/[0o1li2z5s]/.test(answer)).toBe(false)
  })

  it('两次出图的 id 不同、答案独立', async () => {
    const a = await captcha.issue()
    const b = await captcha.issue()
    expect(a.id).not.toBe(b.id)
    expect(await answerOf(a.id)).not.toBeNull()
    expect(await answerOf(b.id)).not.toBeNull()
  })

  it('字符数可配', async () => {
    const { id } = await captcha.issue({ length: 6 })
    expect((await answerOf(id)) as string).toHaveLength(6)
  })
})

describe('核销（用例⑬）', () => {
  it('答对一次通过；同一个 id 再用一次就不行了', async () => {
    const { id } = await captcha.issue()
    const answer = (await answerOf(id)) as string

    expect(await captcha.verify(id, answer)).toBe(true)
    expect(await captcha.verify(id, answer)).toBe(false)
  })

  it('答错也销毁——否则同一个 id 就能被逐个字符组合试过去', async () => {
    const { id } = await captcha.issue()
    const answer = (await answerOf(id)) as string

    expect(await captcha.verify(id, 'zzzz')).toBe(false)
    // 现在就算答对了也没用，这张已经作废。
    expect(await captcha.verify(id, answer)).toBe(false)
    expect(await answerOf(id)).toBeNull()
  })

  it('并发提交同一个 id，最多只有一个通过', async () => {
    const { id } = await captcha.issue()
    const answer = (await answerOf(id)) as string
    const results = await Promise.all([captcha.verify(id, answer), captcha.verify(id, answer)])
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('不区分大小写，且忽略首尾空格（用户从输入法带过来的）', async () => {
    const { id } = await captcha.issue()
    const answer = (await answerOf(id)) as string
    expect(await captcha.verify(id, `  ${answer.toUpperCase()} `)).toBe(true)
  })

  it('5 分钟后过期', async () => {
    const { id } = await captcha.issue()
    const answer = (await answerOf(id)) as string
    clock.advanceSeconds(CAPTCHA_TTL_SEC + 1)
    expect(await captcha.verify(id, answer)).toBe(false)
  })

  it('id / code 为空或非字符串一律 false，不抛错', async () => {
    expect(await captcha.verify(undefined, 'x')).toBe(false)
    expect(await captcha.verify('x', undefined)).toBe(false)
    expect(await captcha.verify('', '')).toBe(false)
    expect(await captcha.verify(123, 456)).toBe(false)
  })

  it('不存在的 id 直接 false（不泄漏「这个 id 存在过吗」）', async () => {
    expect(await captcha.verify('01JZZZZZZZZZZZZZZZZZZZZZZZ', 'abcd')).toBe(false)
  })
})
