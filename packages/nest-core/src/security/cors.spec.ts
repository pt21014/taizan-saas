import { describe, expect, it } from 'vitest'
import { createOriginChecker, EmptyCorsWhitelistError, matchOrigin } from './cors'

describe('matchOrigin', () => {
  it('精确匹配', () => {
    expect(matchOrigin('https://admin.example.com', 'https://admin.example.com')).toBe(true)
    expect(matchOrigin('https://admin.example.com', 'https://other.example.com')).toBe(false)
  })

  it('*.example.com 匹配一级子域', () => {
    expect(matchOrigin('https://*.example.com', 'https://admin.example.com')).toBe(true)
    expect(matchOrigin('https://*.example.com', 'https://a-b.example.com')).toBe(true)
  })

  it('通配不跨级、不跨协议、不被同后缀域名绕过', () => {
    // 多级子域不放行：`evil.attacker.example.com` 这类容易被托管服务白嫖
    expect(matchOrigin('https://*.example.com', 'https://a.b.example.com')).toBe(false)
    expect(matchOrigin('https://*.example.com', 'http://a.example.com')).toBe(false)
    // 关键：`notexample.com` 不能因为后缀像就被放行
    expect(matchOrigin('https://*.example.com', 'https://evil.notexample.com')).toBe(false)
    expect(matchOrigin('https://*.example.com', 'https://example.com')).toBe(false)
    expect(matchOrigin('https://*.example.com', 'https://evil.com/.example.com')).toBe(false)
  })
})

describe('createOriginChecker', () => {
  it('白名单命中放行，未命中拒绝', () => {
    const check = createOriginChecker(['https://admin.example.com'], true)
    expect(check('https://admin.example.com')).toBe(true)
    expect(check('https://evil.com')).toBe(false)
  })

  it('没有 Origin 头的请求（同源 / curl / 服务端调用）放行', () => {
    expect(createOriginChecker(['https://a.example.com'], true)(undefined)).toBe(true)
  })

  it('空白名单：生产拒启，开发放行 localhost', () => {
    expect(() => createOriginChecker([], true)).toThrow(EmptyCorsWhitelistError)
    const dev = createOriginChecker([], false)
    expect(dev('http://localhost:5173')).toBe(true)
    expect(dev('http://127.0.0.1:3000')).toBe(true)
    expect(dev('https://evil.com')).toBe(false)
  })

  it('配了白名单以后开发环境也不再兜底放行 localhost（避免线上配置在本地被掩盖）', () => {
    const check = createOriginChecker(['https://a.example.com'], false)
    expect(check('http://localhost:5173')).toBe(false)
  })

  it('全空白字符串的白名单等价于空白名单', () => {
    expect(() => createOriginChecker(['', '   '], true)).toThrow(EmptyCorsWhitelistError)
  })
})
