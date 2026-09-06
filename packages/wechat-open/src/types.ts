/**
 * `@taizan/wechat-open` 的公共类型与注入契约。
 *
 * 这个包**零框架依赖**：不 import NestJS、不 import ioredis、不 import Prisma，
 * 甚至不 import `@taizan/contracts`。理由是它承载的是一批「错了不会报错」的逻辑
 * （加解密、签名、state 核销、来源优先级），必须能在裸 node 里跑单测；
 * 一旦挂上框架，测试就要先起容器，而那意味着这些用例迟早会被跳过。
 *
 * 所有需要 IO 的地方都收成接口注入：{@link HttpClient}、{@link TokenCache}、
 * {@link TicketStore}、{@link OneTimeStore}。包内自带内存实现（够单机与单测用），
 * 生产实现由 app 侧用 `@taizan/nest-infra` 适配（`CacheService.takeOnce` /
 * `RedisService.takeOnce` / `CacheService`），见 README。
 */

/**
 * HTTP 出口。由 app 侧注入（`fetch` 包一层、undici、或带链路追踪的 client）。
 *
 * 微信这套接口**永远回 HTTP 200**，成功失败都在 body 的 `errcode` 里——
 * 实现方只要把 JSON body 原样返回即可，不要因为「看到 200 就当成功」而吞掉错误；
 * 非 2xx 时应当抛错。超时也由实现方负责（建议 10s）。
 */
export interface HttpClient {
  get<T = unknown>(url: string, headers?: Record<string, string>): Promise<T>
  post<T = unknown>(url: string, body?: unknown, headers?: Record<string, string>): Promise<T>
}

/**
 * 第三方平台（开放平台）自身的配置。
 *
 * `appSecret` 是**平台级**密钥，只该出现在服务端环境变量里。
 * 租户级的凭据（商家自填的公众号 appSecret、中转站 client_secret）走另一条路：
 * 由 app 侧用 `@taizan/crypto` 的 `CredentialVault` 从 `TenantCredential` 表解密后
 * **作为参数传进来**，本包不认识 vault、也不该认识——加解密与「谁能解」是两件事。
 */
export interface ComponentConfig {
  /** 第三方平台 appid，同时也是消息加解密里的 receiveId */
  appId: string
  /** 第三方平台 appsecret */
  appSecret: string
  /** 消息校验 Token（开放平台后台填的那个） */
  token: string
  /** EncodingAESKey，43 位 base64 */
  aesKey: string
}

/** 授权方的类型：微信用 `MiniProgramInfo` 字段的有无来区分公众号与小程序 */
export type AuthorizerKind = 'MP' | 'MINI'

/** 授权方（已授权给平台的商家公众号/小程序）的资料 */
export interface AuthorizerInfo {
  appId: string
  kind: AuthorizerKind
  nickname: string | null
  headImg: string | null
  principalName: string | null
  /** 微信号原始 ID（`gh_` 开头） */
  userName: string | null
  qrcodeUrl: string | null
  /** 授权给平台的权限集 id 列表 */
  funcInfo: number[]
}

/** `api_query_auth` 换回来的授权结果 */
export interface AuthorizationResult {
  authorizerAppId: string
  authorizerAccessToken: string
  /** **必须落库**：旧的会在若干次刷新后失效，届时表现是「用了很久突然全部失败」 */
  authorizerRefreshToken: string
  expiresIn: number
  funcInfo: number[]
}

/** 刷新授权方 token 的结果 */
export interface AuthorizerTokenResult {
  accessToken: string
  /** 微信**可能**在这里下发一个新的 refresh_token，拿到就必须存 */
  refreshToken: string | null
  expiresIn: number
}

/**
 * 「这家店的公众号该用谁的」——四级来源。
 *
 * 做成可辨识联合而不是「secret 可空」：走第三方平台代调用时根本没有 appSecret，
 * code 换 openid 要调另一个接口。漏判一处就会把空串当密钥发出去，
 * 微信只回一句 invalid appsecret，看不出是哪条路走错了。
 */
