/**
 * 敏感字段加密（进件、分账接收方等接口用）。
 *
 * 姓名、身份证号、银行卡号、手机号这类字段微信不接受明文，直接传会被回一句
 * 「请确认待处理的消息是否为加密后的密文」。算法是 **RSAES-OAEP(SHA-1) + 微信支付公钥**，
 * base64 输出；请求头还必须带 `Wechatpay-Serial` = 所用公钥的 ID / 证书序列号，
 * 微信要靠它选对私钥来解——少了这个头，密文是对的也解不开。
 *
 * 搬自 xiaodian `libs/wechatpay/src/sign.ts` 的 `rsaEncryptOaep` / `selectEncryptPem`
 * 与 knowledge `v3-sign.ts` 的 `encryptSensitive`（两者算法一致，node 的
 * `RSA_PKCS1_OAEP_PADDING` 默认 oaepHash 就是 sha1，这里显式写出来免得将来 node 改默认值）。
 */
import { constants as cryptoConstants, publicEncrypt } from 'node:crypto'

import { PAYMENT_ERROR, PaymentError } from '@taizan/payment-core'

import { toPublicKey } from './sign'
import type { WechatPayCredentials } from './types'

/**
 * 用微信支付公钥（或平台证书里的公钥）加密一个敏感字段。
 *
 * OAEP 带随机填充，**同一明文每次密文都不同**——所以密文不能拿来当缓存键，
 * 也不能用「密文相等」判断两条记录是不是同一个人。
 */
export function rsaEncryptOaep(plaintext: string, certOrPublicKeyPem: string): string {
  return publicEncrypt(
    {
      key: toPublicKey(certOrPublicKeyPem),
      padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha1',
    },
    Buffer.from(plaintext, 'utf8'),
  ).toString('base64')
}

/** {@link selectEncryptPem} 的结果：加密用的公钥 PEM 与要放进 `Wechatpay-Serial` 头的序列号。 */
export interface EncryptTarget {
  serial: string
  pem: string
}

/**
 * 选出敏感字段加密用的公钥（优先微信支付公钥，回落平台证书）。
 *
 * 优先新版是因为平台证书会过期轮换，用它加密的请求在证书换代那天会突然开始失败。
 */
export function selectEncryptPem(cred: WechatPayCredentials): EncryptTarget | null {
  if (cred.publicKeyId && cred.publicKeyPem) {
    return { serial: cred.publicKeyId, pem: cred.publicKeyPem }
  }
  if (cred.platformSerialNo && cred.platformCertPem) {
    return { serial: cred.platformSerialNo, pem: cred.platformCertPem }
  }
  return null
}

/**
 * 拿到一个「加密函数 + 序列号」的组合，供 `buildApplymentBody` 这类纯函数使用。
 *
 * @throws 两套公钥都没配时抛 `CONFIG_INVALID`——**不静默降级成明文**：
 * 明文提交进件会被微信拒，而报错信息只会说「消息未加密」，指不到是配置缺失。
 */
export function createFieldEncryptor(cred: WechatPayCredentials): {
  serial: string
  encrypt: (plaintext: string) => string
} {
  const target = selectEncryptPem(cred)
  if (!target) {
    throw PaymentError.of(
      PAYMENT_ERROR.CONFIG_INVALID,
      '[@taizan/wechatpay] 敏感字段加密需要「微信支付公钥」或「平台证书」，两套都没配',
    )
  }
  return {
    serial: target.serial,
    encrypt: (plaintext: string) => rsaEncryptOaep(plaintext, target.pem),
  }
}
