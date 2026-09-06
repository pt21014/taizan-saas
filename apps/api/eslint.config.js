// 照抄 packages/_smoke 的形状：规则统一维护在 @taizan/eslint-config，这里只做本 app 的忽略。
import base from '@taizan/eslint-config'

export default [
  ...base,
  {
    ignores: ['dist/**', 'prisma/migrations/**'],
  },
]
