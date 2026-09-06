import { describe, expect, it, vi } from 'vitest'
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Form, Input } from 'antd'
import { ApiError, ErrorCode, type PageResult } from '@taizan/contracts'
import { btnName, withSession, makeSessionStore } from '../test/fixtures'
import { SessionProvider } from '../session'
import { MemoryRouter } from 'react-router-dom'
import { CrudDrawerForm } from './CrudDrawerForm'
import { CrudTable } from './CrudTable'
import { dateTimeColumn, enumColumn, formatDateTime, moneyColumn, statusTagColumn } from './columns'
import { useCrudForm, type CrudFormApi } from './useCrudForm'
import { useCrudTable } from './useCrudTable'

interface Goods {
  id: string
  name: string
  priceCents: number
  status: 'ON' | 'OFF'
  createdAt: string
}

function makeRows(count: number, offset = 0): Goods[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `g${offset + i}`,
    name: `商品${offset + i}`,
    priceCents: 1000 + i,
    status: 'ON' as const,
    createdAt: '2026-09-06T01:02:03.000Z',
  }))
}

function makeList(total = 30) {
  return vi.fn(async (query: Record<string, unknown>): Promise<PageResult<Goods>> => {
    const page = Number(query.page)
    const pageSize = Number(query.pageSize)
    const keyword = query.keyword
    const filtered = typeof keyword === 'string' && keyword !== '' ? 1 : total
    return {
      items: makeRows(
        Math.min(pageSize, Math.max(filtered - (page - 1) * pageSize, 0)),
        (page - 1) * pageSize,
      ),
      total: filtered,
      page,
      pageSize,
    }
  })
}

