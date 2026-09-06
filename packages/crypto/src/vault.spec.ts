import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { DecryptError, InvalidKeyError, UnknownKeyIdError } from './errors'
import { CIPHER_VERSION, createVault, isEncryptedValue, maskSecret } from './vault'

const K1 = 'a'.repeat(64)
const K2 = 'b'.repeat(64)
const K3 = randomBytes(32).toString('hex')

function vault(currentKeyId = 'k1') {
  return createVault({ keys: { k1: K1, k2: K2 }, currentKeyId })
}

describe('createVault 密钥表校验', () => {
  it('密钥表为空时抛 InvalidKeyError', () => {
    expect(() => createVault({ keys: {}, currentKeyId: 'k1' })).toThrow(InvalidKeyError)
  })

  it('密钥不是 64 hex 时抛错并指出是哪个 keyId', () => {
    let caught: unknown
    try {
      createVault({ keys: { k1: K1, kbad: 'zz' }, currentKeyId: 'k1' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(InvalidKeyError)
    expect((caught as InvalidKeyError).keyId).toBe('kbad')
    expect((caught as Error).message).toContain('kbad')
  })

  it('密钥格式错误的报错里不回显密钥内容', () => {
    const secretish = 'f'.repeat(63) // 63 位，差一位
    let message = ''
    try {
      createVault({ keys: { k1: secretish }, currentKeyId: 'k1' })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).not.toContain(secretish)
    expect(message).toContain('64 位 hex')
  })

  it('63 位与 65 位 hex 都不接受', () => {
    expect(() => createVault({ keys: { k1: 'a'.repeat(63) }, currentKeyId: 'k1' })).toThrow(
      InvalidKeyError,
    )
    expect(() => createVault({ keys: { k1: 'a'.repeat(65) }, currentKeyId: 'k1' })).toThrow(
      InvalidKeyError,
    )
  })

  it('含非 hex 字符（64 长度）也不接受', () => {
    expect(() => createVault({ keys: { k1: 'g'.repeat(64) }, currentKeyId: 'k1' })).toThrow(
      InvalidKeyError,
    )
  })

  it('大写 hex 可以接受（与 env.schema.ts 的 [0-9a-fA-F] 一致）', () => {
    expect(() => createVault({ keys: { k1: 'A'.repeat(64) }, currentKeyId: 'k1' })).not.toThrow()
  })

  it('currentKeyId 不在 keys 里时抛错并列出可用 keyId', () => {
    let message = ''
    try {
      createVault({ keys: { k1: K1 }, currentKeyId: 'k9' })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('k9')
    expect(message).toContain('k1')
  })

  it('currentKeyId 为空串时抛错', () => {
    expect(() => createVault({ keys: { k1: K1 }, currentKeyId: '' })).toThrow(InvalidKeyError)
  })

  it('keyIds 暴露的是 keyId 列表而不是密钥内容', () => {
    const v = vault()
    expect(v.keyIds).toEqual(['k1', 'k2'])
    expect(JSON.stringify(v.keyIds)).not.toContain(K1)
  })
})

describe('encrypt / decrypt 往返', () => {
  it('往返能拿回原文', () => {
    const v = vault()
    const { valueEnc, keyId } = v.encrypt('wx_secret_1234567890')
    expect(v.decrypt(valueEnc, keyId)).toBe('wx_secret_1234567890')
  })

  it('encrypt 回的 keyId 就是 currentKeyId', () => {
    const v = vault('k2')
    expect(v.encrypt('x').keyId).toBe('k2')
  })

  it('密文格式是 v1: 四段', () => {
    const { valueEnc } = vault().encrypt('hello')
    const parts = valueEnc.split(':')
    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe(CIPHER_VERSION)
    expect(Buffer.from(parts[1] ?? '', 'base64')).toHaveLength(12)
    expect(Buffer.from(parts[2] ?? '', 'base64')).toHaveLength(16)
  })

  it('同一明文两次加密密文不同（IV 随机），但都能解回原文', () => {
    const v = vault()
    const a = v.encrypt('same-plaintext')
    const b = v.encrypt('same-plaintext')
    expect(a.valueEnc).not.toBe(b.valueEnc)
    expect(v.decrypt(a.valueEnc, a.keyId)).toBe('same-plaintext')
    expect(v.decrypt(b.valueEnc, b.keyId)).toBe('same-plaintext')
  })

  it('空串明文可加可解', () => {
    const v = vault()
    const { valueEnc, keyId } = v.encrypt('')
    expect(v.decrypt(valueEnc, keyId)).toBe('')
  })

  it('中文与 emoji 往返不乱码', () => {
    const v = vault()
    const plain = '微信支付密钥·测试🔐'
    const { valueEnc, keyId } = v.encrypt(plain)
    expect(v.decrypt(valueEnc, keyId)).toBe(plain)
  })

  it('长明文（8KB 私钥 PEM 量级）往返正常', () => {
    const v = vault()
    const plain = 'A'.repeat(8192)
    const { valueEnc, keyId } = v.encrypt(plain)
    expect(v.decrypt(valueEnc, keyId)).toBe(plain)
  })

  it('encryptWith 可以指定非 current 的 keyId', () => {
    const v = vault('k1')
    const { valueEnc, keyId } = v.encryptWith('x', 'k2')
    expect(keyId).toBe('k2')
    expect(v.decrypt(valueEnc, 'k2')).toBe('x')
  })

  it('encryptWith 用未知 keyId 抛 UnknownKeyIdError', () => {
    expect(() => vault().encryptWith('x', 'k9')).toThrow(UnknownKeyIdError)
  })

  it('非字符串明文抛 TypeError（避免 [object Object] 被静默加密）', () => {
    // @ts-expect-error 故意传错类型
    expect(() => vault().encrypt({ a: 1 })).toThrow(TypeError)
  })
})

describe('decrypt 的失败分支', () => {
  it('keyId 不在密钥表里抛 UnknownKeyIdError', () => {
    const v = vault()
    const { valueEnc } = v.encrypt('x')
    let caught: unknown
    try {
      v.decrypt(valueEnc, 'k9')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(UnknownKeyIdError)
    expect((caught as UnknownKeyIdError).keyId).toBe('k9')
  })

  it('用错密钥（k2 解 k1 的密文）抛 DecryptError 而不是拿到脏数据', () => {
    const v = vault()
    const { valueEnc } = v.encryptWith('x', 'k1')
    expect(() => v.decrypt(valueEnc, 'k2')).toThrow(DecryptError)
  })

  it('篡改密文正文抛 DecryptError', () => {
    const v = vault()
    const { valueEnc, keyId } = v.encrypt('tamper-me-please')
    const parts = valueEnc.split(':')
    const data = Buffer.from(parts[3] ?? '', 'base64')
    data[0] = (data[0] ?? 0) ^ 0xff
    parts[3] = data.toString('base64')
    expect(() => v.decrypt(parts.join(':'), keyId)).toThrow(DecryptError)
  })

  it('篡改 tag 抛 DecryptError', () => {
    const v = vault()
    const { valueEnc, keyId } = v.encrypt('tamper-tag')
    const parts = valueEnc.split(':')
    const tag = Buffer.from(parts[2] ?? '', 'base64')
    tag[0] = (tag[0] ?? 0) ^ 0xff
    parts[2] = tag.toString('base64')
    expect(() => v.decrypt(parts.join(':'), keyId)).toThrow(DecryptError)
  })

  it('篡改 IV 抛 DecryptError', () => {
    const v = vault()
    const { valueEnc, keyId } = v.encrypt('tamper-iv')
    const parts = valueEnc.split(':')
    const iv = Buffer.from(parts[1] ?? '', 'base64')
    iv[0] = (iv[0] ?? 0) ^ 0xff
    parts[1] = iv.toString('base64')
    expect(() => v.decrypt(parts.join(':'), keyId)).toThrow(DecryptError)
  })

  it('解密失败的错误信息不含明文，也不含密文全文', () => {
    const v = vault()
    const plain = '明文不该出现在日志里'
    const { valueEnc, keyId } = v.encrypt(plain)
    const parts = valueEnc.split(':')
    const data = Buffer.from(parts[3] ?? '', 'base64')
    data[0] = (data[0] ?? 0) ^ 0xff
    parts[3] = data.toString('base64')
    const broken = parts.join(':')
    let message = ''
    try {
      v.decrypt(broken, keyId)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).not.toContain(plain)
    expect(message).not.toContain(broken)
    expect(message).not.toContain(K1)
  })

  it('空密文抛 DecryptError', () => {
    expect(() => vault().decrypt('', 'k1')).toThrow(DecryptError)
  })

  it('段数不对（三段）抛 DecryptError', () => {
    expect(() => vault().decrypt('v1:aaa:bbb', 'k1')).toThrow(/四段/)
  })

  it('未来版本前缀 v2: 抛 DecryptError 并指出版本', () => {
    const v = vault()
    const { valueEnc, keyId } = v.encrypt('x')
    const bumped = `v2${valueEnc.slice(2)}`
    expect(() => v.decrypt(bumped, keyId)).toThrow(/v2/)
  })

  it('IV 长度不对抛 DecryptError', () => {
    const v = vault()
    const { valueEnc, keyId } = v.encrypt('x')
    const parts = valueEnc.split(':')
    parts[1] = Buffer.alloc(8).toString('base64')
    expect(() => v.decrypt(parts.join(':'), keyId)).toThrow(/IV 长度/)
  })

  it('tag 长度不对抛 DecryptError', () => {
    const v = vault()
    const { valueEnc, keyId } = v.encrypt('x')
    const parts = valueEnc.split(':')
    parts[2] = Buffer.alloc(8).toString('base64')
    expect(() => v.decrypt(parts.join(':'), keyId)).toThrow(/认证标签长度/)
  })
})

describe('mask 脱敏', () => {
  it('32 位 secret 只露前 4 后 4', () => {
    const secret = '0123456789abcdef0123456789abcdef'
    expect(vault().mask(secret)).toBe(`0123${'*'.repeat(24)}cdef`)
  })

  it('空串返回空串', () => {
    expect(maskSecret('')).toBe('')
  })

  it('短于 head+tail+2（9 位）的值全打星', () => {
    expect(maskSecret('123456789')).toBe('*********')
    expect(maskSecret('ab')).toBe('**')
  })

  it('刚好 head+tail+2 = 10 位时留头留尾', () => {
    expect(maskSecret('0123456789')).toBe('0123**6789')
  })

  it('中文按码点切，不会劈成半个字', () => {
    // 12 个汉字：留前 4 后 4，中间 4 个星
    expect(maskSecret('微信支付密钥测试串一二三')).toBe('微信支付****串一二三')
  })

  it('中文短串全打星且长度按字数算', () => {
    expect(maskSecret('密钥')).toBe('**')
  })

  it('emoji 不会被劈成代理对的一半', () => {
    const masked = maskSecret('🔐🔐🔐🔐middle🔐🔐🔐🔐')
    expect(Array.from(masked).slice(0, 4).join('')).toBe('🔐🔐🔐🔐')
    expect(Array.from(masked).slice(-4).join('')).toBe('🔐🔐🔐🔐')
  })

  it('自定义 head/tail 生效', () => {
    expect(maskSecret('0123456789abcdef', { head: 2, tail: 2 })).toBe(`01${'*'.repeat(12)}ef`)
  })

  it('head=0 tail=0 时全打星', () => {
    expect(maskSecret('0123456789', { head: 0, tail: 0 })).toBe('**********')
  })

  it('负数 head 抛 RangeError', () => {
    expect(() => maskSecret('0123456789', { head: -1 })).toThrow(RangeError)
  })

  it('脱敏结果长度与原文码点数一致（不泄漏「变短了」以外的信息）', () => {
    const secret = 'x'.repeat(40)
    expect(maskSecret(secret)).toHaveLength(40)
  })
})

describe('isEncrypted', () => {
  it('认得自己加出来的密文', () => {
    const v = vault()
    expect(v.isEncrypted(v.encrypt('x').valueEnc)).toBe(true)
  })

  it('空明文加出来的密文也认得（data 段可以为空）', () => {
    const v = vault()
    expect(v.isEncrypted(v.encrypt('').valueEnc)).toBe(true)
  })

  it('历史明文不认', () => {
    expect(isEncryptedValue('wx_plain_secret')).toBe(false)
  })

  it('裸 base64（xiaodian 的老格式）不认', () => {
    expect(isEncryptedValue(Buffer.from('anything').toString('base64'))).toBe(false)
  })

  it('非字符串一律不认', () => {
    expect(isEncryptedValue(null)).toBe(false)
    expect(isEncryptedValue(undefined)).toBe(false)
    expect(isEncryptedValue(123)).toBe(false)
    expect(isEncryptedValue({})).toBe(false)
  })

  it('段数够但版本号不对不认', () => {
    expect(isEncryptedValue('v2:a:b:c')).toBe(false)
  })

  it('iv 或 tag 段为空不认', () => {
    expect(isEncryptedValue('v1::b:c')).toBe(false)
    expect(isEncryptedValue('v1:a::c')).toBe(false)
  })
})

describe('needsRotation 与多密钥共存', () => {
  it('k1 加密后配置 k1+k2 且 current=k2 时仍可解，且 k1 需要轮换', () => {
    // 轮换前：只有 k1
    const before = createVault({ keys: { k1: K1 }, currentKeyId: 'k1' })
    const { valueEnc, keyId } = before.encrypt('tenant-api-v3-key')
    expect(keyId).toBe('k1')

    // 轮换期：新增 k2 并切成 current，老密文照样读得出来
    const after = createVault({ keys: { k1: K1, k2: K2 }, currentKeyId: 'k2' })
    expect(after.decrypt(valueEnc, 'k1')).toBe('tenant-api-v3-key')
    expect(after.needsRotation('k1')).toBe(true)
    expect(after.needsRotation('k2')).toBe(false)
    // 新写入的行直接落在 k2 上
    expect(after.encrypt('new-row').keyId).toBe('k2')
  })

  it('needsRotation 对未知 keyId 抛 UnknownKeyIdError', () => {
    expect(() => vault().needsRotation('k9')).toThrow(UnknownKeyIdError)
  })

  it('UnknownKeyIdError 的提示里带上了当前可用的 keyId 列表', () => {
    const v = createVault({ keys: { k1: K1, k3: K3 }, currentKeyId: 'k1' })
    let message = ''
    try {
      v.needsRotation('k9')
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('k1')
    expect(message).toContain('k3')
    expect(message).not.toContain(K3)
  })
})
