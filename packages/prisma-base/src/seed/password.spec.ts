/**
 * 口令哈希的单测。
 *
 * 这份实现会被 `@taizan/nest-auth` 复用来校验线上登录口令，所以串格式是跨包契约：
 * 除了往返能过，还得盯住「格式没变」「坏串不炸只回 false」「错口令一定被拒」。
 */

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SCRYPT_PARAMS,
  PASSWORD_HASH_ALGORITHM,
  hashPassword,
  hashPasswordSync,
  needsRehash,
  parsePasswordHash,
  verifyPassword,
  verifyPasswordSync,
} from './password'

// 单测里把成本参数压到最低，不然每个用例要花 100 ms。
const FAST = { ...DEFAULT_SCRYPT_PARAMS, N: 2, r: 1, p: 1 }

describe('hashPassword / verifyPassword', () => {
  it('哈希 → 校验往返成功', async () => {
    const stored = await hashPassword('admin123', FAST)
    await expect(verifyPassword('admin123', stored)).resolves.toBe(true)
  })

  it('错误口令被拒', async () => {
    const stored = await hashPassword('admin123', FAST)
    await expect(verifyPassword('admin124', stored)).resolves.toBe(false)
    await expect(verifyPassword('Admin123', stored)).resolves.toBe(false)
    await expect(verifyPassword('', stored)).resolves.toBe(false)
  })

  it('同一口令两次哈希不同（盐随机），但都能校验通过', async () => {
    const a = await hashPassword('same', FAST)
    const b = await hashPassword('same', FAST)
    expect(a).not.toBe(b)
    await expect(verifyPassword('same', a)).resolves.toBe(true)
    await expect(verifyPassword('same', b)).resolves.toBe(true)
  })

  it('串格式是 scrypt$N$r$p$salt$hash', async () => {
    const stored = await hashPassword('x', FAST)
    const parts = stored.split('$')
    expect(parts).toHaveLength(6)
    expect(parts[0]).toBe(PASSWORD_HASH_ALGORITHM)
    expect(parts[1]).toBe(String(FAST.N))
    expect(parts[2]).toBe(String(FAST.r))
    expect(parts[3]).toBe(String(FAST.p))
  })

  it('中文与超长口令都能往返', async () => {
    const password = `密码-${'x'.repeat(500)}`
    const stored = await hashPassword(password, FAST)
    await expect(verifyPassword(password, stored)).resolves.toBe(true)
  })

  it('空口令 / 非字符串直接抛 TypeError', async () => {
    await expect(hashPassword('', FAST)).rejects.toBeInstanceOf(TypeError)
    await expect(hashPassword(undefined as unknown as string, FAST)).rejects.toBeInstanceOf(
      TypeError,
    )
  })

  it('非法参数抛 RangeError', async () => {
    await expect(hashPassword('x', { ...FAST, N: 3 })).rejects.toBeInstanceOf(RangeError)
    await expect(hashPassword('x', { ...FAST, r: 0 })).rejects.toBeInstanceOf(RangeError)
    await expect(hashPassword('x', { ...FAST, p: 0 })).rejects.toBeInstanceOf(RangeError)
    await expect(hashPassword('x', { ...FAST, saltBytes: 4 })).rejects.toBeInstanceOf(RangeError)
    await expect(hashPassword('x', { ...FAST, keyBytes: 8 })).rejects.toBeInstanceOf(RangeError)
  })
})

describe('verifyPassword 面对坏数据只回 false，不抛', () => {
  const bad = [
    undefined,
    null,
    42,
    '',
    'plaintext',
    'bcrypt$16384$8$1$c2FsdA==$aGFzaA==',
    'scrypt$16384$8$1$c2FsdA==', // 段数不够
    'scrypt$16384$8$1$c2FsdA==$aGFzaA==$extra', // 段数过多
    'scrypt$0$8$1$c2FsdA==$aGFzaA==', // N 非法
    'scrypt$16384$0$1$c2FsdA==$aGFzaA==', // r 非法
    'scrypt$16384$8$0$c2FsdA==$aGFzaA==', // p 非法
    'scrypt$16384$8$1$短$aGFzaA==', // 盐太短
  ]

  it.each(bad.map((v) => [JSON.stringify(v) ?? String(v), v] as const))(
    '%s → false',
    async (_label, value) => {
      await expect(verifyPassword('anything', value)).resolves.toBe(false)
      expect(verifyPasswordSync('anything', value)).toBe(false)
    },
  )

  it('串被改一个字符就校验不过', async () => {
    const stored = await hashPassword('secret', FAST)
    const tampered = `${stored.slice(0, -2)}${stored.endsWith('A=') ? 'B=' : 'A='}`
    await expect(verifyPassword('secret', tampered)).resolves.toBe(false)
  })
})

describe('parsePasswordHash', () => {
  it('解析出参数、盐与哈希', async () => {
    const stored = await hashPassword('x', FAST)
    const parsed = parsePasswordHash(stored)
    expect(parsed?.algorithm).toBe('scrypt')
    expect(parsed?.N).toBe(FAST.N)
    expect(parsed?.salt).toHaveLength(FAST.saltBytes)
    expect(parsed?.hash).toHaveLength(FAST.keyBytes)
  })

  it('坏串返回 undefined', () => {
    expect(parsePasswordHash('nope')).toBeUndefined()
    expect(parsePasswordHash(123)).toBeUndefined()
  })
})

describe('hashPasswordSync / verifyPasswordSync', () => {
  it('同步版往返成功，且与异步版互通', async () => {
    const stored = hashPasswordSync('shared', FAST)
    expect(verifyPasswordSync('shared', stored)).toBe(true)
    await expect(verifyPassword('shared', stored)).resolves.toBe(true)

    const async = await hashPassword('shared', FAST)
    expect(verifyPasswordSync('shared', async)).toBe(true)
  })

  it('同步版也拒绝错误口令与空口令', () => {
    const stored = hashPasswordSync('shared', FAST)
    expect(verifyPasswordSync('nope', stored)).toBe(false)
    expect(verifyPasswordSync('', stored)).toBe(false)
    expect(verifyPasswordSync(null, stored)).toBe(false)
  })

  it('同步版同样校验参数', () => {
    expect(() => hashPasswordSync('x', { ...FAST, N: 3 })).toThrow(RangeError)
    expect(() => hashPasswordSync('', FAST)).toThrow(TypeError)
  })
})

describe('needsRehash', () => {
  it('参数与当前默认一致时不需要重算', async () => {
    const stored = await hashPassword('x')
    expect(needsRehash(stored)).toBe(false)
  })

  it('用旧参数生成的串需要重算', async () => {
    const stored = await hashPassword('x', FAST)
    expect(needsRehash(stored)).toBe(true)
  })

  it('坏串一律需要重算', () => {
    expect(needsRehash('garbage')).toBe(true)
  })
})
