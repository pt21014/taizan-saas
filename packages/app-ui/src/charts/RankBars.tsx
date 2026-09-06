import React from 'react'
import { Text, View } from 'react-native'

import { colors, spacing, textVariants } from '../tokens'

export interface RankRow {
  title: string
  revenueCents: number
  orderCount: number
}

const MUTED = colors.gray[500] ?? '#8a8f98'
const TRACK = colors.gray[100] ?? '#f0f1f3'

/** 排行条：单色、数据端圆角、条间留底色间隙——搬自 knowledge 的最小实现。 */
export function RankBars({ rows }: { rows: RankRow[] }) {
  if (rows.length === 0) {
    return (
      <Text style={{ fontSize: textVariants.sub.fontSize, color: MUTED }}>这个区间还没有成交</Text>
    )
  }
  const max = Math.max(...rows.map((r) => r.revenueCents), 1)
  return (
    <View style={{ gap: spacing.lg }}>
      {rows.map((r, i) => (
        <View key={`${r.title}-${i}`}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'baseline',
              gap: spacing.sm,
              marginBottom: 6,
            }}
          >
            <Text style={{ fontSize: textVariants.micro.fontSize, color: MUTED, width: 14 }}>
              {i + 1}
            </Text>
            <Text
              style={{ fontSize: textVariants.sub.fontSize, flex: 1, color: colors.textBase }}
              numberOfLines={1}
            >
              {r.title}
            </Text>
            <Text
              style={{
                fontSize: textVariants.sub.fontSize,
                fontWeight: '600',
                color: colors.textBase,
              }}
            >
              ¥{(r.revenueCents / 100).toLocaleString('zh-CN')}
            </Text>
          </View>
          <View style={{ height: 8, borderRadius: 4, backgroundColor: TRACK, marginLeft: 22 }}>
            <View
              style={{
                width: `${Math.max(3, (r.revenueCents / max) * 100)}%`,
                height: '100%',
                borderRadius: 4,
                backgroundColor: colors.primary,
                opacity: 1 - i * 0.13,
              }}
            />
          </View>
        </View>
      ))}
    </View>
  )
}
