// 照抄 packages/admin-ui/eslint.config.js：规则统一维护在 @taizan/eslint-config 里。
import base from '@taizan/eslint-config'

export default [
  ...base,
  {
    ignores: ['playwright-report/**', 'test-results/**'],
  },
]
