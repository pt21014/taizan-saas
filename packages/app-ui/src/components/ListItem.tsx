import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { HIT_MIN, colors, spacing, textVariants } from '../tokens'

export interface ListItemProps {
  title: string
  subtitle?: string
  right?: React.ReactNode
  onPress?: () => void
  /** 第一行不画顶部分隔线——分隔线是行与行之间的关系，不是卡片自己的边框。 */
  first?: boolean
}

/** 列表行：标题 + 可选副标题 + 右侧插槽（金额/箭头/开关都塞这里）。 */
export function ListItem({ title, subtitle, right, onPress, first }: ListItemProps) {
  const inner = (
    <View style={[styles.row, !first && styles.divided]}>
      <View style={styles.texts}>
        <Text
          style={{ fontSize: textVariants.body.fontSize, color: colors.textBase }}
          numberOfLines={1}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text
            style={{
              fontSize: textVariants.sub.fontSize,
              color: colors.gray[500] ?? '#999',
              marginTop: 2,
            }}
            numberOfLines={1}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
    </View>
  )
  if (!onPress) return inner
  return (
    <Pressable onPress={onPress} android_ripple={{ color: colors.gray[100] ?? '#f0f0f0' }}>
      {({ pressed }) => (
        <View style={pressed ? { backgroundColor: colors.gray[50] ?? '#fafafa' } : undefined}>
          {inner}
        </View>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: 13,
    minHeight: HIT_MIN,
  },
  texts: { flex: 1, minWidth: 0 },
  divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(0,0,0,0.08)' },
})
