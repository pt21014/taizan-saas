import {
  Card,
  EmptyState,
  ErrorState,
  ListItem,
  SkeletonList,
  colors,
  formatWithTrace,
} from '@taizan/app-ui'
import { ApiError, type PageResult } from '@taizan/contracts'
import { router } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { FlatList, Text, View } from 'react-native'

import { api } from '../../src/api'
import type { GoodsView } from '../../src/types'

/** `GET /api/admin/goods`：`@RequirePermission('goods:list')`，按数据范围收窄。 */
export default function GoodsListScreen() {
  const [items, setItems] = useState<GoodsView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    api
      .get<PageResult<GoodsView>>('/admin/goods', { page: 1, pageSize: 20 })
      .then((res) => setItems(res.items))
      .catch((e: unknown) => setError(e instanceof ApiError ? formatWithTrace(e) : '加载失败'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => load(), [load])

  return (
    <View style={{ flex: 1, backgroundColor: colors.bgBase }}>
      {loading ? (
        <SkeletonList rows={6} />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !items || items.length === 0 ? (
        <EmptyState
          title="还没有商品"
          hint="去后台网页版新建，或等业务模块补上移动端的新建表单。"
        />
      ) : (
        <Card style={{ margin: 16 }}>
          <FlatList
            data={items}
            keyExtractor={(item) => item.id}
            renderItem={({ item, index }) => (
              <ListItem
                first={index === 0}
                title={item.name}
                subtitle={`${item.status} · 库存 ${item.stock}`}
                right={
                  <Text style={{ color: colors.error, fontWeight: '700' }}>
                    ¥{(item.priceCents / 100).toFixed(2)}
                  </Text>
                }
                onPress={() => router.push({ pathname: '/goods/[id]', params: { id: item.id } })}
              />
            )}
          />
        </Card>
      )}
    </View>
  )
}
