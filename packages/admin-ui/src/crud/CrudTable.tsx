import { useMemo, type ReactNode } from 'react'
import { Button, Card, Form, Input, Popconfirm, Select, Space, Table } from 'antd'
import type { ColumnsType, ColumnType } from 'antd/es/table'
import type { SorterResult, TablePaginationConfig } from 'antd/es/table/interface'
import { Perm } from '../perm/Perm'
import type { CrudTableApi } from './useCrudTable'
import type { RowAction, SearchField, SortOrder } from './types'
import type { PermissionExpr } from '@taizan/rbac-core'

export interface CrudTableProps<T> {
  /** `useCrudTable()` 的返回值 */
  table: CrudTableApi<T>
  columns: ColumnsType<T>
  /** 卡片标题 */
  title?: ReactNode
  /** 右上角工具栏插槽：「导出」「批量导入」这类整表级操作放这里（自己用 `<Perm>` 包） */
  toolbar?: ReactNode
  /**
   * 「新增」按钮的快捷写法，等价于往 `toolbar` 里放
   * `<Perm code={perm}><Button type="primary" onClick={onClick}>{label}</Button></Perm>`。
   *
   * 单独给一个 prop，是因为这五行是每一张列表页都要重抄一遍的东西——蓝图 §5.2 说
   * 这一层要「取代 145 个手写 Table」，那 145 个里有 145 个都有这个按钮。
   */
  create?: { label?: ReactNode; perm?: PermissionExpr; onClick: () => void }
  /** 行操作；填了就自动追加一列「操作」，带 `perm` 的会用 `<Perm>` 包起来 */
  actions?: RowAction<T>[]
  /** 操作列宽度 */
  actionsWidth?: number
  /** 开启多选（批量操作） */
  selectable?: boolean
  /** 有选中项时显示的批量工具条 */
  batchToolbar?: (selectedKeys: string[]) => ReactNode
  /** 表格尺寸 */
  size?: 'small' | 'middle' | 'large'
  /** 空数据文案 */
  emptyText?: ReactNode
}

function SearchForm({
  schema,
  initialValues,
  onSubmit,
  onReset,
}: {
  schema: SearchField[]
  initialValues: Record<string, unknown>
  onSubmit: (values: Record<string, unknown>) => void
  onReset: () => void
}) {
  const [form] = Form.useForm<Record<string, unknown>>()
  if (schema.length === 0) return null
  return (
    <Form
      form={form}
      layout="inline"
      initialValues={initialValues}
      onFinish={onSubmit}
      style={{ marginBottom: 16, rowGap: 8 }}
    >
      {schema.map((field) => (
        <Form.Item key={field.name} name={field.name} label={field.label}>
          {field.type === 'select' ? (
            <Select
              allowClear
              placeholder={field.placeholder ?? '全部'}
              options={field.options}
              style={{ width: field.width ?? 160 }}
            />
          ) : (
            <Input
              allowClear
              placeholder={field.placeholder ?? `请输入${field.label}`}
              style={{ width: field.width ?? 180 }}
            />
          )}
        </Form.Item>
      ))}
      <Form.Item>
        <Space>
          <Button type="primary" htmlType="submit">
            查询
          </Button>
          <Button
            onClick={() => {
              form.resetFields()
              onReset()
            }}
          >
            重置
          </Button>
        </Space>
      </Form.Item>
    </Form>
  )
}

function ActionButton<T>({ action, row }: { action: RowAction<T>; row: T }) {
  const disabled = action.disabled?.(row) ?? false
  const button = (
    <Button type="link" size="small" danger={action.danger} disabled={disabled}>
      {action.label}
    </Button>
  )

  const node =
    action.confirm === undefined ? (
      <Button
        type="link"
        size="small"
        danger={action.danger}
        disabled={disabled}
        onClick={() => void action.onClick(row)}
      >
        {action.label}
      </Button>
    ) : (
      <Popconfirm
        title={typeof action.confirm === 'function' ? action.confirm(row) : action.confirm}
        okText="确定"
        cancelText="取消"
        okButtonProps={{ danger: action.danger }}
        onConfirm={() => void action.onClick(row)}
        disabled={disabled}
      >
        {button}
      </Popconfirm>
    )

  // 带权限点的行操作一律用 <Perm> 包：没权限的人连按钮都看不到，
  // 和后端守卫用的是同一个 code（前端藏、后端拒，双向对齐）。
  return action.perm === undefined ? node : <Perm code={action.perm}>{node}</Perm>
}

