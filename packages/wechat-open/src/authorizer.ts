/**
 * 授权方（已授权给平台的商家公众号/小程序）相关的三个接口。
 *
 * 搬自 knowledge `infra/wechat-open/authorizer.service.ts`，只留纯调用与字段整理，
 * **落库不在这里**：授权结果该写哪张表、写不写 `prisma.raw`、同一个 appid 换绑要不要拦，
 * 都是 app 侧的事（那边才知道 `WxAuthorizer` 表长什么样、租户从哪来）。
 * 本包只负责「跟微信说话」这一段。
 *
 * 从 knowledge 带过来但**必须由 app 侧接住**的两条规矩，写在这里免得被忘掉：
 * 1. 一个公众号只能归属一家店。同一个 appid 换了租户要拦——否则 A 店的学员会在
 *    B 店的公众号里登录，两边的 openid 还是同一批人，数据看起来对得上，实际已经串了。
 * 2. 取消授权**只标记不删**：删了之后商家问「我上周授权的那个号呢」就查无此事，
 *    而取消授权可能是他在公众平台误点的。
 */

import { wechatOpenError } from './errors'
import type { AuthorizationResult, AuthorizerInfo, AuthorizerTokenResult } from './types'

/**
 * 本模块只需要「能发一次带 component_access_token 的 POST」这一件能力。
 *
 * 收成接口而不是直接 import `ComponentClient`，是为了不和 `component.ts` 形成循环依赖
 * （那边要调这里的 {@link refreshAuthorizerToken}）。顺带也让这三个函数能单独测。
 */
export interface ComponentApi {
  post<T>(path: string, body: Record<string, unknown>, opts?: { withToken?: boolean }): Promise<T>
}

interface RawAuthorizationInfo {
  authorizer_appid?: string
  authorizer_access_token?: string
  authorizer_refresh_token?: string
  expires_in?: number
  func_info?: { funcscope_category?: { id?: number } }[]
}

function funcIdsOf(list: RawAuthorizationInfo['func_info']): number[] {
  return (list ?? [])
    .map((f) => f.funcscope_category?.id)
    .filter((id): id is number => typeof id === 'number')
}

/**
 * 用商家授权后带回的 `auth_code` 换这个商家的调用凭据与权限集。
 *
 * auth_code 一次性、3 分钟过期。换回来的 `authorizer_refresh_token` **必须落库**，
 * 它是之后两小时一换 access_token 的唯一依据。
 */
export async function queryAuth(api: ComponentApi, authCode: string): Promise<AuthorizationResult> {
  const res = await api.post<{ authorization_info?: RawAuthorizationInfo }>('api_query_auth', {
    authorization_code: authCode,
  })
  const info = res.authorization_info
  if (!info?.authorizer_appid || !info.authorizer_refresh_token) {
    throw wechatOpenError('AUTH_CODE_INVALID')
  }
  return {
    authorizerAppId: info.authorizer_appid,
    authorizerAccessToken: info.authorizer_access_token ?? '',
    authorizerRefreshToken: info.authorizer_refresh_token,
    expiresIn: info.expires_in ?? 7200,
    funcInfo: funcIdsOf(info.func_info),
  }
}

interface RawAuthorizerInfo {
  authorizer_info?: {
    nick_name?: string
    head_img?: string
    principal_name?: string
    user_name?: string
    qrcode_url?: string
    MiniProgramInfo?: unknown
  }
  authorization_info?: RawAuthorizationInfo
}

/**
 * 拉授权方的资料（昵称、头像、主体名、二维码），用来在后台显示「授权的是哪个号」。
 *
 * 微信用 `MiniProgramInfo` 字段的有无来区分公众号与小程序——没有别的判据。
 *
 * 调用方注意：**拉不到资料不该让整次授权失败**，凭据已经拿到了，资料只是拿来显示的。
 */
export async function getAuthorizerInfo(
  api: ComponentApi,
  authorizerAppId: string,
): Promise<AuthorizerInfo> {
  const res = await api.post<RawAuthorizerInfo>('api_get_authorizer_info', {
    authorizer_appid: authorizerAppId,
  })
  const p = res.authorizer_info ?? {}
  return {
    appId: authorizerAppId,
    kind: p.MiniProgramInfo ? 'MINI' : 'MP',
    nickname: p.nick_name ?? null,
    headImg: p.head_img ?? null,
    principalName: p.principal_name ?? null,
    userName: p.user_name ?? null,
    qrcodeUrl: p.qrcode_url ?? null,
    funcInfo: funcIdsOf(res.authorization_info?.func_info),
  }
}

/**
 * 用 refresh_token 换一份新的 `authorizer_access_token`。
 *
 * 返回里的 `refreshToken` 可能是新的一份——**拿到就必须存**。
 * 缓存与「存哪儿」都不在这里，见 `ComponentClient.authorizerAccessToken`。
 */
export async function refreshAuthorizerToken(
  api: ComponentApi,
  input: { authorizerAppId: string; refreshToken: string },
): Promise<AuthorizerTokenResult> {
  const res = await api.post<{
    authorizer_access_token?: string
    authorizer_refresh_token?: string
    expires_in?: number
  }>('api_authorizer_token', {
    authorizer_appid: input.authorizerAppId,
    authorizer_refresh_token: input.refreshToken,
  })
  if (!res.authorizer_access_token) {
    throw wechatOpenError('API_FAILED', {
      message: '获取授权方调用凭据失败，请让商家重新授权一次',
    })
  }
  return {
    accessToken: res.authorizer_access_token,
    refreshToken: res.authorizer_refresh_token ?? null,
    expiresIn: res.expires_in ?? 7200,
  }
}

/**
 * 代授权方发起网页授权时，用 code 换 openid。
 *
 * 与商家自己配 appSecret 那条路的差别只在这个接口：这里用 component_access_token 代签，
 * **平台始终拿不到商家的 appSecret**——这正是走第三方平台的意义。
 */
export async function componentSnsToken(
  input: {
    http: { get<T>(url: string, headers?: Record<string, string>): Promise<T> }
    componentAppId: string
    componentAccessToken: string
    authorizerAppId: string
    code: string
  },
  apiBase = 'https://api.weixin.qq.com',
): Promise<{ openid: string; unionid: string | null; accessToken: string | null }> {
  const url =
    `${apiBase.replace(/\/$/, '')}/sns/oauth2/component/access_token` +
    `?appid=${encodeURIComponent(input.authorizerAppId)}` +
    `&code=${encodeURIComponent(input.code)}` +
    '&grant_type=authorization_code' +
    `&component_appid=${encodeURIComponent(input.componentAppId)}` +
    `&component_access_token=${encodeURIComponent(input.componentAccessToken)}`
  const res = await input.http.get<{
    openid?: string
    unionid?: string
    access_token?: string
    errcode?: number
    errmsg?: string
  }>(url)
  if (!res.openid) {
    throw wechatOpenError('API_FAILED', {
      errcode: res.errcode ?? null,
      message: `code 换 openid 失败（${res.errcode ?? '无 openid'}）：${res.errmsg ?? ''}`,
    })
  }
  return { openid: res.openid, unionid: res.unionid ?? null, accessToken: res.access_token ?? null }
}
