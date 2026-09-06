/**
 * 分页协议（蓝图 §2）。前端传 `PageQuery`，服务端统一走 `normalizePage`/`toSkipTake`
 * 归一化后再查库，避免每个模块各写一套「page 是不是从 0 开始」「pageSize 上限是多少」。
 */

/** 分页查询参数（前端传入，均可选）。 */
export interface PageQuery {
  /** 页码，从 1 开始 */
  page?: number
  /** 每页条数 */
  pageSize?: number
}

/** 分页结果包装。 */
export interface PageResult<T> {
  /** 当前页数据 */
  items: T[]
  /** 总条数 */
  total: number
  /** 归一化后的页码 */
  page: number
  /** 归一化后的每页条数 */
  pageSize: number
}

/** 归一化后的分页参数（保证 `page>=1`、`1<=pageSize<=200`）。 */
export interface NormalizedPage {
  page: number
  pageSize: number
}

/** 默认页码 */
export const DEFAULT_PAGE = 1
/** 默认每页条数 */
export const DEFAULT_PAGE_SIZE = 20
/** 每页条数上限——防止一次拖走全表 */
export const MAX_PAGE_SIZE = 200

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

/**
 * 归一化分页参数：`page` 非法/缺失回落到 1，`pageSize` 非法/缺失回落到 20，
 * 超过 200 的一律截到 200（硬上限，不允许业务方绕过）。
 */
export function normalizePage(query: PageQuery | undefined): NormalizedPage {
  const page = isPositiveInt(query?.page) ? query.page : DEFAULT_PAGE
  let pageSize = isPositiveInt(query?.pageSize) ? query.pageSize : DEFAULT_PAGE_SIZE
  if (pageSize > MAX_PAGE_SIZE) {
    pageSize = MAX_PAGE_SIZE
  }
  return { page, pageSize }
}

/** 把分页参数换算成 Prisma 风格的 `{ skip, take }`（内部先经过 {@link normalizePage}）。 */
export function toSkipTake(query: PageQuery | undefined): { skip: number; take: number } {
  const { page, pageSize } = normalizePage(query)
  return { skip: (page - 1) * pageSize, take: pageSize }
}
