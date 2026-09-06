import React from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, type ViewStyle } from 'react-native'

import { HIT_MIN, colors, radius, textVariants, withAlpha } from '../tokens'

export type ButtonKind = 'primary' | 'plain' | 'ghost'

export interface ButtonProps {
  title?: string
  onPress?: () => void
  kind?: ButtonKind
  /** 不可逆动作（退款/删除/下架）用红色，颜色收在这里，不让页面各自写死。 */
  danger?: boolean
  disabled?: boolean
  loading?: boolean
  small?: boolean
  style?: ViewStyle
  children?: React.ReactNode
}

/** 基础按钮（蓝图 §5.4）。三种视觉分级（primary/plain/ghost）覆盖两个 App 的绝大多数场景。 */
export function Button({
  title,
  onPress,
  kind = 'primary',
  danger,
  disabled,
  loading,
  small,
  style,
  children,
}: ButtonProps) {
  const main = danger ? colors.error : colors.primary
  const bg = kind === 'primary' ? main : kind === 'ghost' ? withAlpha(main, 0.1) : colors.bgBase
  const fg =
    kind === 'primary'
      ? (colors.gray[0] ?? '#fff')
      : kind === 'ghost'
        ? main
        : danger
          ? colors.error
          : colors.textBase

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.base,
        small && styles.small,
        { backgroundColor: bg, borderRadius: radius.md },
        kind === 'plain' && {
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.gray[300],
        },
        (disabled || loading) && { opacity: 0.42 },
        pressed && { transform: [{ scale: 0.98 }] },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} size="small" />
      ) : (
        (children ?? (
          <Text style={{ color: fg, fontSize: textVariants.body.fontSize, fontWeight: '600' }}>
            {title}
          </Text>
        ))
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  base: {
    minHeight: HIT_MIN,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  small: { minHeight: 32, paddingHorizontal: 12 },
})