/**
 * AntD `<Table>` 的 CRUD 封装（蓝图 §5.2）：顶部搜索表单 + 右上角工具栏插槽 +
 * 表格 + 分页 + 行操作（带 `<Perm>` 包裹）+ 可选的批量选择。
 *
 * 它自己不发请求、不存状态——全部来自 `useCrudTable()`。这样「同一份数据换一种展示」
 * （比如再挂一个卡片视图）不需要把状态逻辑抄一遍。
 */
export function CrudTable<T extends object>({
  table,
  columns,
  title,
  toolbar,
  create,
  actions,
  actionsWidth,
  selectable = false,
  batchToolbar,
  size = 'middle',
  emptyText,
}: CrudTableProps<T>) {
  const allColumns = useMemo<ColumnsType<T>>(() => {
    if (actions === undefined || actions.length === 0) return columns
    const actionColumn: ColumnType<T> = {
      title: '操作',
      key: '__actions',
      width: actionsWidth ?? 160,
      fixed: 'right',
      render: (_value: unknown, row: T) => (
        <Space size={0} wrap>
          {actions
            .filter((action) => !(action.hidden?.(row) ?? false))
            .map((action) => (
              <ActionButton key={action.key} action={action} row={row} />
            ))}
        </Space>
      ),
    }
    return [...columns, actionColumn]
  }, [columns, actions, actionsWidth])

  const pagination: TablePaginationConfig = {
    current: table.page,
    pageSize: table.pageSize,
    total: table.total,
    showSizeChanger: true,
    showTotal: (total) => `共 ${total} 条`,
  }

  const onChange = (
    nextPagination: TablePaginationConfig,
    _filters: unknown,
    sorter: SorterResult<T> | SorterResult<T>[],
  ): void => {
    const single = Array.isArray(sorter) ? sorter[0] : sorter
    const order: SortOrder | undefined =
      single?.order === 'ascend' ? 'asc' : single?.order === 'descend' ? 'desc' : undefined
    const field = typeof single?.field === 'string' ? single.field : undefined
    table.setSort(order === undefined ? undefined : field, order)
    table.setPage(nextPagination.current ?? 1, nextPagination.pageSize ?? table.pageSize)
  }

  const createButton =
    create === undefined ? null : (
      <Button type="primary" onClick={create.onClick}>
        {create.label ?? '新增'}
      </Button>
    )

  return (
    <Card
      title={title}
      extra={
        <Space>
          {toolbar}
          {create?.perm === undefined ? (
            createButton
          ) : (
            <Perm code={create.perm}>{createButton}</Perm>
          )}
        </Space>
      }
      styles={{ body: { paddingTop: table.searchSchema.length > 0 ? 16 : 0 } }}
    >
      <SearchForm
        schema={table.searchSchema}
        initialValues={table.search}
        onSubmit={table.submitSearch}
        onReset={table.resetSearch}
      />

      {selectable && table.selectedKeys.length > 0 && (
        <Space style={{ marginBottom: 12 }}>
          <span>已选 {table.selectedKeys.length} 项</span>
          {batchToolbar?.(table.selectedKeys)}
          <Button size="small" onClick={table.clearSelection}>
            取消选择
          </Button>
        </Space>
      )}

      <Table<T>
        rowKey={table.keyOf}
        size={size}
        columns={allColumns}
        dataSource={table.rows}
        loading={table.loading}
        pagination={pagination}
        onChange={onChange}
        scroll={{ x: 'max-content' }}
        locale={emptyText !== undefined ? { emptyText } : undefined}
        rowSelection={
          selectable
            ? {
                selectedRowKeys: table.selectedKeys,
                onChange: (keys) => table.setSelectedKeys(keys.map(String)),
              }
            : undefined
        }
      />
    </Card>
  )
}
