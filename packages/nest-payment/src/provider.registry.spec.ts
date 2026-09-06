import 'reflect-metadata'
import { createVault } from '@taizan/crypto'
import {
  createFakePrisma,
  type FakePrismaClient,
  type FakePrismaControls,
} from '@taizan/nest-prisma/testing'
import type { PrismaService } from '@taizan/nest-prisma'
import { FakeProvider, PAYMENT_ERROR, PaymentError } from '@taizan/payment-core'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  DbProviderConfigResolver,
  platformSettingPrefix,
  ProviderRegistry,
  StaticProviderConfigResolver,
} from './provider.registry'

const KEY = 'a'.repeat(64)
const vault = createVault({ keys: { k1: KEY }, currentKeyId: 'k1' })

describe('ProviderRegistry', () => {
  it('按渠道取 Provider', () => {
    const wechat = new FakeProvider({ channel: 'WECHAT' })
    const alipay = new FakeProvider({ channel: 'ALIPAY' })
    const registry = new ProviderRegistry([wechat, alipay])

    expect(registry.channels()).toEqual(['WECHAT', 'ALIPAY'])
    expect(registry.get('ALIPAY')).toBe(alipay)
    expect(registry.has('DOUYIN')).toBe(false)
  })

  it('同一渠道装两个 Provider 直接抛（覆盖 = 下单走 A、验签用 B）', () => {
    expect(() => new ProviderRegistry([new FakeProvider(), new FakeProvider()])).toThrow(
      /渠道 WECHAT 已经装配/,
    )
  })

  it('没装配的渠道抛 PROVIDER_NOT_FOUND 而不是返回 undefined', () => {
    const registry = new ProviderRegistry([])
    expect(() => registry.get('WECHAT')).toThrow(/没有装配 Provider/)
    try {
      registry.get('WECHAT')
      expect.unreachable('应该抛 PROVIDER_NOT_FOUND')
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentError)
      expect((err as PaymentError).code).toBe(PAYMENT_ERROR.PROVIDER_NOT_FOUND.code)
    }
  })
})

describe('StaticProviderConfigResolver', () => {
  it('给死一份配置，没配的渠道回空对象', async () => {
    const resolver = new StaticProviderConfigResolver({ WECHAT: { appId: 'wx1' } })
    await expect(resolver.resolve('WECHAT')).resolves.toEqual({ appId: 'wx1' })
    await expect(resolver.resolve('ALIPAY')).resolves.toEqual({})
  })
})

describe('DbProviderConfigResolver', () => {
  let client: FakePrismaClient
  let controls: FakePrismaControls
  let resolver: DbProviderConfigResolver

  beforeEach(() => {
    ;({ client, controls } = createFakePrisma())
    resolver = new DbProviderConfigResolver(
      { raw: client, tenant: client } as unknown as PrismaService,
      vault,
    )
  })

  it('租户级：从 TenantCredential 读、用 vault 解密、点分 credKey 拼成嵌套配置', async () => {
    const enc = (plain: string): { valueEnc: string; keyId: string } => vault.encrypt(plain)
    controls.on('TenantCredential', 'findMany', () => [
      { credKey: 'mode', ...enc('DIRECT') },
      { credKey: 'appId', ...enc('wxappid') },
      { credKey: 'credentials.mchId', ...enc('1900009191') },
      { credKey: 'credentials.apiV3Key', ...enc('QyeFGD5fS4NWO3zwSCingv56HAoXhFma') },
    ])

    const cfg = await resolver.resolve('WECHAT', 'T1')

    expect(cfg).toEqual({
      mode: 'DIRECT',
      appId: 'wxappid',
      credentials: { mchId: '1900009191', apiV3Key: 'QyeFGD5fS4NWO3zwSCingv56HAoXhFma' },
    })
    // 必须按 tenantId + provider 精确过滤，且排掉软删的行。
    expect(controls.callsOf('TenantCredential', 'findMany')[0]?.args).toMatchObject({
      where: { tenantId: 'T1', provider: 'wechat-pay', deletedAt: null },
    })
  })

  it('租户没配商户密钥 → CONFIG_INVALID（而不是拿一份空配置去调渠道）', async () => {
    controls.on('TenantCredential', 'findMany', () => [])
    await expect(resolver.resolve('WECHAT', 'T1')).rejects.toMatchObject({
      code: PAYMENT_ERROR.CONFIG_INVALID.code,
    })
  })

  it('平台级：不传 tenantId 时读 PlatformSetting，明文走 value、密钥走 valueEnc', async () => {
    const secret = vault.encrypt('QyeFGD5fS4NWO3zwSCingv56HAoXhFma')
    controls.on('PlatformSetting', 'findMany', () => [
      { key: 'pay.wechat.mode', value: 'DIRECT', valueEnc: null, keyId: null },
      { key: 'pay.wechat.appId', value: 'wx-platform', valueEnc: null, keyId: null },
      {
        key: 'pay.wechat.credentials.apiV3Key',
        value: null,
        valueEnc: secret.valueEnc,
        keyId: secret.keyId,
      },
    ])

    const cfg = await resolver.resolve('WECHAT')

    expect(cfg).toEqual({
      mode: 'DIRECT',
      appId: 'wx-platform',
      credentials: { apiV3Key: 'QyeFGD5fS4NWO3zwSCingv56HAoXhFma' },
    })
    expect(controls.callsOf('PlatformSetting', 'findMany')[0]?.args).toMatchObject({
      where: { key: { startsWith: platformSettingPrefix('WECHAT') } },
    })
  })

  it('valueEnc 没有配对 keyId → 抛（蓝图 §8 第 11 条：换完密钥读不出来的根因）', async () => {
    controls.on('PlatformSetting', 'findMany', () => [
      { key: 'pay.wechat.credentials.apiV3Key', value: null, valueEnc: 'v1.xx', keyId: null },
    ])
    await expect(resolver.resolve('WECHAT')).rejects.toThrow(/有 valueEnc 却没有 keyId/)
  })

  it('没有 vault 时给一句能直接照做的错，而不是 undefined.decrypt', async () => {
    const noVault = new DbProviderConfigResolver({
      raw: client,
      tenant: client,
    } as unknown as PrismaService)
    controls.on('TenantCredential', 'findMany', () => [
      { credKey: 'appId', valueEnc: 'v1.xx', keyId: 'k1' },
    ])
    await expect(noVault.resolve('WECHAT', 'T1')).rejects.toThrow(/需要 CredentialVault/)
  })

  it('没有 PrismaService 时同理', async () => {
    await expect(new DbProviderConfigResolver().resolve('WECHAT')).rejects.toThrow(
      /需要 PrismaService/,
    )
  })
})
