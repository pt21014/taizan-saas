import React, { useEffect, useRef } from 'react'
import { Animated, StyleSheet, View, type ViewStyle } from 'react-native'

import { colors, radius } from '../tokens'

export interface SkeletonProps {
  width?: number | `${number}%`
  height: number
  radius?: number
  style?: ViewStyle
}

/** 加载占位块：呼吸透明度动画，比纯静态灰块更清楚地表达「正在加载」而不是「布局出错」。 */
export function Skeleton({ width = '100%', height, radius: r = radius.md, style }: SkeletonProps) {
  const opacity = useRef(new Animated.Value(0.5)).current

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 600, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.5, duration: 600, useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [opacity])

  return (
    <Animated.View
      style={[
        styles.base,
        { width, height, borderRadius: r, backgroundColor: colors.gray[200] ?? '#e4e6eb', opacity },
        style,
      ]}
    />
  )
}

/** 常见的「列表骨架」——几行 `ListItem` 高度的占位块叠一起。 */
export function SkeletonList({ rows = 3 }: { rows?: number }) {
  return (
    <View>
      {Array.from({ length: rows }).map((_, i) => (
        <View key={i} style={styles.row}>
          <Skeleton width="60%" height={16} />
          <Skeleton width="35%" height={12} style={{ marginTop: 8 }} />
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  base: { overflow: 'hidden' },
  row: { paddingHorizontal: 16, paddingVertical: 13 },
})
