import React, { useState } from 'react'
import { Text, View, type LayoutChangeEvent } from 'react-native'
import Svg, { Circle, Defs, Line, LinearGradient, Path, Stop } from 'react-native-svg'

import { colors, textVariants } from '../tokens'

export interface TrendPoint {
  date: string
  label: string
  revenueCents: number
  orderCount: number
}

const H = 120
const PAD_BOTTOM = 14
const PAD_TOP = 16
const LINE = colors.gray[200] ?? '#e4e6eb'
const MUTED = colors.gray[500] ?? '#8a8f98'
const HAIRLINE = colors.gray[300] ?? '#d0d3d9'

/**
 * 单序列趋势图（蓝图 §5.4，商家端「数据」屏用）。不画图例（标题已经说明是什么）、
 * 坐标退到背景，只标峰值，其余靠手指按住读数——搬自 knowledge 的最小实现。
 */
export function TrendChart({ data }: { data: TrendPoint[] }) {
  const [w, setW] = useState(0)
  const [hit, setHit] = useState<number | null>(null)
  const onLayout = (e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)

  if (data.length === 0) {
    return (
      <View style={{ height: H, justifyContent: 'center' }}>
        <Text style={{ fontSize: textVariants.sub.fontSize, color: MUTED }}>这个区间没有数据</Text>
      </View>
    )
  }

  const max = Math.max(...data.map((d) => d.revenueCents), 1)
  const stepX = data.length > 1 ? w / (data.length - 1) : 0
  const yOf = (v: number) => H - PAD_BOTTOM - (v / max) * (H - PAD_BOTTOM - PAD_TOP)
  const pts: Array<{ x: number; y: number }> = data.map((d, i) => ({
    x: i * stepX,
    y: yOf(d.revenueCents),
  }))
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
  const area = `${line} L ${w} ${H} L 0 ${H} Z`
  const peakIndex = data.reduce(
    (best, d, i) => (d.revenueCents > data[best]!.revenueCents ? i : best),
    0,
  )
  const peakPoint = pts[peakIndex]!
  const peakData = data[peakIndex]!
  const hitPoint = hit != null ? pts[hit] : undefined
  const hitData = hit != null ? data[hit] : undefined
  const firstLabel = data[0]!.label

  const track = (x: number) => {
    if (!stepX) return setHit(0)
    setHit(Math.max(0, Math.min(data.length - 1, Math.round(x / stepX))))
  }

  return (
    <View onLayout={onLayout}>
      <View
        style={{ height: H }}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={(e) => track(e.nativeEvent.locationX)}
        onResponderMove={(e) => track(e.nativeEvent.locationX)}
        onResponderRelease={() => setHit(null)}
        onResponderTerminate={() => setHit(null)}
      >
        {w > 0 ? (
          <Svg width={w} height={H}>
            <Defs>
              <LinearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={colors.primary} stopOpacity={0.16} />
                <Stop offset="1" stopColor={colors.primary} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            <Line
              x1={0}
              y1={H - PAD_BOTTOM}
              x2={w}
              y2={H - PAD_BOTTOM}
              stroke={LINE}
              strokeWidth={1}
            />
            <Path d={area} fill="url(#trendFill)" />
            <Path
              d={line}
              fill="none"
              stroke={colors.primary}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {data.map((d, i) =>
              d.orderCount === 0 ? (
                <Circle
                  key={d.date}
                  cx={pts[i]!.x}
                  cy={pts[i]!.y}
                  r={3}
                  fill={colors.bgBase}
                  stroke={MUTED}
                  strokeWidth={1.5}
                />
              ) : null,
            )}
            <Circle
              cx={peakPoint.x}
              cy={peakPoint.y}
              r={4}
              fill={colors.primary}
              stroke={colors.bgBase}
              strokeWidth={2}
            />
            {hitPoint ? (
              <>
                <Line
                  x1={hitPoint.x}
                  y1={4}
                  x2={hitPoint.x}
                  y2={H - PAD_BOTTOM}
                  stroke={HAIRLINE}
                  strokeWidth={1}
                />
                <Circle
                  cx={hitPoint.x}
                  cy={hitPoint.y}
                  r={5}
                  fill={colors.primary}
                  stroke={colors.bgBase}
                  strokeWidth={2}
                />
              </>
            ) : null}
          </Svg>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
        <Text style={{ fontSize: textVariants.micro.fontSize, color: MUTED }}>{firstLabel}</Text>
        <Text
          style={{
            fontSize: textVariants.micro.fontSize,
            color: hitData ? colors.textBase : MUTED,
          }}
        >
          {hitData
            ? `${hitData.label} · ¥${(hitData.revenueCents / 100).toLocaleString('zh-CN')}`
            : `峰值 ${peakData.label} · ¥${(peakData.revenueCents / 100).toLocaleString('zh-CN')}`}
        </Text>
      </View>
    </View>
  )
}
