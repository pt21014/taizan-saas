import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PageResult } from '@taizan/contracts'
import type { CrudListQuery, SearchField, SortOrder } from './types'

/** {@link useCrudTable} 的入参。 */
export interface UseCrudTableOptions<T> {
  /** 列表接口。**不需要 `useCallback` 包**——内部用 ref 持有它，不会因为函数身份变化而重查 */
  list: (query: CrudListQuery) => Promise<PageResult<T>>
  /** 删除接口；不传则 `removeRow()` 抛错（这张表没有删除能力） */
  remove?: (row: T) => Promise<void>
  /** 行主键：字段名或取值函数 */
  rowKey: string | ((row: T) => string)
  /** 顶部搜索表单的字段定义，透传给 `<CrudTable>` */
  searchSchema?: SearchField[]
  /** 每页条数，缺省 20（与 `@taizan/contracts` 的 `DEFAULT_PAGE_SIZE` 一致） */
  defaultPageSize?: number
  /** 搜索表单的初始值 */
  defaultSearch?: Record<string, unknown>
  /** 默认排序 */
  defaultSort?: { sortBy: string; sortOrder: SortOrder }
  /**
   * 把分页/搜索/排序同步进地址栏（默认关）。开了之后刷新页面、复制链接给同事，
   * 看到的是同一屏数据——后台列表页最常被抱怨的就是这一点。
   */
  syncUrl?: boolean
  /** URL 参数前缀，一个页面上放两张表时用它区分（如 `'a_'`） */
  urlPrefix?: string
  /** 列表接口失败时的额外处理；错误提示本身由 `session.request` 的错误码分流负责 */
  onError?: (err: unknown) => void
}

/** {@link useCrudTable} 的返回值。 */
export interface CrudTableApi<T> {
  rows: T[]
  total: number
  loading: boolean
  page: number
  pageSize: number
  sortBy?: string
  sortOrder?: SortOrder
  /** 当前生效的搜索条件（已提交的，不是表单里正在输入的） */
  search: Record<string, unknown>
  /** 当前选中的行主键 */
  selectedKeys: string[]
  searchSchema: SearchField[]
  keyOf: (row: T) => string
  /** 翻页 / 改每页条数 */
  setPage: (page: number, pageSize?: number) => void
  /** 提交搜索（自动回到第 1 页） */
  submitSearch: (values: Record<string, unknown>) => void
  /** 重置搜索回初始值 */
  resetSearch: () => void
  setSort: (sortBy?: string, sortOrder?: SortOrder) => void
  setSelectedKeys: (keys: string[]) => void
  clearSelection: () => void
  /** 重新拉当前这一屏 */
  refresh: () => void
  /** 删一行：调 `remove()` 后自动刷新；删掉的是本页最后一行时自动回退一页 */
  removeRow: (row: T) => Promise<void>
  /** 当前查询参数（就是发给 `list()` 的那一份），导出功能可以直接拿去用 */
  query: CrudListQuery
}

interface TableState {
  page: number
  pageSize: number
  sortBy?: string
  sortOrder?: SortOrder
  search: Record<string, unknown>
}

const DEFAULT_PAGE_SIZE = 20

function readUrlState(prefix: string, fallback: TableState, schema: SearchField[]): TableState {
  if (typeof window === 'undefined') return fallback
  const params = new URLSearchParams(window.location.search)
  const num = (name: string, def: number): number => {
    const raw = params.get(prefix + name)
    const parsed = raw === null ? Number.NaN : Number(raw)
    return Number.isInteger(parsed) && parsed >= 1 ? parsed : def
  }
  const order = params.get(prefix + 'sortOrder')
  const search: Record<string, unknown> = { ...fallback.search }
  for (const field of schema) {
    const raw = params.get(prefix + field.name)
    if (raw !== null && raw !== '') search[field.name] = raw
  }
  return {
    page: num('page', fallback.page),
    pageSize: num('pageSize', fallback.pageSize),
    sortBy: params.get(prefix + 'sortBy') ?? fallback.sortBy,
    sortOrder: order === 'asc' || order === 'desc' ? order : fallback.sortOrder,
    search,
  }
}

function writeUrlState(prefix: string, state: TableState): void {
  if (typeof window === 'undefined' || typeof window.history?.replaceState !== 'function') return
  const params = new URLSearchParams(window.location.search)
  const put = (name: string, value: unknown): void => {
    const key = prefix + name
    if (value === undefined || value === null || value === '') params.delete(key)
    else params.set(key, String(value))
  }
  put('page', state.page > 1 ? state.page : undefined)
  put('pageSize', state.pageSize !== DEFAULT_PAGE_SIZE ? state.pageSize : undefined)
  put('sortBy', state.sortBy)
  put('sortOrder', state.sortOrder)
  for (const [name, value] of Object.entries(state.search)) put(name, value)
  const qs = params.toString()
  const next = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash
  // 刻意用 replaceState 而不是 react-router 的 setSearchParams：
  // ① 翻页/改筛选不该在浏览器历史里堆一大摞条目（用户按返回想回的是上一个页面，不是上一页数据）；
  // ② 这个钩子因此不依赖 <Router> 上下文，没有路由的场景（弹窗里的选择表）也能直接用。
  window.history.replaceState(window.history.state, '', next)
}

function stripEmpty(search: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === null || value === '') continue
    out[key] = value
  }
  return out
}

