import type { CrudListQuery, StatusTagConfig } from '@taizan/admin-ui'
import type { PageResult } from '@taizan/contracts'
import { useSession } from '../session'

/** 一行商品（对齐 `apps/api/src/modules/example-goods/dto/goods.dto.ts` 的 `GoodsView`）。 */
export interface Goods {
  id: string
  name: string
  priceCents: number
  stock: number
  status: 'DRAFT' | 'ON_SHELF' | 'OFF_SHELF'
  createdAt: string
  updatedAt: string
}

/** 新建/编辑时提交的字段（对齐 `CreateGoodsDto`/`UpdateGoodsDto`）。 */
export type GoodsInput = Pick<Goods, 'name' | 'priceCents' | 'stock' | 'status'>

/** 状态列的枚举 → Tag 配置。 */
export const GOODS_STATUS: Record<Goods['status'], StatusTagConfig> = {
  ON_SHELF: { text: '在售', color: 'success' },
  OFF_SHELF: { text: '下架' },
  DRAFT: { text: '草稿', color: 'processing' },
}

/**
 * 商品模块的接口层：五个函数对齐 `GoodsController`（蓝图 §5.2 的标准形状）。
 * 页面里不直接拼 URL，是为了让业务页面只剩下「长什么样」这一件事。
 */
export function useGoodsApi() {
  const req = useSession((s) => s.request)
  return {
    list: (query: CrudListQuery) => req.get<PageResult<Goods>>('/api/admin/goods', query),
    get: (id: string) => req.get<Goods>(`/api/admin/goods/${id}`),
    create: (values: GoodsInput) => req.post('/api/admin/goods', values),
    update: (id: string, values: GoodsInput) => req.put(`/api/admin/goods/${id}`, values),
    remove: (row: Goods) => req.delete<void>(`/api/admin/goods/${row.id}`),
    /** 导出（`GET /api/admin/goods/export`，`goods:export` 权限点）：不分页，返回全量。 */
    exportAll: () => req.get<Goods[]>('/api/admin/goods/export'),
  }
}
