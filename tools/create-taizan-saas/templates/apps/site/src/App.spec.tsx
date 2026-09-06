import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { ALL_PAGES } from './config/NAV'
import * as api from './api'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return { ...actual, fetchSiteConfig: vi.fn() }
})

beforeEach(() => {
  vi.mocked(api.fetchSiteConfig).mockResolvedValue({
    signupEnabled: true,
    trialDays: 14,
    plans: [],
  })
})

describe('路由与 NAV 保持一致', () => {
  it.each(ALL_PAGES.map((p) => [p.to, p.label] as const))(
    '路由 %s（%s）存在，不落到 404',
    async (to) => {
      render(
        <MemoryRouter initialEntries={[to]}>
          <App />
        </MemoryRouter>,
      )
      await waitFor(() => expect(document.title).not.toBe(''))
      expect(screen.queryByText('页面不存在')).not.toBeInTheDocument()
    },
  )

  it('服务条款/隐私政策链接可达（页脚渲染出这两个链接）', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getAllByText('服务条款').length).toBeGreaterThan(0))
    expect(screen.getAllByText('隐私政策').length).toBeGreaterThan(0)
  })
})
