/**
 * Provider 注册表与配置解析（蓝图 §4.12）。
 *
 * 两件事分得很清楚：
 *
 * - **谁来收钱**（`PaymentProvider` 实现）由装配期决定，进 {@link ProviderRegistry}；
 * - **用哪套商户密钥收**（`ProviderConfig`）由请求期决定，走 {@link ProviderConfigResolver}。
 *
 * 拆开的理由是多租户：`WechatPayProvider` 全进程只有一个实例（它是无状态的），
 * 但 A 店和 B 店各有各的 `mchId` / 私钥 / apiV3Key。把配置塞进 Provider 实例
 * 就意味着每个租户一个实例——启动时还不知道有多少租户，运行时又要管实例生命周期。
 *
 * @packageDocumentation
 */

import { Inject, Injectable, Optional } from '@nestjs/common'
import type { CredentialVault } from '@taizan/crypto'
import { callOperation, PrismaService } from '@taizan/nest-prisma'
import {
  isPayChannel,
  PAYMENT_ERROR,
  PaymentError,
  type PayChannel,
  type PaymentProvider,
  type ProviderConfig,
} from '@taizan/payment-core'

import { PAYMENT_CREDENTIAL_VAULT, PAYMENT_PROVIDERS } from './tokens'

/**
 * 按渠道装配的 Provider 表。
 *
 * 重复渠道**直接抛**（不是后者覆盖前者）：两份微信配置同时装进来时，覆盖的表现是
 * 「下单走了 A 商户号、回调按 B 商户号验签」——钱进了 A 的账，系统认为没收到。
 */
@Injectable()
export class ProviderRegistry {
  // process-local: 装配期一次性建好的只读路由表，不是跨进程状态。
  private readonly byChannel = new Map<PayChannel, PaymentProvider>()

  constructor(@Optional() @Inject(PAYMENT_PROVIDERS) providers?: readonly PaymentProvider[]) {
    for (const provider of providers ?? []) this.register(provider)
  }

  /** 登记一个 Provider。 */
  register(provider: PaymentProvider): this {
    if (!isPayChannel(provider.channel)) {
      throw PaymentError.of(
        PAYMENT_ERROR.BAD_REQUEST,
        `[@taizan/nest-payment] Provider 的 channel "${String(provider.channel)}" 不是合法 PayChannel`,
      )
    }
    const existing = this.byChannel.get(provider.channel)
    if (existing) {
      throw PaymentError.of(
        PAYMENT_ERROR.BAD_REQUEST,
        `[@taizan/nest-payment] 渠道 ${provider.channel} 已经装配了 ${existing.constructor.name}，` +
          `不能再装 ${provider.constructor.name}（一个渠道只能有一个 Provider）`,
        { channel: provider.channel },
      )
    }
    this.byChannel.set(provider.channel, provider)
    return this
  }

  /** 这个渠道装了吗。 */
  has(channel: PayChannel): boolean {
    return this.byChannel.has(channel)
  }

  /** 已装配的渠道（按装配顺序）。启动日志/自检用。 */
  channels(): PayChannel[] {
    return [...this.byChannel.keys()]
  }

  /**
   * 取 Provider。
   *
   * @throws 没装配时抛 `PROVIDER_NOT_FOUND`。**不返回 undefined**——回调控制器拿到
   *   undefined 只会在下一行崩在 `.parseCallback of undefined` 上，那条报错看不出
   *   「是这个渠道没配」。
   */
  get(channel: PayChannel): PaymentProvider {
    const provider = this.byChannel.get(channel)
    if (!provider) {
      throw PaymentError.of(
        PAYMENT_ERROR.PROVIDER_NOT_FOUND,
        `[@taizan/nest-payment] 渠道 ${channel} 没有装配 Provider（已装配：${this.channels().join(', ') || '无'}）`,
        { channel },
      )
    }
    return provider
  }
}

/**
 * 「这次调用该用哪套商户密钥」。
 *
 * `tenantId` 缺省表示**平台自身收款**（套餐订单走的就是这条：钱进平台的账，
 * 和哪家店无关）。给了 `tenantId` 就是商家自己的商户号（C 端交易）。
 */
