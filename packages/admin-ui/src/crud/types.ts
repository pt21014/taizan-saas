import type { PermissionExpr } from '@taizan/rbac-core'
import type { ReactNode } from 'react'

/** 排序方向。用 `asc`/`desc` 而不是 antd 的 `ascend`/`descend`——传给后端的是这一份。 */
export type SortOrder = 'asc' | 'desc'

/**
 * 传给 `list()` 的查询参数：分页 + 排序 + **平铺**的搜索字段。
 *
 * 搜索字段平铺（`{ page, pageSize, keyword, status }`）而不是套一层 `filters`：
 * 后端 DTO 拿到的就是一层扁平的 query，多一层嵌套每个业务方都要手动解一次。
 */
export interface CrudListQuery {
  page: number
  pageSize: number
  sortBy?: string
  sortOrder?: SortOrder
  [key: string]: unknown
}

/** 搜索表单的一个字段（`<CrudTable>` 顶部那一排）。 */
export type SearchField =
  | {
      name: string
      label: string
      type?: 'input'
      placeholder?: string
      /** 输入框宽度，缺省 180 */
      width?: number
    }
  | {
      name: string
      label: string
      type: 'select'
      options: { label: string; value: string | number }[]
      placeholder?: string
      width?: number
    }

/** 表格行操作（每行右侧那几个链接按钮）。 */
export interface RowAction<T> {
  key: string
  label: ReactNode
  /** 需要的权限点；填了就自动用 `<Perm>` 包一层，没权限的人看不到这个操作 */
  perm?: PermissionExpr
  /** 危险操作（红色），如「删除」 */
  danger?: boolean
  /** 填了就先弹二次确认；函数形式可以把行数据拼进文案里（「确定删除『拿铁』吗？」） */
  confirm?: string | ((row: T) => string)
  /** 按行隐藏（如「已下架的商品没有『下架』操作」） */
  hidden?: (row: T) => boolean
  /** 按行禁用 */
  disabled?: (row: T) => boolean
  onClick: (row: T) => void | Promise<void>
}
