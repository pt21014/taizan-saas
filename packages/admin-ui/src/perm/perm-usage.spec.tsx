import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Button } from 'antd'
import { Route, Routes, useLocation } from 'react-router-dom'
import { btnName, withSession } from '../test/fixtures'
import { Perm } from './Perm'
import { RequireAuth, readReturnTo, RETURN_TO_PARAM } from './RequireAuth'
import { RequirePermission } from './RequirePermission'
import { usePerm } from './usePerm'
import { withPerm } from './withPerm'

function Probe({ expr }: { expr: string | string[] }) {
  const perm = usePerm()
  return <span>has:{String(perm.has(expr))}</span>
}

const GRANTED = ['goods:list', 'goods:write']

describe('usePerm()', () => {
  it('单个 code：命中为 true，未命中为 false', () => {
    render(withSession(<Probe expr="goods:list" />, { permissions: GRANTED }))
    expect(screen.getByText('has:true')).toBeInTheDocument()
  })

  it('单个 code 未授予时为 false', () => {
    render(withSession(<Probe expr="goods:delete" />, { permissions: GRANTED }))
    expect(screen.getByText('has:false')).toBeInTheDocument()
  })

  it("'a|b' 是「或」：任一命中即通过", () => {
    render(withSession(<Probe expr="goods:delete|goods:write" />, { permissions: GRANTED }))
    expect(screen.getByText('has:true')).toBeInTheDocument()
  })

  it("['a','b'] 是「与」：缺一个就不通过", () => {
    render(withSession(<Probe expr={['goods:list', 'goods:delete']} />, { permissions: GRANTED }))
    expect(screen.getByText('has:false')).toBeInTheDocument()
  })

  it("['a','b'] 全部命中时通过", () => {
    render(withSession(<Probe expr={['goods:list', 'goods:write']} />, { permissions: GRANTED }))
    expect(screen.getByText('has:true')).toBeInTheDocument()
  })

  it('表达式非法时不炸页面，按「无权限」处理并打 error', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(withSession(<Probe expr="goodsWrite" />, { permissions: GRANTED }))
    expect(screen.getByText('has:false')).toBeInTheDocument()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('hasAll / hasAny / codes', () => {
    function Multi() {
      const perm = usePerm()
      return (
        <span>
          {String(perm.hasAll(['goods:list', 'goods:write']))}/
          {String(perm.hasAll(['goods:delete']))}/
          {String(perm.hasAny(['goods:delete', 'goods:list']))}/{perm.codes.size}
        </span>
      )
    }
    render(withSession(<Multi />, { permissions: GRANTED }))
    expect(screen.getByText('true/false/true/2')).toBeInTheDocument()
  })
})

describe('<Perm>', () => {
  it('有权限时渲染子节点', () => {
    render(
      withSession(
        <Perm code="goods:write">
          <Button>新增</Button>
        </Perm>,
        { permissions: GRANTED },
      ),
    )
    expect(screen.getByRole('button', { name: btnName('新增') })).toBeInTheDocument()
  })

  it('无权限时什么都不渲染', () => {
    render(
      withSession(
        <Perm code="goods:delete">
          <Button>删除</Button>
        </Perm>,
        { permissions: GRANTED },
      ),
    )
    expect(screen.queryByRole('button', { name: btnName('删除') })).not.toBeInTheDocument()
  })

  it('无权限且给了 fallback 时渲染 fallback', () => {
    render(
      withSession(
        <Perm code="goods:delete" fallback={<span>无权限</span>}>
          <Button>删除</Button>
        </Perm>,
        { permissions: GRANTED },
      ),
    )
    expect(screen.getByText('无权限')).toBeInTheDocument()
  })
})

describe('withPerm()', () => {
  it('无权限时整个组件不渲染，有权限时正常透传 props', () => {
    const Guarded = withPerm(Button, 'goods:export')
    const { unmount } = render(withSession(<Guarded>导出</Guarded>, { permissions: GRANTED }))
    expect(screen.queryByRole('button', { name: btnName('导出') })).not.toBeInTheDocument()
    unmount()

    render(withSession(<Guarded>导出</Guarded>, { permissions: [...GRANTED, 'goods:export'] }))
    expect(screen.getByRole('button', { name: btnName('导出') })).toBeInTheDocument()
  })

  it('displayName 带上原组件名，React DevTools 里看得出来是被谁包的', () => {
    const Guarded = withPerm(function GoodsButton() {
      return <button type="button">x</button>
    }, 'goods:export')
    expect(Guarded.displayName).toBe('withPerm(GoodsButton)')
  })
})

describe('<RequirePermission>', () => {
  it('无权限时渲染 403 页（而不是白屏），并写出缺的权限点', () => {
    render(
      withSession(
        <RequirePermission code="goods:delete">
          <div>商品页</div>
        </RequirePermission>,
        { permissions: GRANTED },
      ),
    )
    expect(screen.getByText('403')).toBeInTheDocument()
    expect(screen.getByText(/goods:delete/)).toBeInTheDocument()
    expect(screen.queryByText('商品页')).not.toBeInTheDocument()
  })

  it('有权限时渲染子页面', () => {
    render(
      withSession(
        <RequirePermission code="goods:list">
          <div>商品页</div>
        </RequirePermission>,
        { permissions: GRANTED },
      ),
    )
    expect(screen.getByText('商品页')).toBeInTheDocument()
  })

  it('code 为 undefined 时直接放行（buildRoutes 对每条路由统一包一层）', () => {
    render(
      withSession(
        <RequirePermission>
          <div>公开页</div>
        </RequirePermission>,
        { permissions: [] },
      ),
    )
    expect(screen.getByText('公开页')).toBeInTheDocument()
  })

  it('可以换掉默认 403 页', () => {
    render(
      withSession(
        <RequirePermission code="goods:delete" forbidden={() => <div>自定义403</div>}>
          <div>商品页</div>
        </RequirePermission>,
        { permissions: GRANTED },
      ),
    )
    expect(screen.getByText('自定义403')).toBeInTheDocument()
  })
})

describe('<RequireAuth>', () => {
  it('没有 token 时跳登录页并把原地址记进 ?returnTo=', () => {
    function LoginProbe() {
      const location = useLocation()
      return <span>login{location.search}</span>
    }
    render(
      withSession(
        <Routes>
          <Route
            path="/goods"
            element={
              <RequireAuth>
                <div>后台内容</div>
              </RequireAuth>
            }
          />
          <Route path="/login" element={<LoginProbe />} />
        </Routes>,
        { token: null },
        ['/goods?page=2'],
      ),
    )
    expect(screen.queryByText('后台内容')).not.toBeInTheDocument()
    expect(
      screen.getByText(`login?${RETURN_TO_PARAM}=${encodeURIComponent('/goods?page=2')}`),
    ).toBeInTheDocument()
  })

  it('有 token 时正常渲染子树', () => {
    render(
      withSession(
        <RequireAuth>
          <div>后台内容</div>
        </RequireAuth>,
        { token: 'tok' },
      ),
    )
    expect(screen.getByText('后台内容')).toBeInTheDocument()
  })

  it('readReturnTo 从 query 里读回原地址', () => {
    const search = `?${RETURN_TO_PARAM}=${encodeURIComponent('/goods?page=2')}`
    expect(readReturnTo(search)).toBe('/goods?page=2')
  })

  it('readReturnTo 从 location.state 里读（整页刷新丢了 query 的场景）', () => {
    expect(readReturnTo('', { [RETURN_TO_PARAM]: '/orders' })).toBe('/orders')
  })

  it('readReturnTo 拒绝站外地址（开放重定向是登录页最常见的洞）', () => {
    expect(readReturnTo(`?${RETURN_TO_PARAM}=https%3A%2F%2Fevil.example`)).toBeNull()
    expect(readReturnTo(`?${RETURN_TO_PARAM}=%2F%2Fevil.example`)).toBeNull()
    expect(readReturnTo('')).toBeNull()
  })
})
