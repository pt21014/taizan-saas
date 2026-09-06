// 照抄这份文件即可：所有 packages/apps 的 eslint.config.js 都应该只是这三行，
// 规则统一维护在 @taizan/eslint-config 里，不要在这里单独加规则。
import base from '@taizan/eslint-config'

export default [
  ...base,
  {
    ignores: ['dist/**', 'playwright-report/**', 'test-results/**'],
  },
]