describe('useCrudTable()', () => {
  it('挂载后立刻拉第一页，默认每页 20 条', async () => {
    const list = makeList()
    const { result } = renderHook(() => useCrudTable<Goods>({ list, rowKey: 'id' }))
    await waitFor(() => expect(result.current.rows).toHaveLength(20))
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ page: 1, pageSize: 20 }))
    expect(result.current.total).toBe(30)
  })

  it('翻页会带上新的 page 重查', async () => {
    const list = makeList()
    const { result } = renderHook(() => useCrudTable<Goods>({ list, rowKey: 'id' }))
    await waitFor(() => expect(result.current.rows).toHaveLength(20))

    act(() => result.current.setPage(2))
    await waitFor(() => expect(result.current.page).toBe(2))
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }))
  })

  it('改每页条数', async () => {
    const list = makeList()
    const { result } = renderHook(() => useCrudTable<Goods>({ list, rowKey: 'id' }))
    await waitFor(() => expect(result.current.rows).toHaveLength(20))

    act(() => result.current.setPage(1, 50))
    await waitFor(() => expect(result.current.pageSize).toBe(50))
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ pageSize: 50 }))
  })

  it('提交搜索会把条件平铺进 query，并自动回到第 1 页', async () => {
    const list = makeList()
    const { result } = renderHook(() => useCrudTable<Goods>({ list, rowKey: 'id' }))
    await waitFor(() => expect(result.current.rows).toHaveLength(20))
    act(() => result.current.setPage(2))
    await waitFor(() => expect(result.current.page).toBe(2))

    act(() => result.current.submitSearch({ keyword: '拿铁', status: '' }))
    await waitFor(() => expect(result.current.page).toBe(1))
    // 空串字段被剔掉，不会给后端发一个 status= 的空条件
    expect(list).toHaveBeenLastCalledWith({ page: 1, pageSize: 20, keyword: '拿铁' })
  })

  it('重置搜索回到初始条件', async () => {
    const list = makeList()
    const { result } = renderHook(() =>
      useCrudTable<Goods>({ list, rowKey: 'id', defaultSearch: { status: 'ON' } }),
    )
    await waitFor(() => expect(list).toHaveBeenCalled())
    act(() => result.current.submitSearch({ keyword: 'x' }))
    await waitFor(() => expect(result.current.search).toEqual({ keyword: 'x' }))

    act(() => result.current.resetSearch())
    await waitFor(() => expect(result.current.search).toEqual({ status: 'ON' }))
  })

  it('排序参数用 asc/desc 传给后端', async () => {
    const list = makeList()
    const { result } = renderHook(() => useCrudTable<Goods>({ list, rowKey: 'id' }))
    await waitFor(() => expect(list).toHaveBeenCalled())

    act(() => result.current.setSort('priceCents', 'desc'))
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith(
        expect.objectContaining({ sortBy: 'priceCents', sortOrder: 'desc' }),
      ),
    )
  })

  it('删除后自动刷新列表', async () => {
    const list = makeList()
    const remove = vi.fn(async () => undefined)
    const { result } = renderHook(() => useCrudTable<Goods>({ list, remove, rowKey: 'id' }))
    await waitFor(() => expect(result.current.rows).toHaveLength(20))
    const before = list.mock.calls.length

    await act(async () => {
      await result.current.removeRow(result.current.rows[0] as Goods)
    })
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(before))
    expect(remove).toHaveBeenCalledOnce()
  })

  it('删掉本页最后一条时自动回退一页（否则用户盯着一张空表）', async () => {
    const list = vi.fn(async (q: Record<string, unknown>): Promise<PageResult<Goods>> => ({
      items: Number(q.page) === 2 ? makeRows(1, 20) : makeRows(20),
      total: 21,
      page: Number(q.page),
      pageSize: 20,
    }))
    const remove = vi.fn(async () => undefined)
    const { result } = renderHook(() => useCrudTable<Goods>({ list, remove, rowKey: 'id' }))
    await waitFor(() => expect(result.current.rows).toHaveLength(20))
    act(() => result.current.setPage(2))
    await waitFor(() => expect(result.current.rows).toHaveLength(1))

    await act(async () => {
      await result.current.removeRow(result.current.rows[0] as Goods)
    })
    await waitFor(() => expect(result.current.page).toBe(1))
  })

  it('没配 remove 时调用 removeRow 直接抛错', async () => {
    const list = makeList()
    const { result } = renderHook(() => useCrudTable<Goods>({ list, rowKey: 'id' }))
    await waitFor(() => expect(result.current.rows).toHaveLength(20))
    await expect(result.current.removeRow(result.current.rows[0] as Goods)).rejects.toThrow(
      '没有配 remove()',
    )
  })

  it('list 报错时清空数据并回调 onError，不把上一屏留在那儿骗人', async () => {
    const onError = vi.fn()
    const list = vi.fn(async () => {
      throw new Error('boom')
    })
    const { result } = renderHook(() => useCrudTable<Goods>({ list, rowKey: 'id', onError }))
    await waitFor(() => expect(onError).toHaveBeenCalled())
    expect(result.current.rows).toEqual([])
    expect(result.current.loading).toBe(false)
  })

  it('list 是内联箭头函数也不会无限重查（内部用 ref 持有）', async () => {
    const spy = vi.fn(async (_query: Record<string, unknown>): Promise<PageResult<Goods>> => ({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    }))
    const { rerender } = renderHook(() =>
      useCrudTable<Goods>({ list: (q) => spy(q), rowKey: 'id' }),
    )
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    rerender()
    rerender()
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
  })

  it('rowKey 支持函数形式；选中/清空选择', async () => {
    const list = makeList()
    const { result } = renderHook(() =>
      useCrudTable<Goods>({ list, rowKey: (row) => `k-${row.id}` }),
    )
    await waitFor(() => expect(result.current.rows).toHaveLength(20))
    expect(result.current.keyOf(result.current.rows[0] as Goods)).toBe('k-g0')

    act(() => result.current.setSelectedKeys(['k-g0', 'k-g1']))
    expect(result.current.selectedKeys).toHaveLength(2)
    act(() => result.current.clearSelection())
    expect(result.current.selectedKeys).toEqual([])
  })

  it('syncUrl 打开后把分页写进地址栏，并能从地址栏读回来', async () => {
    window.history.replaceState({}, '', '/goods?page=3&keyword=%E6%8B%BF%E9%93%81')
    const list = makeList()
    const { result, unmount } = renderHook(() =>
      useCrudTable<Goods>({
        list,
        rowKey: 'id',
        syncUrl: true,
        searchSchema: [{ name: 'keyword', label: '关键字' }],
      }),
    )
    await waitFor(() => expect(list).toHaveBeenCalled())
    expect(result.current.page).toBe(3)
    expect(result.current.search).toEqual({ keyword: '拿铁' })

    act(() => result.current.setPage(1))
    await waitFor(() => expect(window.location.search).not.toContain('page=3'))
    unmount()
    window.history.replaceState({}, '', '/')
  })
})

