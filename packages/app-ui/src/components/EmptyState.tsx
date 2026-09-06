import React from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { colors, spacing, textVariants } from '../tokens'
import { Button } from './Button'

export interface EmptyStateProps {
  title: string
  hint?: string
  action?: string
  onAction?: () => void
}

/**
 * 空状态。**说清「为什么空」并给一个可按的东西**，不是一句「暂无数据」——
 * 后者让人分不清是自己还没操作、还是页面坏了。
 */
export function EmptyState({ title, hint, action, onAction }: EmptyStateProps) {
  return (
    <View style={styles.center}>
      <Text
        style={{
          fontSize: textVariants.body.fontSize,
          color: colors.gray[600] ?? '#666',
          textAlign: 'center',
        }}
      >
        {title}
      </Text>
      {hint ? (
        <Text
          style={{
            fontSize: textVariants.sub.fontSize,
            color: colors.gray[500] ?? '#999',
            marginTop: spacing.xs,
            textAlign: 'center',
          }}
        >
          {hint}
        </Text>
      ) : null}
      {action ? (
        <Button
          kind="ghost"
          small
          title={action}
          onPress={onAction}
          style={{ marginTop: spacing.lg }}
        />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  center: { paddingVertical: 56, paddingHorizontal: 32, alignItems: 'center' },
})
