import { describe, expect, it } from 'vitest'
import { tokens, toAntdTheme } from '@taizan/tokens'

describe('toAntdTheme(tokens)', () => {
  it('产出的 token 覆盖 TaizanConfigProvider 依赖的关键键', () => {
    const theme = toAntdTheme(tokens)

    const requiredKeys = [
      'colorPrimary',
      'colorSuccess',
      'colorWarning',
      'colorError',
      'colorInfo',
      'colorTextBase',
      'colorBgBase',
      'borderRadius',
      'fontFamily',
      'fontSize',
    ] as const

    for (const key of requiredKeys) {
      expect(theme.token, `theme.token.${key}`).toHaveProperty(key)
      expect(theme.token[key]).toBeTruthy()
    }
  })
})
