/**
 * 微信网页授权的 state 签发/核销，与 `redirect_uri` 的安全重建。
 *
 * knowledge `CLAUDE.md` 第 7 条（蓝图 §9 不变量 7）原话：
 *
 * > **微信网页授权的 state 必须服务端签发 + 回调核销**（`OauthStateStore`：随机 32 字节、
 * > 5 分钟 TTL、一次性、绑定租户），前端另存一份做本地比对。少了这层校验，攻击者用自己账号的
 * > code 拼个链接就能让用户静默登录成他的账号。同理，`redirect_uri` 只取调用方给的 path+query，
 * > host 一律用当前请求的 Host 重建，避免开放重定向。
 *
 * 这一整个文件就是那句话的实现。两条不能动的地方：
 *
 * 1. **一次性靠 {@link OneTimeStore} 的 `takeOnce`（`GETDEL`，原子）**，不是先 get 再 del。
 *    两个进程可能同时 get 到同一个 state 都判为有效，而一次性正是它的全部意义
 *    （蓝图 §8 第 12 条：一次性凭据必须走 `takeOnce`）。接口上刻意不给 `get`，
 *    调用方想写错也写不出来。
 * 2. **state 必须存跨进程的地方**。knowledge 实测：pm2 开 4 个实例时，进程 A 签发的 state
 *    回调大概率落到进程 B，放进程内存就永远核销不了——**四次登录里约三次失败**。
 *    而表现极具迷惑性：微信那边授权成功、浏览器也乖乖跳回了首页，只是人没登上。
 *    所以 {@link MemoryOneTimeStore} 只给单机与单测用，生产必须换 Redis 实现。
 */

import { randomBytes } from 'node:crypto'
import { wechatOpenError } from './errors'
import type { Clock, OneTimeStore } from './types'

/** state 的 key 前缀。带前缀是为了在 Redis 里一眼看出这是什么，也便于按前缀清理 */
const STATE_PREFIX = 'wxoauth:state:'

/** 缺省 TTL：5 分钟。留给「人在微信里点一下同意」，不是留给机器 */
export const DEFAULT_STATE_TTL_SEC = 300

/** state 绑定的东西：**租户是输出，不是输入** */
export interface StatePayload {
  /** 这次授权属于哪个租户。回调落在平台域上，没有店铺上下文，认不出人来，只能靠它 */
  tenantId: string
  /** 授权完成后要回到的站内路径（已经过 {@link safeRedirectPath} 清洗） */
  redirectPath: string
}

export interface IssueStateInput {
  tenantId: string
  /** 调用方想回到哪儿。只接受站内 path+query，见 {@link safeRedirectPath} */
  redirectPath: string
  store: OneTimeStore
  /** 缺省 300 秒 */
  ttlSec?: number
  /** 随机源注入口，只为测试可复现；生产别传 */
  random?: (size: number) => Buffer
}

/**
 * 签发一个 state：随机 32 字节 → base64url → 连同 `{tenantId, redirectPath}` 存进
 * {@link OneTimeStore}，TTL 缺省 5 分钟。
 *
 * 32 字节不是随手写的：state 是唯一能证明「这次回调是我们发起的」的东西，
 * 猜中一个就等于能拼一条静默登录链接。
 */
export async function issueState(input: IssueStateInput): Promise<string> {
  const redirectPath = safeRedirectPath(input.redirectPath)
  const rand = input.random ?? randomBytes
  const state = rand(32).toString('base64url')
  const payload: StatePayload = { tenantId: input.tenantId, redirectPath }
  await input.store.put(
    STATE_PREFIX + state,
    JSON.stringify(payload),
    input.ttlSec ?? DEFAULT_STATE_TTL_SEC,
  )
  return state
}

/**
 * 核销一个 state：**取一次就删**，返回它绑定的 `{tenantId, redirectPath}`。
 *
 * 第二次拿同一个 state 来核销一定返回 `null`——不存在、已被用过、已过期，
 * 三种情况刻意合并成同一个结果：分开告诉调用方等于告诉攻击者「这个 state 存在过」。
 */
export async function consumeState(
  state: string | undefined | null,
  store: OneTimeStore,
): Promise<StatePayload | null> {
  if (!state) return null
  const raw = await store.takeOnce(STATE_PREFIX + state)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<StatePayload>
    if (!parsed || typeof parsed.tenantId !== 'string' || typeof parsed.redirectPath !== 'string') {
      return null
    }
    return { tenantId: parsed.tenantId, redirectPath: parsed.redirectPath }
  } catch {
    // 存进去的一定是本函数写的 JSON。解不出来说明有人往同一个 key 空间里写了别的，
    // 那就当它无效——不猜、不兜底
    return null
  }
}