describe('useCrudForm()', () => {
  interface GoodsForm {
    name: string
  }

  /**
   * antd 的 `Form.useForm()` 实例必须真的挂在一个 `<Form form={...}>` 上，
   * 否则 `setFieldsValue`/`validateFields` 是空操作（只打一条 warning）。
   * 所以表单钩子的用例不能只 `renderHook`，得连着一张真表单一起渲染。
   */
  function mountForm(options: Parameters<typeof useCrudForm<GoodsForm>>[0]) {
    const holder: { api: CrudFormApi<GoodsForm> | null } = { api: null }
    function Harness() {
      const api = useCrudForm<GoodsForm>(options)
      holder.api = api
      return (
        <Form form={api.antdForm}>
          <Form.Item name="name" label="名称">
            <Input />
          </Form.Item>
        </Form>
      )
    }
    render(<Harness />)
    return () => {
      const api = holder.api
      if (api === null) throw new Error('表单还没挂载')
      return api
    }
  }

  it('openForm() 无参 = 新建态，提交走 create', async () => {
    const create = vi.fn(async () => undefined)
    const onSuccess = vi.fn()
    const form = mountForm({ create, onSuccess })

    act(() => form().openForm())
    expect(form().mode).toBe('create')
    expect(form().open).toBe(true)

    act(() => form().antdForm.setFieldsValue({ name: '拿铁' }))
    await act(async () => {
      await form().submit()
    })
    expect(create).toHaveBeenCalledWith({ name: '拿铁' })
    expect(onSuccess).toHaveBeenCalledWith('create')
    expect(form().open).toBe(false)
  })

  it('openForm(id) = 编辑态，调 get 回填，提交走 update', async () => {
    const get = vi.fn(async () => ({ name: '美式' }))
    const update = vi.fn(async () => undefined)
    const form = mountForm({ get, create: vi.fn(), update })

    act(() => form().openForm('g1'))
    expect(form().mode).toBe('edit')
    expect(form().id).toBe('g1')
    await waitFor(() => expect(form().loading).toBe(false))
    expect(get).toHaveBeenCalledWith('g1')

    await act(async () => {
      await form().submit()
    })
    expect(update).toHaveBeenCalledWith('g1', { name: '美式' })
  })

  it('openWith() 直接用手上的行数据回填，不再打一次 get', async () => {
    const get = vi.fn()
    const update = vi.fn(async () => undefined)
    const form = mountForm({ get, create: vi.fn(), update })

    act(() => form().openWith('g2', { name: '卡布' }))
    expect(get).not.toHaveBeenCalled()
    await act(async () => {
      await form().submit()
    })
    expect(update).toHaveBeenCalledWith('g2', { name: '卡布' })
  })

  it('1440301（套餐到期只读）分流：不重复弹提示，抽屉留着不关', async () => {
    const create = vi.fn(async () => {
      throw new ApiError(ErrorCode.PLAN_READONLY.code, '套餐已到期', 'trace-1')
    })
    const onError = vi.fn()
    const onSuccess = vi.fn()
    const form = mountForm({ create, onError, onSuccess })

    act(() => form().openForm())
    await act(async () => {
      await form().submit()
    })

    expect(form().errorKind).toBe('readonly')
    expect(form().open).toBe(true)
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('readonly', expect.any(ApiError))
  })

  it('1540301（配额超限）分流成 quota，和只读态区分开', async () => {
    const create = vi.fn(async () => {
      throw new ApiError(ErrorCode.QUOTA_EXCEEDED.code, '已达到套餐配额上限', null)
    })
    const onError = vi.fn()
    const form = mountForm({ create, onError })

    act(() => form().openForm())
    await act(async () => {
      await form().submit()
    })
    expect(form().errorKind).toBe('quota')
    expect(onError).toHaveBeenCalledWith('quota', expect.any(ApiError))
  })

  it('其他错误码分流成 other（提示由 session.request 负责，这里不重复弹）', async () => {
    const create = vi.fn(async () => {
      throw new ApiError(ErrorCode.BAD_REQUEST.code, '参数错误', null)
    })
    const form = mountForm({ create })

    act(() => form().openForm())
    await act(async () => {
      await form().submit()
    })
    expect(form().errorKind).toBe('other')
    expect(form().open).toBe(true)
  })

  it('编辑态但没配 update() 时报错而不是静默走 create（防止「编辑」变成「又建了一条」）', async () => {
    const create = vi.fn(async () => undefined)
    const onError = vi.fn()
    const form = mountForm({ create, onError })

    act(() => form().openWith('g1', { name: 'x' }))
    await act(async () => {
      await form().submit()
    })
    expect(create).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('other', expect.any(Error))
  })
})

describe('<CrudTable>', () => {
  function Page() {
    const table = useCrudTable<Goods>({
      list: makeList(3),
      rowKey: 'id',
      searchSchema: [{ name: 'keyword', label: '关键字' }],
    })
    return (
      <CrudTable
        table={table}
        title="商品"
        columns={[{ title: '名称', dataIndex: 'name', key: 'name' }]}
        actions={[
          { key: 'edit', label: '编辑', perm: 'goods:write', onClick: () => undefined },
          {
            key: 'del',
            label: '删除',
            perm: 'goods:delete',
            danger: true,
            confirm: (row) => `确定删除「${row.name}」吗？`,
            onClick: () => undefined,
          },
        ]}
      />
    )
  }

  it('渲染搜索表单、数据行与行操作；没权限的行操作不渲染', async () => {
    render(withSession(<Page />, { permissions: ['goods:write'] }))
    expect(await screen.findByText('商品0')).toBeInTheDocument()
    expect(screen.getByLabelText('关键字')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: btnName('编辑') })).toHaveLength(3)
    expect(screen.queryByRole('button', { name: btnName('删除') })).not.toBeInTheDocument()
  })

  it('点「查询」把表单值提交成搜索条件', async () => {
    const user = userEvent.setup()
    render(withSession(<Page />, { permissions: [] }))
    await screen.findByText('商品0')

    await user.type(screen.getByLabelText('关键字'), '拿铁')
    await user.click(screen.getByRole('button', { name: btnName('查询') }))
    await waitFor(() => expect(screen.getAllByText(/商品/).length).toBeGreaterThan(0))
    expect(screen.getByText('共 1 条')).toBeInTheDocument()
  })
})

