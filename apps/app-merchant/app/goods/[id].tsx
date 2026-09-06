import {
  Card,
  ErrorState,
  SkeletonList,
  colors,
  formatWithTrace,
  spacing,
  textVariants,
} from '@taizan/app-ui'
import { ApiError } from '@taizan/contracts'
import { useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { Text, View } from 'react-native'

import { api } from '../../src/api'
import type { GoodsView } from '../../src/types'

/** `GET /api/admin/goods/:id`：商家端有真的详情接口（C 端目前没有）。 */
export default function GoodsDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const [goods, setGoods] = useState<GoodsView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    if (!id) return
    setLoading(true)
    setError(null)
    api
      .get<GoodsView>(`/admin/goods/${id}`)
      .then(setGoods)
      .catch((e: unknown) => setError(e instanceof ApiError ? formatWithTrace(e) : '加载失败'))
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => load(), [load])

  if (loading) {
    return <SkeletonList rows={3} />
  }
  if (error || !goods) {
    return <ErrorState message={error ?? '商品不存在'} onRetry={load} />
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bgBase, padding: spacing.lg }}>
      <Card padded>
        <Text style={{ fontSize: textVariants.title.fontSize, fontWeight: '700' }}>
          {goods.name}
        </Text>
        <Text
          style={{
            fontSize: textVariants.body.fontSize,
            color: colors.error,
            fontWeight: '700',
            marginTop: spacing.sm,
          }}
        >
          ¥{(goods.priceCents / 100).toFixed(2)}
        </Text>
        <Text
          style={{
            fontSize: textVariants.sub.fontSize,
            color: colors.gray[500] ?? '#999',
            marginTop: spacing.xs,
          }}
        >
          库存 {goods.stock} · 状态 {goods.status}
        </Text>
        <Text
          style={{
            fontSize: textVariants.micro.fontSize,
            color: colors.gray[400] ?? '#aaa',
            marginTop: spacing.lg,
          }}
        >
          创建于 {goods.createdAt}
        </Text>
      </Card>
    </View>
  )
}
