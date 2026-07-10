/* shadcn-convention primitives (variant-driven, composable via className) */
import { cn } from '@/lib/utils'
import type { ButtonHTMLAttributes, HTMLAttributes, AnchorHTMLAttributes } from 'react'

const buttonVariants = {
  default: 'bg-emerald-600 text-white hover:bg-emerald-500',
  outline: 'border border-strong text-fg hover:bg-surface-2 hover:text-fg',
  ghost: 'text-fg hover:bg-surface-2 hover:text-fg',
}

export function Button({
  variant = 'default',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof buttonVariants }) {
  return (
    <button
      className={cn(
        'inline-flex h-10 items-center justify-center gap-2 rounded-lg px-5 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-accent',
        buttonVariants[variant],
        className
      )}
      {...props}
    />
  )
}

export function LinkButton({
  variant = 'default',
  className,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: keyof typeof buttonVariants }) {
  return (
    <a
      className={cn(
        'inline-flex h-10 items-center justify-center gap-2 rounded-lg px-5 text-sm font-semibold transition-colors',
        buttonVariants[variant],
        className
      )}
      {...props}
    />
  )
}

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-accent',
        className
      )}
      {...props}
    />
  )
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-xl border border-border bg-surface p-6', className)}
      {...props}
    />
  )
}