describe('<CrudDrawerForm> 与只读闸门', () => {
  function Drawer({ path }: { path: string }) {
    const form = useCrudForm<{ name: string }>({ create: vi.fn() })
    return (
      <MemoryRouter initialEntries={[path]}>
        <SessionProvider store={makeSessionStore({ tenant: readonlyTenant })}>
          <button type="button" onClick={() => form.openForm()}>
            打开
          </button>
          <CrudDrawerForm form={form} title="商品">
            <Form.Item name="name" label="名称">
              <Input />
            </Form.Item>
          </CrudDrawerForm>
        </SessionProvider>
      </MemoryRouter>
    )
  }

  const readonlyTenant = {
    id: 't1',
    slug: 'shop-1',
    name: '一号店',
    status: 'ACTIVE',
    planExpireAt: '2026-01-01T15:59:59.999Z',
    readonly: true,
    features: null,
  }

  it('只读态下「保存」被禁用，并给出为什么', async () => {
    const user = userEvent.setup()
    render(<Drawer path="/goods" />)
    await user.click(screen.getByRole('button', { name: btnName('打开') }))
    expect(await screen.findByRole('button', { name: btnName('保存') })).toBeDisabled()
    expect(screen.getByText(/后台当前为只读状态/)).toBeInTheDocument()
  })

  it('续费白名单页面（/billing）即使只读也不禁用——否则「到期→只读→续不了费→永远到期」', async () => {
    const user = userEvent.setup()
    render(<Drawer path="/billing" />)
    await user.click(screen.getByRole('button', { name: btnName('打开') }))
    expect(await screen.findByRole('button', { name: btnName('保存') })).toBeEnabled()
  })
})

describe('常用列工厂', () => {
  it('金额列把「分」渲染成「元」', () => {
    const column = moneyColumn<Goods>({ title: '价格', dataIndex: 'priceCents' })
    const row = { ...(makeRows(1)[0] as Goods), priceCents: 1234567 }
    render(<>{column.render?.(row.priceCents, row, 0) as React.ReactNode}</>)
    // 千分位默认开：金额列不分组，对账时得一位位数
    expect(screen.getByText('¥12,345.67')).toBeInTheDocument()
  })

  it('金额列遇到非整数（后端把分写成了浮点）显示 -，不显示 NaN', () => {
    const column = moneyColumn<Goods>({ title: '价格', dataIndex: 'priceCents' })
    const row = { ...(makeRows(1)[0] as Goods), priceCents: 12.5 }
    expect(column.render?.(12.5, row, 0)).toBe('-')
  })

  it('时间列格式化成 YYYY-MM-DD HH:mm，空值与非法值都是 -', () => {
    const iso = new Date(2026, 8, 6, 13, 4, 5).toISOString()
    expect(formatDateTime(iso)).toBe('2026-09-06 13:04')
    expect(formatDateTime(iso, true)).toBe('2026-09-06 13:04:05')
    expect(formatDateTime(null)).toBe('-')
    expect(formatDateTime('不是时间')).toBe('-')
    const column = dateTimeColumn<Goods>({ title: '创建时间', dataIndex: 'createdAt' })
    expect(column.width).toBe(170)
  })

  it('枚举列翻中文；映射表里没有的值原样显示（后端加了新枚举时不至于显示成 -）', () => {
    const column = enumColumn<Goods>({
      title: '状态',
      dataIndex: 'status',
      map: { ON: '在售' },
    })
    const row = makeRows(1)[0] as Goods
    expect(column.render?.('ON', row, 0)).toBe('在售')
    expect(column.render?.('DRAFT', { ...row, status: 'DRAFT' as 'ON' }, 0)).toBe('DRAFT')
  })

  it('状态列渲染成带颜色的 Tag', () => {
    const column = statusTagColumn<Goods>({
      title: '状态',
      dataIndex: 'status',
      map: { ON: { text: '在售', color: 'success' } },
    })
    render(<>{column.render?.('ON', makeRows(1)[0] as Goods, 0) as React.ReactNode}</>)
    expect(screen.getByText('在售')).toBeInTheDocument()
  })
})
