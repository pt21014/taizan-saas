/**
 * `component_verify_ticket` 的接收与存储——三级凭据链的**源头**。
 *
 * 链路是三级，每一级都依赖上一级：
 * ```
 * component_verify_ticket（微信每 10 分钟主动推给我们）
 *   → component_access_token（2 小时，平台级）
 *     → authorizer_access_token（2 小时，每个商家一份）
 * ```
 *
 * 最上游的 ticket 是**推过来的、不是拉取的**，这决定了两件事：
 * 1. 开放平台后台的「授权事件接收 URL」没配好 = 整条链路一个都拿不到，
 *    而现象只是接口报错，看不出根因。所以这里的错误信息必须直接点名它。
 * 2. 新部署的服务最长要等 10 分钟才有 ticket，属正常，不是故障。
 */

import { openMsg, xmlField } from './msg-crypt'
import type { ComponentConfig, TicketStore } from './types'

/**
 * 授权事件推送的类型。刻意留成 `string` 而不是字面量联合：
 * 微信随时会加新的 InfoType，收到没见过的应当忽略，而不是让类型系统逼调用方穷举。
 * 已知值：`component_verify_ticket` / `authorized` / `unauthorized` / `updateauthorized`。
 */
export type ComponentPushInfoType = string

/** 解出来的一条授权事件推送 */
export interface ComponentPush {
  infoType: ComponentPushInfoType
  /** `component_verify_ticket` 事件才有 */
  ticket: string | null
  /** 授权 / 取消授权事件才有 */
  authorizerAppId: string | null
  /** `authorized` 事件带的授权码，可直接拿去 `queryAuth` */
  authorizationCode: string | null
  createTime: string | null
  /** 明文 XML 原文，事件类型太多，调用方要自己再取字段时用 */
  xml: string
}

/**
 * 解一条授权事件推送：验签 → 解密 → 取字段。
 *
 * 传进来的是**原始请求体**（加密 XML）与 URL 上的三个参数。控制器那边必须拿到
 * raw body 才能算签名——过一遍 JSON 解析器就没了。
 */
export function parseComponentPush(input: {
  config: ComponentConfig
  rawBody: string
  msgSignature: string
  timestamp: string
  nonce: string
}): ComponentPush {
  const encrypt = xmlField(input.rawBody, 'Encrypt') ?? ''
  const xml = openMsg({
    config: input.config,
    encrypt,
    msgSignature: input.msgSignature,
    timestamp: input.timestamp,
    nonce: input.nonce,
  })
  return {
    infoType: xmlField(xml, 'InfoType') ?? '',
    ticket: xmlField(xml, 'ComponentVerifyTicket'),
    authorizerAppId: xmlField(xml, 'AuthorizerAppid'),
    authorizationCode: xmlField(xml, 'AuthorizationCode'),
    createTime: xmlField(xml, 'CreateTime'),
    xml,
  }
}

/**
 * 收到推送就覆盖存一份。ticket 每次都不同，**永远以最新的为准**。
 *
 * 换了新 ticket 不必让手上的 access_token 失效——它在自己的有效期内照常能用。
 */
export async function receiveTicket(
  store: TicketStore,
  componentAppId: string,
  ticket: string,
): Promise<void> {
  if (!ticket) return
  await store.save(componentAppId, ticket)
}

/**
 * {@link TicketStore} 的内存实现。
 *
 * 只够单机与单测：进程一重启就没了，**cluster 下各进程各存一份**（问题不大，
 * ticket 是广播给每个进程的……并不是——微信只 POST 一次，只有接住那一次的进程有）。
 * 生产必须换成加密落库的实现。
 */
export class MemoryTicketStore implements TicketStore {
  // process-local: 内存实现本来就是「只够单机与单测」的退路，生产用落库实现替换
  private readonly rows = new Map<string, { ticket: string; updatedAt: Date }>()

  constructor(private readonly now: () => number = Date.now) {}

  async save(componentAppId: string, ticket: string): Promise<void> {
    this.rows.set(componentAppId, { ticket, updatedAt: new Date(this.now()) })
  }

  async load(componentAppId: string): Promise<string | null> {
    return this.rows.get(componentAppId)?.ticket ?? null
  }

  async status(componentAppId: string): Promise<{ has: boolean; updatedAt: Date | null }> {
    const row = this.rows.get(componentAppId)
    return { has: Boolean(row), updatedAt: row?.updatedAt ?? null }
  }
}