export interface ProviderConfigResolver {
  resolve(channel: PayChannel, tenantId?: string): Promise<ProviderConfig>
}

/**
 * 固定配置：装配时给死一份，永远返回它。
 *
 * 单渠道单商户的小项目、以及 e2e（`useFake: true` 的默认解析器）用它就够了。
 */
export class StaticProviderConfigResolver implements ProviderConfigResolver {
  constructor(private readonly byChannel: Partial<Record<PayChannel, ProviderConfig>> = {}) {}

  async resolve(channel: PayChannel, _tenantId?: string): Promise<ProviderConfig> {
    return this.byChannel[channel] ?? {}
  }
}

/**
 * `PayChannel` → `TenantCredential.provider` 的供应商标识。
 *
 * 取值与 `packages/prisma-base/schema/01-tenant.prisma` 里那行注释举的例子
 * （`wechat-pay` / `aliyun-sms` / `tencent-cos`）同一套命名法。
 */
export const CHANNEL_CREDENTIAL_PROVIDER: Readonly<Record<PayChannel, string>> = {
  WECHAT: 'wechat-pay',
  ALIPAY: 'alipay',
  DOUYIN: 'douyin-pay',
  OFFLINE: 'offline',
}

/** 平台自身收款配置在 `PlatformSetting.key` 里的前缀（例：`pay.wechat.`）。 */
export function platformSettingPrefix(channel: PayChannel): string {
  return `pay.${channel.toLowerCase()}.`
}

/** {@link DbProviderConfigResolver} 的选项。 */
export interface DbProviderConfigResolverOptions {
  /** 覆盖渠道 → 供应商标识的映射。 */
  credentialProviders?: Partial<Record<PayChannel, string>>
}

/**
 * 默认实现：租户级从 `TenantCredential` 读并用 vault 解密，平台级从 `PlatformSetting` 读。
 *
 * ## 密钥名怎么变成配置对象
 *
 * `credKey` 支持**点分路径**，`credentials.apiV3Key` 会被拼成
 * `{ credentials: { apiV3Key: '...' } }`——因为 `@taizan/wechatpay` 的
 * `narrowWechatPayConfig` 要的就是这个嵌套形状。平面的 `mode` / `appId` 直接落顶层。
 *
 * ## 为什么不缓存
 *
 * 商户密钥是**改一次就必须立刻生效**的东西（运营在后台换了私钥，下一笔就得用新的）。
 * 加缓存就得同时加失效通道，而失效通道漏掉一处的表现是「换完密钥回调全部验签失败」。
 * 支付本身是低频操作，每次多一次索引查询换来「所见即所得」，这笔账划算。
 */
@Injectable()
export class DbProviderConfigResolver implements ProviderConfigResolver {
  constructor(
    @Optional() @Inject(PrismaService) private readonly prisma?: PrismaService,
    @Optional() @Inject(PAYMENT_CREDENTIAL_VAULT) private readonly vault?: CredentialVault,
    private readonly options: DbProviderConfigResolverOptions = {},
  ) {}

  async resolve(channel: PayChannel, tenantId?: string): Promise<ProviderConfig> {
    const prisma = this.requirePrisma()
    return tenantId === undefined
      ? this.resolvePlatform(prisma, channel)
      : this.resolveTenant(prisma, channel, tenantId)
  }

