'use client'

import { ArrowUp, ArrowDown } from 'lucide-react'
import { cn } from '@/lib/utils'

interface PctPillProps {
  value: number
  invert?: boolean
  showSign?: boolean
  size?: 'sm' | 'md'
  className?: string
}

export function PctPill({ value, invert = false, showSign = true, size = 'md', className }: PctPillProps) {
  const isUp    = value >= 0
  const good    = invert ? !isUp : isUp
  const display = `${showSign && isUp ? '+' : ''}${value.toFixed(1)}%`

  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full font-medium tabular-nums',
        size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs',
        good
          ? 'bg-[var(--fo-green-dim)] text-[var(--fo-green)]'
          : 'bg-[var(--fo-red-dim)] text-[var(--fo-red)]',
        className,
      )}
    >
      {isUp
        ? <ArrowUp className={size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3'} strokeWidth={2.5} />
        : <ArrowDown className={size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3'} strokeWidth={2.5} />}
      {display}
    </span>
  )
}
