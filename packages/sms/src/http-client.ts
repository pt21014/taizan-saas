/**
 * 本包不 import axios/fetch 之外的任何 HTTP 库，也不直接用全局 `fetch`——
 * 让调用方决定用什么发请求（Node 内置 fetch、axios、还是测试里的假实现），
 * 这样纯签名逻辑可以在裸 node 环境里跑单测，不需要真的发请求出去。
 */
export interface HttpResponse {
  status: number
  body: string
}

/** 极简 HTTP 客户端接口：本包只用得到 POST。 */
export interface HttpClient {
  post(url: string, body: string, headers: Record<string, string>): Promise<HttpResponse>
}
