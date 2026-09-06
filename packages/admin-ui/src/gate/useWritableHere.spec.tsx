import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { SessionState } from '../session'
import { withSession } from '../test/fixtures'
import { isRenewalRoute, useWritableHere } from './useWritableHere'

const EXPIRED: SessionState['tenant'] = {
  id: 't1',
  slug: 'shop-1',
  name: '一号店',
  status: 'ACTIVE',
  planExpireAt: '2026-01-01T15:59:59.999Z',
  readonly: true,
  features: null,
}

function Probe({ extra }: { extra?: string[] }) {
  return <span>writable:{String(useWritableHere(extra))}</span>
}

describe('isRenewalRoute()', () => {
  it('账单页与其子路由都算续费白名单', () => {
    expect(isRenewalRoute('/billing')).toBe(true)
    expect(isRenewalRoute('/billing/orders')).toBe(true)
    expect(isRenewalRoute('/plan')).toBe(true)
  })

  it('不做前缀模糊匹配：/billings 不是 /billing 的子路由', () => {
    expect(isRenewalRoute('/billings')).toBe(false)
    expect(isRenewalRoute('/goods')).toBe(false)
  })
})

describe('useWritableHere()', () => {
  it('未到期时哪儿都能写', () => {
    render(withSession(<Probe />, {}, ['/goods']))
    expect(screen.getByText('writable:true')).toBeInTheDocument()
  })

  it('只读态下普通页面不可写', () => {
    render(withSession(<Probe />, { tenant: EXPIRED }, ['/goods']))
    expect(screen.getByText('writable:false')).toBeInTheDocument()
  })

  it('只读态下续费白名单页面仍可写——否则「到期→只读→续不了费→永远到期」', () => {
    render(withSession(<Probe />, { tenant: EXPIRED }, ['/billing']))
    expect(screen.getByText('writable:true')).toBeInTheDocument()
  })

  it('应用可以追加自己的白名单前缀', () => {
    render(withSession(<Probe extra={['/support']} />, { tenant: EXPIRED }, ['/support/ticket']))
    expect(screen.getByText('writable:true')).toBeInTheDocument()
  })
})
