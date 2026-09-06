import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Pricing from './Pricing'
import { SiteConfigProvider } from '../context/SiteConfigContext'
import * as api from '../api'
import type { SiteConfig } from '../api'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, fetchSiteConfig: vi.fn() }
})

function renderPricing() {
  return render(
    <MemoryRouter>
      <SiteConfigProvider>
        <Pricing />
      </SiteConfigProvider>
    </MemoryRouter>,
  )
}

function cfgWithPlans(count: number): SiteConfig {
  return {
    signupEnabled: true,
    trialDays: 14,
    plans: Array.from({ length: count }, (_, i) => ({
      id: `p${String(i)}`,
      code: `plan-${String(i)}`,
      name: `套餐 ${String(i + 1)}`,
      firstPriceCents: i * 10_000,
      renewPriceCents: i * 8_000,
      periodMonths: 12,
      sort: i * 10,
    })),
  }
}

describe('Pricing 页', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('按 site-config 返回的两档套餐渲染两张卡片', async () => {
    vi.mocked(api.fetchSiteConfig).mockResolvedValue(cfgWithPlans(2))
    renderPricing()
    await waitFor(() => expect(screen.getAllByTestId('plan-card')).toHaveLength(2))
    expect(screen.getByText('套餐 1')).toBeInTheDocument()
    expect(screen.getByText('套餐 2')).toBeInTheDocument()
  })

  it('平台后台新增一档套餐时自动多渲染一张卡片', async () => {
    vi.mocked(api.fetchSiteConfig).mockResolvedValue(cfgWithPlans(3))
    renderPricing()
    await waitFor(() => expect(screen.getAllByTestId('plan-card')).toHaveLength(3))
  })

  it('接口失败时显示兜底文案，而不是白屏', async () => {
    vi.mocked(api.fetchSiteConfig).mockRejectedValue(new Error('network down'))
    renderPricing()
    await waitFor(() => expect(screen.getByText(/暂时没能取到实时价格/)).toBeInTheDocument())
    expect(screen.queryByTestId('plan-card')).not.toBeInTheDocument()
  })
})
