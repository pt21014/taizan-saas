import { describe, expect, it } from 'vitest'

import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, normalizePage, toSkipTake } from './paging'

describe('normalizePage', () => {
  it('缺省时回落到默认值', () => {
    expect(normalizePage(undefined)).toEqual({ page: DEFAULT_PAGE, pageSize: DEFAULT_PAGE_SIZE })
    expect(normalizePage({})).toEqual({ page: DEFAULT_PAGE, pageSize: DEFAULT_PAGE_SIZE })
  })

  it('透传合法值', () => {
    expect(normalizePage({ page: 3, pageSize: 50 })).toEqual({ page: 3, pageSize: 50 })
  })

  it('pageSize 超过上限时截到 200', () => {
    expect(normalizePage({ pageSize: 999 })).toEqual({
      page: DEFAULT_PAGE,
      pageSize: MAX_PAGE_SIZE,
    })
  })

  it('非法/非正整数值回落到默认值', () => {
    expect(normalizePage({ page: 0 })).toEqual({ page: DEFAULT_PAGE, pageSize: DEFAULT_PAGE_SIZE })
    expect(normalizePage({ page: -1 })).toEqual({ page: DEFAULT_PAGE, pageSize: DEFAULT_PAGE_SIZE })
    expect(normalizePage({ page: 1.5 })).toEqual({
      page: DEFAULT_PAGE,
      pageSize: DEFAULT_PAGE_SIZE,
    })
    expect(normalizePage({ pageSize: 0 })).toEqual({
      page: DEFAULT_PAGE,
      pageSize: DEFAULT_PAGE_SIZE,
    })
  })
})

describe('toSkipTake', () => {
  it('page=1 时 skip=0', () => {
    expect(toSkipTake({ page: 1, pageSize: 20 })).toEqual({ skip: 0, take: 20 })
  })

  it('page=3,pageSize=10 时 skip=20', () => {
    expect(toSkipTake({ page: 3, pageSize: 10 })).toEqual({ skip: 20, take: 10 })
  })

  it('缺省时按默认分页换算', () => {
    expect(toSkipTake(undefined)).toEqual({ skip: 0, take: DEFAULT_PAGE_SIZE })
  })
})
