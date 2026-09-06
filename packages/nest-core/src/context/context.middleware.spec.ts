import { isUlid, ulid } from '@taizan/contracts'
import { describe, expect, it } from 'vitest'
import { resolveInboundTraceId } from './context.middleware'

describe('resolveInboundTraceId', () => {
  it('合法 ULID 被接续（大小写归一）', () => {
    const id = ulid()
    expect(resolveInboundTraceId(id)).toBe(id)
    expect(resolveInboundTraceId(id.toLowerCase())).toBe(id)
    expect(resolveInboundTraceId(` ${id} `)).toBe(id)
  })

  // 不校验就等于让任何人往日志里注入内容，或者伪造别人的 traceId 混淆排查
  it.each([
    ['不是 ULID 的普通串', 'not-a-ulid'],
    ['长度不足', '01JCT'],
    ['带换行的日志注入', `${ulid()}\nfake log line`],
    ['含 Crockford Base32 排除字符 I/L/O/U', 'IIIIIIIIIIIIIIIIIIIIIIIIII'],
    ['超长', 'A'.repeat(200)],
    ['空串', ''],
    ['非字符串', 12345],
    ['undefined', undefined],
  ])('%s 一律丢弃', (_label, raw) => {
    expect(resolveInboundTraceId(raw)).toBeUndefined()
  })

  it('数组形式的重复头取第一个（express 对重复头会给数组）', () => {
    const id = ulid()
    expect(resolveInboundTraceId([id, 'garbage'])).toBe(id)
    expect(resolveInboundTraceId(['garbage', id])).toBeUndefined()
  })

  it('丢弃后由调用方生成的新 id 是合法 ULID', () => {
    expect(isUlid(ulid())).toBe(true)
  })
})
