import { Button, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useState } from 'react'

import { formatCents } from '@taizan/contracts'

import { session } from '../../services/client'
import { listGoods, type GoodsView } from '../../services/goods'

import './index.scss'

/**
 * C 端商品列表：`GET /api/client/goods`（见 `apps/api/src/modules/client/goods`）。
 *
 * 后端这条路由刻意要求 `@Auth('member')`（真实项目通常是逛店免登录的 `@Public()`），
 * 目的是让「token 里的租户压过请求头里的 slug」这条不变量能被 e2e 断言到——
 * 所以这里未登录时先给一个登录入口，而不是直接拉列表。
 */
export default function Index() {
  const [goods, setGoods] = useState<GoodsView[]>([])
  const [loading, setLoading] = useState(false)
  const [loggedIn, setLoggedIn] = useState(false)

  useDidShow(() => {
    const isLoggedIn = session.isLoggedIn()
    setLoggedIn(isLoggedIn)
    if (isLoggedIn) fetchGoods()
  })

  async function fetchGoods() {
    setLoading(true)
    try {
      const res = await listGoods({ page: 1, pageSize: 20 })
      setGoods(res.items)
    } finally {
      setLoading(false)
    }
  }

  function gotoDetail(item: GoodsView) {
    void Taro.navigateTo({
      url: `/pages/goods/detail/index?id=${item.id}&name=${encodeURIComponent(item.name)}&priceCents=${item.priceCents}`,
    })
  }

  if (!loggedIn) {
    return (
      <View className="goods-list">
        <View className="goods-list__login-tip">登录后查看商品</View>
        <Button
          className="login-btn"
          onClick={() => Taro.navigateTo({ url: '/pages/login/index' })}
        >
          去登录
        </Button>
      </View>
    )
  }

  return (
    <View className="goods-list">
      {!loading && goods.length === 0 && <View className="goods-list__empty">暂无商品</View>}
      {goods.map((item) => (
        <View key={item.id} className="goods-item" onClick={() => gotoDetail(item)}>
          <View className="goods-item__name">{item.name}</View>
          <View className="goods-item__price">¥{formatCents(item.priceCents)}</View>
        </View>
      ))}
    </View>
  )
}
