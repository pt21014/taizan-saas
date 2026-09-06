// 照抄仓库其它包的三行形状；规则统一维护在 @taizan/eslint-config。
import base from '@taizan/eslint-config'

export default [
  ...base,
  {
    // templates/ 是 build-templates.ts 从 apps/ 快照出来的产物：里面是 .hbs
    // 与原样拷贝的源码，既不该被 lint（它们不在本包的 tsconfig 里），
    // 也不该被 lint 的自动修复动到（一改就与 manifest 的 sha256 对不上）。
    ignores: ['dist/**', 'templates/**', '.tmp/**'],
  },
]
