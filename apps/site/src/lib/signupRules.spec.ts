import { describe, expect, it } from 'vitest'
import {
  assertOwnerPasswordPolicy,
  isProvisionError,
  validateSlug as realValidateSlug,
} from '@taizan/provision'
import { checkPasswordPolicy, validateSlug } from './signupRules'

/**
 * `signupRules.ts` 现在是 `@taizan/provision` 主入口的薄适配层（不再手抄一份规则），
 * 所以这里不再做「手抄件 vs 真实包」的行为级 diff——`validateSlug === realValidateSlug`
 * 之类的比对会是同义反复。只剩两件事值得断言：
 *
 * 1. 重新导出的确实是**同一个函数**，不是某次重构手滑又抄回了一份实现；
 * 2. {@link checkPasswordPolicy} 是这个文件唯一自己写的逻辑（把 `throw` 转成
 *    不抛错的判定），这一层转换本身需要测。
 */
describe('signupRules：@taizan/provision 主入口的薄适配层', () => {
  it('validateSlug 重新导出的是同一个函数引用', () => {
    expect(validateSlug).toBe(realValidateSlug)
  })

  const passwordSamples = [
    '',
    '1234567',
    '12345678',
    'aaaaaaaa',
    'abcdefgh',
    'abcd1234',
    'ABCD1234!!',
    'a'.repeat(70),
  ]

  it.each(passwordSamples)(
    'checkPasswordPolicy(%j) 与 assertOwnerPasswordPolicy 的 throw/message 语义一致',
    (raw) => {
      const mine = checkPasswordPolicy(raw)
      let realOk = true
      try {
        assertOwnerPasswordPolicy(raw)
      } catch (error) {
        realOk = false
        if (!mine.ok && isProvisionError(error)) {
          expect(mine.message).toBe(error.message)
        }
      }
      expect(mine.ok).toBe(realOk)
    },
  )
})
