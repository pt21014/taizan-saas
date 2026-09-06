import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@taizan/contracts'
import Signup from './Signup'
import { SiteConfigProvider } from '../context/SiteConfigContext'
import * as api from '../api'
import type { SiteConfig } from '../api'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    fetchSiteConfig: vi.fn(),
    checkSlug: vi.fn(),
    fetchCaptcha: vi.fn(),
    signup: vi.fn(),
  }
})

const BASE_CFG: SiteConfig = { signupEnabled: true, trialDays: 14, plans: [] }

function renderSignup() {
  return render(
    <MemoryRouter>
      <SiteConfigProvider>
        <Signup />
      </SiteConfigProvider>
    </MemoryRouter>,
  )
}

async function fillValidForm() {
  fireEvent.change(screen.getByLabelText('店铺名称'), { target: { value: '楼下便利店' } })
  fireEvent.change(screen.getByLabelText('店主手机号'), { target: { value: '13900000001' } })
  fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'abc12345' } })
  fireEvent.change(screen.getByLabelText('店铺路径'), { target: { value: 'my-shop-01' } })
  // 让 slug 的防抖网络查重尽快落定，避免它成为其它断言里的噪音。
  await act(async () => {
    await Promise.resolve()
  })
}

describe('Signup 页', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.fetchSiteConfig).mockResolvedValue(BASE_CFG)
    vi.mocked(api.fetchCaptcha).mockResolvedValue({
      id: 'cap-1',
      svg: '<svg><text>AB12</text></svg>',
    })
    vi.mocked(api.checkSlug).mockResolvedValue({
      slug: 'my-shop-01',
      available: true,
      reason: null,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('slug 格式不合法时即时给出提示，不等提交', async () => {
    renderSignup()
    const slugInput = screen.getByLabelText('店铺路径')
    fireEvent.change(slugInput, { target: { value: 'A_bad slug' } })
    expect(await screen.findByText(/店铺路径只能用小写字母、数字和连字符/)).toBeInTheDocument()
  })

  it('保留字 slug 前端即时提示（不发网络请求）', async () => {
    renderSignup()
    const slugInput = screen.getByLabelText('店铺路径')
    fireEvent.change(slugInput, { target: { value: 'admin' } })
    expect(await screen.findByText('这个路径是系统保留的，换一个')).toBeInTheDocument()
    expect(api.checkSlug).not.toHaveBeenCalled()
  })

  it('密码强度：太短或只有一类字符时提示，两类字符且够长时通过', async () => {
    renderSignup()
    const pwd = screen.getByLabelText('登录密码')

    fireEvent.change(pwd, { target: { value: '1234567' } })
    expect(await screen.findByText(/8–64 位/)).toBeInTheDocument()

    fireEvent.change(pwd, { target: { value: '12345678' } })
    expect(await screen.findByText(/至少要包含字母、数字、符号里的两类/)).toBeInTheDocument()

    fireEvent.change(pwd, { target: { value: 'abcd1234' } })
    expect(await screen.findByText('密码强度可以')).toBeInTheDocument()
  })

  it('未勾选服务条款时提交按钮保持禁用', async () => {
    renderSignup()
    await fillValidForm()
    const submit = screen.getByRole('button', { name: /免费开通/ })
    expect(submit).toBeDisabled()

    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => expect(submit).not.toBeDisabled())
  })

  it('check-slug 防抖：连续输入只发一次网络请求', async () => {
    vi.useFakeTimers()
    renderSignup()
    const slugInput = screen.getByLabelText('店铺路径')

    fireEvent.change(slugInput, { target: { value: 'abc' } })
    act(() => vi.advanceTimersByTime(100))
    fireEvent.change(slugInput, { target: { value: 'abcd' } })
    act(() => vi.advanceTimersByTime(100))
    fireEvent.change(slugInput, { target: { value: 'abcde' } })
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })

    expect(api.checkSlug).toHaveBeenCalledTimes(1)
    expect(api.checkSlug).toHaveBeenCalledWith('abcde')
  })

  it('限流命中（1042900）时提示稍后再试', async () => {
    vi.mocked(api.signup).mockRejectedValue(new ApiError(1042900, '请求过于频繁', null))
    renderSignup()
    await fillValidForm()
    fireEvent.click(screen.getByRole('checkbox'))
    const submit = await screen.findByRole('button', { name: /免费开通/ })
    await waitFor(() => expect(submit).not.toBeDisabled())

    fireEvent.click(submit)
    expect(await screen.findByText(/稍后再试/)).toBeInTheDocument()
  })
})
