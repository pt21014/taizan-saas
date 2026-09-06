/**
 * `GET /api/client/goods`（`apps/api/src/modules/client/goods/client-goods.controller.ts`）。
 * 类型形状对齐后端 `GoodsView`（不含 `tenantId`），故意在这里重新声明而不是从
 * `apps/api` 导入——C 端不应该依赖后端源码，两边形状一致靠人工对照 + 联调断言即可。
 *
 * @packageDocumentation
 */

import type { PageResult } from '@taizan/contracts'

import { request } from './client'

export interface GoodsView {
  id: string
  name: string
  priceCents: number
  stock: number
  status: 'DRAFT' | 'ON_SHELF' | 'OFF_SHELF'
  createdAt: string
  updatedAt: string
}

export interface ListGoodsParams {
  page?: number
  pageSize?: number
  [key: string]: unknown
}

export function listGoods(params: ListGoodsParams = {}): Promise<PageResult<GoodsView>> {
  return request.get<PageResult<GoodsView>>('/api/client/goods', params)
}
