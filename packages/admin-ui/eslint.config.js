// 照抄这份文件即可：所有 packages/apps 的 eslint.config.js 都应该只是这三行，
// 规则统一维护在 @taizan/eslint-config 里，不要在这里单独加规则。
import base from '@taizan/eslint-config'

export default [
  ...base,
  {
    // demo/ 是最小演示应用，不进 dist、不参与包的 build/typecheck，但仍希望格式统一。
    ignores: ['demo/dist/**'],
  },
]
