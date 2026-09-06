import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { withSession } from '../test/fixtures'
import { LoginPage } from './LoginPage'

/**
 * T3-4：`identifierField` 让平台超管后台（用户名登录）能直接复用这个组件，
 * 不必再像 `apps/platform` 历史版本那样本地重写一份「形状兼容」的登录页
 * （见 `apps/platform/README.md`「admin-ui 需要扩展的点」①）。
 */
describe('<LoginPage>', () => {
  it('默认（identifierField 缺省）：渲染手机号字段，login() 收到 phone 参数', async () => {
    const login = vi.fn().mockResolvedValue(null)
    const user = userEvent.setup()

    render(withSession(<LoginPage />, { login }))

    expect(screen.getByLabelText('手机号')).toBeInTheDocument()
    expect(screen.queryByLabelText('用户名')).not.toBeInTheDocument()

    await user.type(screen.getByLabelText('手机号'), '13900000001')
    await user.type(screen.getByLabelText('密码'), 'pwd123')
    await user.click(screen.getByRole('button', { name: /登\s*录/ }))

    expect(login).toHaveBeenCalledWith('13900000001', 'pwd123')
  })

  it("identifierField: 'username'：渲染用户名字段（无手机号正则），login() 收到 username 参数", async () => {
    const login = vi.fn().mockResolvedValue(null)
    const user = userEvent.setup()

    render(withSession(<LoginPage config={{ identifierField: 'username' }} />, { login }))

    expect(screen.getByLabelText('用户名')).toBeInTheDocument()
    expect(screen.queryByLabelText('手机号')).not.toBeInTheDocument()

    await user.type(screen.getByLabelText('用户名'), 'admin')
    await user.type(screen.getByLabelText('密码'), 'admin123')
    await user.click(screen.getByRole('button', { name: /登\s*录/ }))

    expect(login).toHaveBeenCalledWith('admin', 'admin123')
  })

  it('passwordLabel 可覆盖口令输入框的 label（平台超管后台历史上一直叫「口令」）', () => {
    render(withSession(<LoginPage config={{ passwordLabel: '口令' }} />))

    expect(screen.getByLabelText('口令')).toBeInTheDocument()
    expect(screen.queryByLabelText('密码')).not.toBeInTheDocument()
  })
})