/**
 * 断言核销回来的 state 确实属于当前租户，不符就抛。
 *
 * 为什么核销成功还要再判一次：`consumeState` 只回答「这个 state 是我们发的且没用过」，
 * 回答不了「是给这家店发的」。攻击者在自己的店里签一个合法 state，
 * 拿去 B 店的登录链接上用，`consumeState` 照样通过——**拿 A 店的 state 去 B 店换登录**。
 * 所以凡是「当前租户已知」的调用方（C 端登录就是）都必须再比一次；
 * 只有「租户是从 state 里读出来的」那种场景（商家授权回调）才不比。
 */
export function assertStateTenant(payload: StatePayload, expectedTenantId: string): StatePayload {
  if (payload.tenantId !== expectedTenantId) {
    throw wechatOpenError('STATE_TENANT_MISMATCH', {
      detail: `state 属于 ${payload.tenantId}，当前是 ${expectedTenantId}`,
    })
  }
  return payload
}

/**
 * 把调用方给的回跳目标清洗成**纯站内 path+query**。
 *
 * 只接受 `/` 开头、第二个字符不是 `/` 或 `\` 的路径。以下一律抛错，不做「尽力修复」：
 * - `https://evil.com/x`（带 scheme 的绝对地址）
 * - `//evil.com`（协议相对地址，浏览器当成绝对地址跳出去）
 * - `/\evil.com`、`/\/evil.com`（反斜杠变体，多数浏览器等价于 `//`）
 * - 带 `\r` `\n` 的（响应头注入）
 *
 * 抛错而不是「悄悄只保留 path」：能走到这儿的非法值都是代码写错或有人在打我们，
 * 两种都该在日志里留下痕迹，而不是被静默改写成一个能用的地址。
 * hash（`#...`）直接丢掉——它压根不会发到服务端，留着只会让人以为它有用。
 */
export function safeRedirectPath(input: string | undefined | null): string {
  const raw = (input ?? '').trim()
  if (!raw) return '/'
  if (/[\r\n\t\0]/.test(raw)) {
    throw wechatOpenError('UNSAFE_REDIRECT', { detail: '回跳路径里有控制字符' })
  }
  if (!raw.startsWith('/')) {
    throw wechatOpenError('UNSAFE_REDIRECT', {
      detail: `回跳路径必须以 / 开头，只能是站内 path+query，收到：${raw.slice(0, 120)}`,
    })
  }
  if (raw[1] === '/' || raw[1] === '\\') {
    throw wechatOpenError('UNSAFE_REDIRECT', {
      detail: `协议相对地址会跳出站外，拒绝：${raw.slice(0, 120)}`,
    })
  }
  const [pathAndQuery] = raw.split('#')
  return pathAndQuery || '/'
}

/**
 * 校验「当前请求的 Host」的形状：只能是 `host` 或 `host:port`。
 *
 * 带 scheme、带路径、带 `@`（userinfo，`evil.com@good.com` 这种）、带空白的一律拒绝。
 *
 * **调用方还有一件事要做**：Host 头是客户端可控的。这里只能保证它的形状不会污染
 * 拼出来的 URL，保证不了它就是我们自己的域名。生产环境应当在网关层固定 Host，
 * 或者在 app 侧比对一张允许的域名表之后再传进来。
 */
export function safeHost(host: string | undefined | null): string {
  const raw = (host ?? '').trim()
  if (!/^[a-zA-Z0-9.-]+(:\d{1,5})?$/.test(raw)) {
    throw wechatOpenError('UNSAFE_HOST', { detail: `Host 形状不合法：${raw.slice(0, 120)}` })
  }
  return raw
}

/** 网页授权可用的 scope。`snsapi_base` 只给 openid；要昵称头像得 `snsapi_userinfo` */
export type OAuthScope = 'snsapi_base' | 'snsapi_userinfo'

export interface BuildOAuthUrlInput {
  /** 发起授权的公众号 appId（授权类来源就是 authorizer_appid） */
  appId: string
  /** 已签发的 state */
  state: string
  /** **当前请求的 Host**，`redirect_uri` 的 host 只用它重建 */
  requestHost: string
  /** 调用方想回到的站内 path+query */
  redirectPath: string
  /** 缺省 `snsapi_userinfo`：没有昵称头像的学员在讨论区里是一排「微信用户」 */
  scope?: OAuthScope
  /** 缺省 `https`。只有本地联调才该传 `http` */
  protocol?: 'https' | 'http'
  /**
   * 第三方平台代授权时要带上 `component_appid`，否则微信不认。
   * 走商家自有 appSecret 那条路时不传。
   */
  componentAppId?: string
}

