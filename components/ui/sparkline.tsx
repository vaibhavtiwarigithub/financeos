'use client'

import { ResponsiveContainer, LineChart, Line } from 'recharts'

interface SparklineProps {
  data: number[]
  width?: number
  height?: number
  invert?: boolean
  color?: string
  strokeWidth?: number
  className?: string
}

export function Sparkline({ data, width = 80, height = 24, invert = false, color, strokeWidth = 1.5, className }: SparklineProps) {
  if (!data || data.length < 2) {
    return <div className={className} style={{ width, height, background: 'var(--fo-border-solid)', borderRadius: 2 }} />
  }

  const first = data[0]
  const last  = data[data.length - 1]
  const isUp  = last >= first
  const good  = invert ? !isUp : isUp
  const stroke = color ?? (good ? 'var(--fo-green)' : 'var(--fo-red)')
  const points = data.map((v, i) => ({ i, v }))

  return (
    <div className={className} style={{ width, height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
          <Line type="monotone" dataKey="v" stroke={stroke} strokeWidth={strokeWidth} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
