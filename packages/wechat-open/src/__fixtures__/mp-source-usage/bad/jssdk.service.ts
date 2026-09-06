// 用例夹具：**故意违规**。绕开 resolveMpSource 直接读平台凭据——
// 这种绕开不报错（签名合法、接口通），只是那家店本不该用这个号。
import { platformMp } from '../good/mp.config'

export function signShare(): string {
  return `${platformMp.appId}:${platformMp.appSecret}`
}
