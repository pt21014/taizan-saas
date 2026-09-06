/**
 * 一号多店登录的中间态：手机号 + 口令答对了，但服务端不签 token，让前端先选店
 * （`AdminAuthService.login` 的文档就是这么写的——先签一个进 A 店再换到 B 店，
 * 等于每次登录都白建一次会话）。选店页要带着这两项再打一次登录接口，
 * 但**不通过 `expo-router` 的 params 传密码**（那会进 URL/浏览器历史，web 导出尤其明显），
 * 只在内存里过一手，选完或返回登录页就清掉。
 */
let pending: { phone: string; password: string } | null = null

export function setPendingLogin(value: { phone: string; password: string }): void {
  pending = value
}

export function getPendingLogin(): { phone: string; password: string } | null {
  return pending
}

export function clearPendingLogin(): void {
  pending = null
}
