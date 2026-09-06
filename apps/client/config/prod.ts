import type { UserConfigExport } from '@tarojs/cli'

/** 生产构建覆盖项：目前无需特殊处理，`baseURL` 同样来自 `TARO_APP_API_BASE`（构建时注入）。 */
export default {
  mini: {},
  h5: {},
} satisfies UserConfigExport<'webpack5'>