/**
 * 拼网页授权发起地址。
 *
 * **`redirect_uri` 的 host 一律用 `requestHost` 重建**，只从调用方那里取 path+query。
 * 这是不变量 7 的后半句：调用方传进来的哪怕是 `https://evil.com/x`，
 * 也只会得到 `https://<当前 Host>/x`——开放重定向在这里不可能发生
 * （实际上连 `/x` 都拿不到：{@link safeRedirectPath} 会先抛错，见 spec）。
 */
export function buildOAuthUrl(input: BuildOAuthUrlInput): string {
  const host = safeHost(input.requestHost)
  const path = safeRedirectPath(input.redirectPath)
  const protocol = input.protocol ?? 'https'
  const redirectUri = `${protocol}://${host}${path}`

  const q = new URLSearchParams({
    appid: input.appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: input.scope ?? 'snsapi_userinfo',
    state: input.state,
  })
  if (input.componentAppId) q.set('component_appid', input.componentAppId)
  // `#wechat_redirect` 是微信要求的固定后缀，少了它在微信里点开是一片空白
  return `https://open.weixin.qq.com/connect/oauth2/authorize?${q.toString()}#wechat_redirect`
}

export interface BuildAuthorizeUrlInput {
  componentAppId: string
  /** {@link import('./component').ComponentClient.preAuthCode} 现取的，**一次性、30 分钟** */
  preAuthCode: string
  /** 当前请求 Host，同样只用它重建回跳 host */
  requestHost: string
  /** 授权完成后微信回跳的站内路径（会带上 `auth_code` 与 `expires_in`） */
  redirectPath: string
  /** 1=公众号，2=小程序，3=两者都要（缺省） */
  authType?: 1 | 2 | 3
  /** 指定要授权的那个号（商家已知 appid 时传，能省掉他在列表里找） */
  bizAppId?: string
  protocol?: 'https' | 'http'
}

/**
 * 拼开放平台的**代授权页**地址（商家扫码/点击授权给平台的那一页）。
 *
 * 与 {@link buildOAuthUrl} 是两件事：那个是「学员登录」，这个是「商家把号授权给平台」。
 * 两者的 state 也是两套（knowledge 里就是 `OauthStateStore` 与 `WxAuthStateStore` 两个类），
 * **不要合并**：登录那边租户是输入（比对一致即可），授权这边租户是输出
 * （授权结果该落到哪个租户名下的唯一依据）。
 */
export function buildAuthorizeUrl(input: BuildAuthorizeUrlInput): string {
  const host = safeHost(input.requestHost)
  const path = safeRedirectPath(input.redirectPath)
  const protocol = input.protocol ?? 'https'
  const q = new URLSearchParams({
    component_appid: input.componentAppId,
    pre_auth_code: input.preAuthCode,
    redirect_uri: `${protocol}://${host}${path}`,
    auth_type: String(input.authType ?? 3),
  })
  if (input.bizAppId) q.set('biz_appid', input.bizAppId)
  return `https://mp.weixin.qq.com/cgi-bin/componentloginpage?${q.toString()}`
}

/**
 * {@link OneTimeStore} 的内存实现。
 *
 * **只够单机与单测**。cluster 下签发与核销大概率落在不同进程，永远核销不了——
 * knowledge 实测四次登录约三次失败。生产必须换成 Redis 的 `GETDEL` 实现
 * （app 侧用 `@taizan/nest-infra` 的 `CacheService.takeOnce` 适配，见 README）。
 *
 * 没有后台清扫定时器：裸 `setInterval` 在 cluster 下是被禁的（蓝图 §8 spec 12），
 * 而过期项在 `takeOnce` 里顺手判掉就够了——这里存的东西 5 分钟就过期，量也小。
 */
export class MemoryOneTimeStore implements OneTimeStore {
  // process-local: 内存实现的定义就是进程内，生产用 Redis GETDEL 实现替换
  private readonly rows = new Map<string, { value: string; expireAt: number }>()

  constructor(private readonly now: Clock = Date.now) {}

  async put(key: string, value: string, ttlSec: number): Promise<void> {
    this.rows.set(key, { value, expireAt: this.now() + ttlSec * 1000 })
  }

  async takeOnce(key: string): Promise<string | null> {
    const row = this.rows.get(key)
    // 取一次就删：不管过没过期都先删掉，让「已被用过」与「已过期」走同一条路
    this.rows.delete(key)
    if (!row) return null
    if (row.expireAt <= this.now()) return null
    return row.value
  }

  /** 只给测试看的：当前还存着几条 */
  get size(): number {
    return this.rows.size
  }
}
