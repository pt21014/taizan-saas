// 用例夹具：允许直接读平台凭据的那一处（配置文件本身）。
export const platformMp = { appId: 'wxplatform', appSecret: 'secret' }

export function platformCredential(): { appId: string; appSecret: string } {
  return { appId: platformMp.appId, appSecret: platformMp.appSecret }
}
