/**
 * 跨端选图适配：小程序走 `Taro.chooseImage`（支持相机/相册来源）；H5 浏览器没有
 * “相机/相册”这层区分，也不是所有壳子都支持 `sourceType`，这里退化成只用相册选择器
 * （`sourceType: ['album']`），避免在部分浏览器里因为不支持 `camera` 而整体失败。
 *
 * @packageDocumentation
 */

import Taro from '@tarojs/taro'

/** {@link chooseImage} 的入参：与 `Taro.chooseImage` 对齐，`count` 默认 1。 */
export interface ChooseImageParams {
  count?: number
  sizeType?: Array<'original' | 'compressed'>
  sourceType?: Array<'album' | 'camera'>
}

/** {@link chooseImage} 的返回结果：本地临时文件路径列表。 */
export interface ChooseImageResult {
  tempFilePaths: string[]
}

/** 统一签名：调用方不需要关心 `process.env.TARO_ENV`。 */
export async function chooseImage(params: ChooseImageParams = {}): Promise<ChooseImageResult> {
  const count = params.count ?? 1
  const sizeType = params.sizeType ?? ['compressed', 'original']
  const sourceType: Array<'album' | 'camera'> =
    process.env.TARO_ENV === 'weapp' ? (params.sourceType ?? ['album', 'camera']) : ['album']

  const res = await Taro.chooseImage({ count, sizeType, sourceType })
  return { tempFilePaths: res.tempFilePaths }
}
