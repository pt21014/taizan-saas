import { describe, expect, it } from 'vitest'
import {
  ALLOWED_EXTENSIONS,
  assertAllowedExtension,
  contentTypeOf,
  isAllowedExtension,
} from './mime'

describe('白名单', () => {
  it('常见图片/音频/视频扩展名在白名单内', () => {
    expect(isAllowedExtension('.jpg')).toBe(true)
    expect(isAllowedExtension('.MP4')).toBe(true)
    expect(isAllowedExtension('.pdf')).toBe(true)
  })

  it('可执行/脚本类扩展名不在白名单——白名单不是黑名单', () => {
    expect(isAllowedExtension('.exe')).toBe(false)
    expect(isAllowedExtension('.html')).toBe(false)
    expect(isAllowedExtension('.sh')).toBe(false)
  })

  it('assertAllowedExtension 对不在白名单的扩展名抛错', () => {
    expect(() => assertAllowedExtension('.html')).toThrow('不支持的扩展名')
  })

  it('ALLOWED_EXTENSIONS 非空且都带前导点', () => {
    expect(ALLOWED_EXTENSIONS.length).toBeGreaterThan(0)
    for (const ext of ALLOWED_EXTENSIONS) expect(ext.startsWith('.')).toBe(true)
  })
})

describe('contentTypeOf', () => {
  it('按扩展名返回对应的 Content-Type', () => {
    expect(contentTypeOf('.jpg')).toBe('image/jpeg')
    expect(contentTypeOf('.PNG')).toBe('image/png')
  })

  it('未知扩展名兜底成通用二进制类型，不猜测', () => {
    expect(contentTypeOf('.unknown')).toBe('application/octet-stream')
  })
})
