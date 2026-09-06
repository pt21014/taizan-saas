/**
 * 本包不 import axios、不直接依赖任何网络库——直传（presigned PUT）与预签名 GET
 * 场景下调用方（浏览器/小程序/App）自己发请求，本包只负责"签出"URL；唯一需要
 * 服务端真正发请求的是 `putObject`（服务端中转上传，例如商品图后端二次处理后
 * 落库），这类调用走这里的 {@link HttpClient}。
 */
export interface HttpResponse {
  status: number
  body: string
  headers?: Record<string, string>
}

/** 极简 HTTP 客户端接口：本包用得到 PUT/GET/POST。 */
export interface HttpClient {
  request(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD',
    url: string,
    body: Buffer | string | undefined,
    headers: Record<string, string>,
  ): Promise<HttpResponse>
}
