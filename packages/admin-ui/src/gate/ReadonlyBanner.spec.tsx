import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { create } from 'zustand'
import { SessionProvider, type SessionState } from '../session'
import { ReadonlyBanner } from './ReadonlyBanner'
import { useWritable } from './useWritable'

function makeStore(readonly: boolean) {
  return create<SessionState>(() => ({
    identity: null,
    tenant: {
      id: 't1',
      slug: 'shop-1',
      name: '一号店',
      status: 'ACTIVE',
      planExpireAt: readonly ? '2026-01-01T15:59:59.999Z' : null,
      readonly,
      features: null,
    },
    shops: [],
    permissions: [],
    menus: [],
    quotas: {},
    token: 'tok',
    status: 'ready',
    request: {} as SessionState['request'],
    bootstrap: vi.fn(),
    login: vi.fn(),
    switchTenant: vi.fn(),
    logout: vi.fn(),
  }))
}

function Probe() {
  const writable = useWritable()
  return <span>writable:{String(writable)}</span>
}

describe('<ReadonlyBanner> / useWritable()', () => {
  it('readonly 为 true 时出现横幅与「去续费」按钮', () => {
    render(
      <MemoryRouter>
        <SessionProvider store={makeStore(true)}>
          <ReadonlyBanner />
        </SessionProvider>
      </MemoryRouter>,
    )

    expect(screen.getByText(/套餐已到期/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '去续费' })).toBeInTheDocument()
  })

  it('readonly 为 false 时不渲染横幅', () => {
    render(
      <MemoryRouter>
        <SessionProvider store={makeStore(false)}>
          <ReadonlyBanner />
        </SessionProvider>
      </MemoryRouter>,
    )

    expect(screen.queryByText(/套餐已到期/)).not.toBeInTheDocument()
  })

  it('useWritable() 与 tenant.readonly 相反', () => {
    render(
      <MemoryRouter>
        <SessionProvider store={makeStore(true)}>
          <Probe />
        </SessionProvider>
      </MemoryRouter>,
    )

    expect(screen.getByText('writable:false')).toBeInTheDocument()
  })
})
