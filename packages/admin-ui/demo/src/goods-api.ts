import type { CrudListQuery, PageResult, StatusTagConfig } from '@taizan/admin-ui'
import { useSession } from './session'

/** 一行商品（对齐 mock 后端 `/api/admin/goods` 的返回形状）。 */
export interface Goods {
  id: string
  name: string
  priceCents: number
  status: 'ON' | 'OFF'
  createdAt: string
}

/** 新建/编辑时提交的字段。 */
export type GoodsInput = Pick<Goods, 'name' | 'priceCents'>

/** 状态列的枚举 → Tag 配置。 */
export const GOODS_STATUS: Record<string, StatusTagConfig> = {
  ON: { text: '在售', color: 'success' },
  OFF: { text: '下架' },
}

/**
 * 商品模块的接口层。
 *
 * 页面里不直接拼 URL，是为了让「一个业务列表页」只剩下「长什么样」这一件事——
 * `apps/admin` 里这一层通常由 `src/api/*.ts` 承担（每个模块一个文件，五个函数）。
 */
export function useGoodsApi() {
  const req = useSession((s) => s.request)
  return {
    list: (query: CrudListQuery) => req.get<PageResult<Goods>>('/api/admin/goods', query),
    get: (id: string) => req.get<Goods>(`/api/admin/goods/${id}`),
    create: (values: GoodsInput) => req.post('/api/admin/goods', values),
    update: (id: string, values: GoodsInput) => req.put(`/api/admin/goods/${id}`, values),
    remove: (row: Goods) => req.delete<void>(`/api/admin/goods/${row.id}`),
  }
}