/**
 * 列表页的状态机（蓝图 §5.2）：分页 / 搜索 / 排序 / 批量选择 / 刷新 / 删除，一次到位。
 *
 * 配合 `<CrudTable>` 与 `useCrudForm`，一个业务列表页 ≤40 行就能完成增删改查搜分页
 * （范式见 README「一个业务页面的 40 行范式」，跑得起来的版本见 `demo/src/pages/GoodsListPage.tsx`）。
 *
 * ## 两个刻意的设计
 *
 * - `list` 不进 effect 依赖：业务方几乎一定会写成内联箭头函数，进依赖就是每渲染一次查一次库。
 *   这里用 ref 持有最新的那一个，重查只由「分页/搜索/排序变了」或 `refresh()` 触发。
 * - 每次请求带一个自增序号，只有最后一次的结果会被写进 state。慢的那次搜索晚回来时会被丢掉，
 *   不会把用户已经改过的筛选结果覆盖回去。
 */
export function useCrudTable<T>(options: UseCrudTableOptions<T>): CrudTableApi<T> {
  const {
    rowKey,
    searchSchema = [],
    defaultPageSize = DEFAULT_PAGE_SIZE,
    defaultSearch,
    defaultSort,
    syncUrl = false,
    urlPrefix = '',
  } = options

  const optionsRef = useRef(options)
  optionsRef.current = options

  // 只在首次渲染时算一次：业务方多半把 defaultSearch 写成内联字面量，
  // 每次渲染都是一个新对象，直接 useMemo 依赖它等于没缓存，resetSearch 也会跟着变身份。
  const [initialSearch] = useState(() => stripEmpty(defaultSearch ?? {}))

  const [state, setState] = useState<TableState>(() => {
    const base: TableState = {
      page: 1,
      pageSize: defaultPageSize,
      sortBy: defaultSort?.sortBy,
      sortOrder: defaultSort?.sortOrder,
      search: initialSearch,
    }
    return syncUrl ? readUrlState(urlPrefix, base, searchSchema) : base
  })

  const [rows, setRows] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [reloadToken, setReloadToken] = useState(0)
  const seqRef = useRef(0)

  const keyOf = useCallback(
    (row: T): string =>
      typeof rowKey === 'function' ? rowKey(row) : String((row as Record<string, unknown>)[rowKey]),
    [rowKey],
  )

  const query = useMemo<CrudListQuery>(
    () => ({
      page: state.page,
      pageSize: state.pageSize,
      ...(state.sortBy !== undefined ? { sortBy: state.sortBy, sortOrder: state.sortOrder } : {}),
      ...state.search,
    }),
    [state],
  )

  useEffect(() => {
    if (syncUrl) writeUrlState(urlPrefix, state)
  }, [syncUrl, urlPrefix, state])

  useEffect(() => {
    const seq = ++seqRef.current
    let cancelled = false
    setLoading(true)
    optionsRef.current
      .list(query)
      .then((result) => {
        if (cancelled || seq !== seqRef.current) return
        setRows(result.items)
        setTotal(result.total)
      })
      .catch((err: unknown) => {
        if (cancelled || seq !== seqRef.current) return
        setRows([])
        setTotal(0)
        optionsRef.current.onError?.(err)
      })
      .finally(() => {
        if (cancelled || seq !== seqRef.current) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [query, reloadToken])

  const refresh = useCallback(() => setReloadToken((n) => n + 1), [])

  const setPage = useCallback((page: number, pageSize?: number) => {
    setState((prev) => ({ ...prev, page, pageSize: pageSize ?? prev.pageSize }))
  }, [])

  const submitSearch = useCallback((values: Record<string, unknown>) => {
    // 回第 1 页：换了筛选条件还停在第 7 页，多半是一张空表，用户会以为「搜不到」。
    setState((prev) => ({ ...prev, page: 1, search: stripEmpty(values) }))
    setSelectedKeys([])
  }, [])

  const resetSearch = useCallback(() => {
    setState((prev) => ({ ...prev, page: 1, search: initialSearch }))
    setSelectedKeys([])
  }, [initialSearch])

  const setSort = useCallback((sortBy?: string, sortOrder?: SortOrder) => {
    setState((prev) => ({ ...prev, sortBy, sortOrder }))
  }, [])

  const clearSelection = useCallback(() => setSelectedKeys([]), [])

  const removeRow = useCallback(
    async (row: T) => {
      const remove = optionsRef.current.remove
      if (remove === undefined) {
        throw new Error('[@taizan/admin-ui] useCrudTable：这张表没有配 remove()，删不了')
      }
      await remove(row)
      const removedKey = keyOf(row)
      setSelectedKeys((prev) => prev.filter((k) => k !== removedKey))
      // 删掉的是本页最后一条且不在第 1 页：留在原页会看到一张空表，往前退一页。
      setState((prev) =>
        rows.length === 1 && prev.page > 1 ? { ...prev, page: prev.page - 1 } : prev,
      )
      refresh()
    },
    [keyOf, refresh, rows.length],
  )

  return {
    rows,
    total,
    loading,
    page: state.page,
    pageSize: state.pageSize,
    sortBy: state.sortBy,
    sortOrder: state.sortOrder,
    search: state.search,
    selectedKeys,
    searchSchema,
    keyOf,
    setPage,
    submitSearch,
    resetSearch,
    setSort,
    setSelectedKeys,
    clearSelection,
    refresh,
    removeRow,
    query,
  }
}
