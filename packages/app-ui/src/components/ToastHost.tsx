import React, { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { colors, radius, spacing, textVariants } from '../tokens'
import { toast, type ToastMessage, type ToastStore } from './Toast'

/** 挂在根布局最外层一次即可：`<ToastHost />`；测试专用实例可传 `store`。 */
export function ToastHost({ store = toast }: { store?: ToastStore }) {
  const [message, setMessage] = useState<ToastMessage | null>(store.getState())

  useEffect(() => store.subscribe(() => setMessage(store.getState())), [store])

  if (!message) return null
  return (
    <View pointerEvents="none" style={styles.wrap}>
      <View style={[styles.bubble, message.tone === 'error' && { backgroundColor: colors.error }]}>
        <Text style={{ color: '#fff', fontSize: textVariants.sub.fontSize }}>{message.text}</Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 64,
    alignItems: 'center',
  },
  bubble: {
    maxWidth: '84%',
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    borderRadius: radius.full,
    backgroundColor: 'rgba(28,30,33,0.92)',
  },
})