  /** 租户自己的商户号：`TenantCredential`，密文列必须解密。 */
  private async resolveTenant(
    prisma: PrismaService,
    channel: PayChannel,
    tenantId: string,
  ): Promise<ProviderConfig> {
    const provider =
      this.options.credentialProviders?.[channel] ?? CHANNEL_CREDENTIAL_PROVIDER[channel]
    // raw-reason: 支付回调按参数定位租户（蓝图 §8 第 3 条）。回调进来时没有任何 token，
    // 租户是从 notifyUrl 的查询参数 / outTradeNo 反查出来的，此刻还没有租户上下文，
    // prisma.tenant 会直接抛 TenantScopeError。tenantId 由本方法显式写进 where。
    const rows = (await callOperation(prisma.raw as object, 'tenantCredential', 'findMany', {
      where: { tenantId, provider, deletedAt: null },
      select: { credKey: true, valueEnc: true, keyId: true },
    })) as { credKey: string; valueEnc: string; keyId: string }[] | null

    if (!rows || rows.length === 0) {
      throw PaymentError.of(
        PAYMENT_ERROR.CONFIG_INVALID,
        `[@taizan/nest-payment] 租户 ${tenantId} 没有配置 ${provider} 的商户密钥`,
        { tenantId, channel, provider },
      )
    }

    const vault = this.requireVault()
    const cfg: ProviderConfig = {}
    for (const row of rows) {
      assign(cfg, row.credKey, vault.decrypt(row.valueEnc, row.keyId))
    }
    return cfg
  }

  /** 平台自身收款（套餐订单）：`PlatformSetting`，明文在 `value`、密钥在 `valueEnc`。 */
  private async resolvePlatform(
    prisma: PrismaService,
    channel: PayChannel,
  ): Promise<ProviderConfig> {
    const prefix = platformSettingPrefix(channel)
    // raw-reason: PlatformSetting 是平台域表（没有 tenantId 列），属于「平台模块」这一处
    // 合法 raw 用途；平台自身收款的商户号本来就不归任何租户。
    const rows = (await callOperation(prisma.raw as object, 'platformSetting', 'findMany', {
      where: { key: { startsWith: prefix } },
      select: { key: true, value: true, valueEnc: true, keyId: true },
    })) as { key: string; value: unknown; valueEnc: string | null; keyId: string | null }[] | null

    if (!rows || rows.length === 0) {
      throw PaymentError.of(
        PAYMENT_ERROR.CONFIG_INVALID,
        `[@taizan/nest-payment] 平台没有配置 ${channel} 的收款参数（PlatformSetting.key 前缀 ${prefix}）`,
        { channel, prefix },
      )
    }

    const cfg: ProviderConfig = {}
    for (const row of rows) {
      const path = row.key.slice(prefix.length)
      if (path.length === 0) continue
      if (row.valueEnc) {
        if (!row.keyId) {
          // 密文没有配对 keyId 就永远解不开（蓝图 §8 第 11 条守的正是这件事）。
          throw PaymentError.of(
            PAYMENT_ERROR.CONFIG_INVALID,
            `[@taizan/nest-payment] PlatformSetting "${row.key}" 有 valueEnc 却没有 keyId`,
            { key: row.key },
          )
        }
        assign(cfg, path, this.requireVault().decrypt(row.valueEnc, row.keyId))
        continue
      }
      assign(cfg, path, row.value)
    }
    return cfg
  }

  private requirePrisma(): PrismaService {
    if (!this.prisma) {
      throw PaymentError.of(
        PAYMENT_ERROR.CONFIG_INVALID,
        '[@taizan/nest-payment] DbProviderConfigResolver 需要 PrismaService；' +
          '要么 imports 里带上 PrismaModule，要么给 PaymentModule.forRoot 传自己的 configResolver',
      )
    }
    return this.prisma
  }

  private requireVault(): CredentialVault {
    if (!this.vault) {
      throw PaymentError.of(
        PAYMENT_ERROR.CONFIG_INVALID,
        '[@taizan/nest-payment] 解密商户密钥需要 CredentialVault；' +
          '请给 PaymentModule.forRoot 传 vault（createVault({ keys, currentKeyId })）',
      )
    }
    return this.vault
  }
}

/** 把点分路径写进配置对象：`credentials.apiV3Key` → `{ credentials: { apiV3Key } }`。 */
function assign(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.').filter((s) => s.length > 0)
  if (segments.length === 0) return
  let cursor = target
  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = segments[i] as string
    const next = cursor[key]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      cursor[key] = {}
    }
    cursor = cursor[key] as Record<string, unknown>
  }
  cursor[segments[segments.length - 1] as string] = value
}
