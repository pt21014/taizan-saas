import { describe, expect, it } from 'vitest'
import { renderTemplate } from './render'

describe('renderTemplate', () => {
  it('把 {{var}} 替换成 vars 里的值', () => {
    expect(
      renderTemplate('您的验证码是 {{code}}，{{ttl}} 分钟内有效', { code: '1234', ttl: '5' }),
    ).toBe('您的验证码是 1234，5 分钟内有效')
  })

  it('同一个变量出现多次都会被替换', () => {
    expect(renderTemplate('{{name}} 你好，{{name}}', { name: '张三' })).toBe('张三 你好，张三')
  })

  it('缺变量时抛错，不把 {{var}} 原样留在正文里', () => {
    expect(() => renderTemplate('您的验证码是 {{code}}', {})).toThrow('模板参数缺失')
  })

  it('没有占位符的正文原样返回', () => {
    expect(renderTemplate('纯文本', {})).toBe('纯文本')
  })
})
