import { Tag, Typography } from 'antd'
import type { ColumnType } from 'antd/es/table'
import { formatCents } from '@taizan/contracts'

/** 常用列工厂的公共入参。 */
interface BaseColumnInput {
  title: string
  dataIndex: string
  width?: number
  /** 开启该列排序（走服务端排序：`useCrudTable` 会把 `sortBy/sortOrder` 发给 `list()`） */
  sorter?: boolean
}

function base<T>(input: BaseColumnInput): ColumnType<T> {
  return {
    title: input.title,
    dataIndex: input.dataIndex,
    key: input.dataIndex,
    ...(input.width !== undefined ? { width: input.width } : {}),
    ...(input.sorter === true ? { sorter: true } : {}),
  }
}

function readCell(row: unknown, dataIndex: string): unknown {
  if (row === null || typeof row !== 'object') return undefined
  return (row as Record<string, unknown>)[dataIndex]
}

/**
 * 金额列：库里存的是「分」（`Int`，蓝图 §3.1 禁 `Decimal`/浮点），这里转成「元」展示。
 *
 * 右对齐 + 等宽数字：金额列不对齐的话，扫一眼看不出哪个更大，对账时全靠一位位数。
 */
export function moneyColumn<T>(
  input: BaseColumnInput & { currencySymbol?: string; grouping?: boolean },
): ColumnType<T> {
  return {
    ...base<T>(input),
    align: 'right',
    render: (_value: unknown, row: T) => {
      const cents = readCell(row, input.dataIndex)
      if (typeof cents !== 'number' || !Number.isInteger(cents)) return '-'
      return (
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {formatCents(cents, {
            currencySymbol: input.currencySymbol ?? '¥',
            grouping: input.grouping ?? true,
          })}
        </span>
      )
    },
  }
}

/**
 * 把 ISO 时间串格式化成 `YYYY-MM-DD HH:mm`（本地时区）。
 *
 * 不引 dayjs/date-fns：这是本包唯一一处日期格式化需求，为它加一个运行时依赖
 * （还得让宿主应用一起装）不划算。需要更复杂的格式化时，业务侧自己传 `render`。
 */
export function formatDateTime(value: unknown, withSeconds = false): string {
  if (value === null || value === undefined || value === '') return '-'
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) return '-'
  const pad = (n: number): string => String(n).padStart(2, '0')
  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return withSeconds ? `${ymd} ${hm}:${pad(date.getSeconds())}` : `${ymd} ${hm}`
}

/** 时间列：ISO 串 → `YYYY-MM-DD HH:mm`（本地时区）；空值显示 `-` 而不是 `Invalid Date`。 */
export function dateTimeColumn<T>(
  input: BaseColumnInput & { withSeconds?: boolean },
): ColumnType<T> {
  return {
    ...base<T>(input),
    width: input.width ?? 170,
    render: (_value: unknown, row: T) =>
      formatDateTime(readCell(row, input.dataIndex), input.withSeconds ?? false),
  }
}

/**
 * 枚举列：把后端的枚举值翻成中文标签。
 *
 * 映射表里没有的值**原样显示**，不显示 `-`：后端加了个新枚举值而前端没跟上时，
 * 「显示 DRAFT」还能让人猜到发生了什么，「显示 -」只会让人以为数据丢了。
 */
export function enumColumn<T>(
  input: BaseColumnInput & { map: Record<string, string> },
): ColumnType<T> {
  return {
    ...base<T>(input),
    render: (_value: unknown, row: T) => {
      const raw = readCell(row, input.dataIndex)
      if (raw === null || raw === undefined || raw === '') return '-'
      return input.map[String(raw)] ?? String(raw)
    },
  }
}

/** 状态 Tag 的一项配置。 */
export interface StatusTagConfig {
  text: string
  /** antd Tag 的 color（`success`/`error`/`warning`/`processing`/`default` 或色值） */
  color?: string
}

/** 状态列：枚举值 → 带颜色的 `<Tag>`；未登记的值退化成灰色 Tag 并原样显示。 */
export function statusTagColumn<T>(
  input: BaseColumnInput & { map: Record<string, StatusTagConfig> },
): ColumnType<T> {
  return {
    ...base<T>(input),
    width: input.width ?? 100,
    render: (_value: unknown, row: T) => {
      const raw = readCell(row, input.dataIndex)
      if (raw === null || raw === undefined || raw === '') return '-'
      const conf = input.map[String(raw)]
      return <Tag color={conf?.color ?? 'default'}>{conf?.text ?? String(raw)}</Tag>
    },
  }
}

/**
 * 长文本列：超出宽度省略，鼠标悬停看全文，并可一键复制。
 *
 * ID 列尤其需要它——ULID 有 26 个字符，占满一整列还没人看得清，但排障时又必须复制得出来。
 */
export function textColumn<T>(input: BaseColumnInput & { copyable?: boolean }): ColumnType<T> {
  return {
    ...base<T>(input),
    render: (_value: unknown, row: T) => {
      const raw = readCell(row, input.dataIndex)
      if (raw === null || raw === undefined || raw === '') return '-'
      const text = String(raw)
      return (
        <Typography.Text
          ellipsis={{ tooltip: text }}
          copyable={input.copyable === true ? { text } : false}
          style={{ maxWidth: input.width ?? 240 }}
        >
          {text}
        </Typography.Text>
      )
    },
  }
}

/** 序号列（当前页内的序号，跟着分页走）。 */
export function indexColumn<T>(page: number, pageSize: number, title = '#'): ColumnType<T> {
  return {
    title,
    key: '__index',
    width: 64,
    render: (_value: unknown, _row: T, index: number) => (page - 1) * pageSize + index + 1,
  }
}
