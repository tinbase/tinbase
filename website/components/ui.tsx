/* shadcn-convention primitives (variant-driven, composable via className) */
import { cn } from '@/lib/utils'
import type { ButtonHTMLAttributes, HTMLAttributes, AnchorHTMLAttributes } from 'react'

const buttonVariants = {
  default: 'bg-emerald-600 text-white hover:bg-emerald-500',
  outline: 'border border-zinc-700 text-zinc-200 hover:bg-zinc-800/60 hover:text-white',
  ghost: 'text-zinc-300 hover:bg-zinc-800/60 hover:text-white',
}

export function Button({
  variant = 'default',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof buttonVariants }) {
  return (
    <button
      className={cn(
        'inline-flex h-10 items-center justify-center gap-2 rounded-lg px-5 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-emerald-400',
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
        'inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300',
        className
      )}
      {...props}
    />
  )
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-xl border border-zinc-800 bg-zinc-900/60 p-6', className)}
      {...props}
    />
  )
}
