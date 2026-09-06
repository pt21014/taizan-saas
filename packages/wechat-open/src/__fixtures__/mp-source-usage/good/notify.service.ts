// 用例夹具：一个「委托方」。要凭据就问 MpTokenService，自己不判一遍。
export class MpTokenService {
  async tokenOf(_tenantId: string): Promise<string> {
    return 'token'
  }
}

export async function sendTemplate(tokens: MpTokenService, tenantId: string): Promise<string> {
  return tokens.tokenOf(tenantId)
}
