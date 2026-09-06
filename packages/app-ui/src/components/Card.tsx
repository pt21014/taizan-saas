import React from 'react'
import { StyleSheet, View, type ViewStyle } from 'react-native'

import { colors, radius, shadow, spacing } from '../tokens'

export interface CardProps {
  children: React.ReactNode
  style?: ViewStyle | ViewStyle[]
  padded?: boolean
}

/** 卡片容器：白底、发丝描边、极浅阴影——列表页与详情页共用的最小分组单位。 */
export function Card({ children, style, padded }: CardProps) {
  return <View style={[styles.card, padded && { padding: spacing.lg }, style]}>{children}</View>
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgBase,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.gray[200] ?? '#eee',
    overflow: 'hidden',
    ...shadow.sm,
  },
})