export type MpSourceKind =
  /** 1. 租户自有公众号：商家自己填的 appId + appSecret，平台代持密钥 */
  | 'TENANT_OWN'
  /** 2. 租户授权给平台的号：第三方平台代调用，平台**拿不到**他的 appSecret */
  | 'TENANT_AUTHORIZED'
  /** 3. 平台代运营的号：平台以第三方平台身份代某个主体运营，租户借用 */
  | 'PLATFORM_AUTHORIZED'
  /** 4. 平台自有公众号：平台自己的资产，**需平台超管为这家店开通**才可用 */
  | 'PLATFORM_OWN'

/** 一条候选来源。`appId` 是四种都有的唯一共同字段 */
export interface MpSource {
  kind: MpSourceKind
  appId: string
  /**
   * 明文 appSecret。只有 `TENANT_OWN` / `PLATFORM_OWN` 才有；
   * 授权类（`*_AUTHORIZED`）恒为 `null`——那条路上用 component_access_token 代签。
   */
  appSecret?: string | null
  /** 授权类来源的 refresh_token（已由 app 侧解密） */
  authorizerRefreshToken?: string | null
  /** 中转站接入项目凭据。只做登录，**中转站不给 access_token** */
  relay?: { clientId: string; clientSecret: string } | null
  /** 这条来源属于哪个租户（平台侧来源为 null），排查串号时要有 */
  tenantId?: string | null
  /**
   * 闸门：这条来源当前是否允许这家店使用。
   *
   * 平台自有号默认 **false**——平台公众号是平台的资产，学员在里面授权、openid 也归平台，
   * 商家换成自己的号时那批 openid 跨不过去。让每家新店默认躺在平台号上，
   * 等于替他做了一个以后很难改回的决定。缺省当 `true`（自有/授权类天然可用）。
   */
  enabled?: boolean
}

/** 一份缓存住的 token。`expiresAt` 是**绝对毫秒时间戳**，不是剩余秒数 */
export interface CachedToken {
  value: string
  expiresAt: number
}

/**
 * token 缓存。生产实现必须是**跨进程共享**的（Redis）。
 *
 * 微信这几个 access_token 都是「取新的会把旧的挤掉」：每个进程各取一份的话，
 * 它们会互相把对方的 token 作废，表现是接口**间歇性**报 40001——最难查的那种。
 */
export interface TokenCache {
  get(key: string): Promise<CachedToken | null>
  set(key: string, token: CachedToken, ttlSec: number): Promise<void>
  del(key: string): Promise<void>
}

/**
 * `component_verify_ticket` 的存储。
 *
 * 微信每 10 分钟推一次，是整条链路的源头。生产实现应当**加密落库**
 * （`@taizan/crypto` + `TenantCredential` 同一套路子），不要只放内存：
 * 重启后最长要等 10 分钟才有新的，那 10 分钟里所有代商家的接口全不可用。
 */
export interface TicketStore {
  save(componentAppId: string, ticket: string): Promise<void>
  load(componentAppId: string): Promise<string | null>
  /** 平台后台要看「第三方平台通不通」，靠的就是最近一次收到 ticket 的时间 */
  status(componentAppId: string): Promise<{ has: boolean; updatedAt: Date | null }>
}

/**
 * 一次性凭据存储（蓝图 §8 第 12 条：一次性凭据必须走 `takeOnce`）。
 *
 * 只有两个方法，且**没有 `get`**——这是刻意的。先 `get` 再 `del` 的写法在多进程下
 * 会让同一个 state 被两个进程都判为有效，而一次性正是它的全部意义。
 * 接口上不给 `get`，就没人能写出那种实现的调用方。
 *
 * 生产实现：app 侧用 `@taizan/nest-infra` 的 `CacheService.takeOnce`（`GETDEL`，原子）适配。
 */
export interface OneTimeStore {
  put(key: string, value: string, ttlSec: number): Promise<void>
  /** 取一次就删。取不到（不存在 / 已被用过 / 已过期）一律返回 `null` */
  takeOnce(key: string): Promise<string | null>
}

/** 单调时钟注入口，缺省 `Date.now`。测 TTL 与提前刷新时必须能拨表 */
export type Clock = () => number
