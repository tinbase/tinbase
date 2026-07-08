import * as Dialog from '@radix-ui/react-dialog'
import clsx from 'clsx'
import { X } from 'lucide-react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'

export function Button({
  variant = 'default',
  size = 'sm',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'outline' | 'ghost' | 'danger'; size?: 'sm' | 'xs' }) {
  const variants = {
    default: 'bg-emerald-600 text-white hover:bg-emerald-500 font-medium',
    outline: 'border border-neutral-700 text-neutral-200 hover:bg-neutral-800 hover:border-neutral-600',
    ghost: 'text-neutral-300 hover:bg-neutral-800',
    danger: 'border border-red-900/60 text-red-400 hover:bg-red-950/40',
  }
  return (
    <button
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-md transition-colors disabled:opacity-50 disabled:pointer-events-none',
        size === 'sm' ? 'h-8 px-3 text-[13px]' : 'h-6 px-2 text-xs',
        variants[variant],
        className
      )}
      {...props}
    />
  )
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={clsx(
        'h-8 w-full rounded-md border border-neutral-700 bg-neutral-900 px-2.5 text-[13px] text-neutral-100',
        'placeholder:text-neutral-600 focus:border-brand focus:outline-none',
        className
      )}
      {...props}
    />
  )
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={clsx(
        'w-full rounded-md border border-neutral-700 bg-neutral-900 p-3 font-mono text-[13px] text-neutral-100',
        'placeholder:text-neutral-600 focus:border-brand focus:outline-none',
        className
      )}
      {...props}
    />
  )
}

export function Label({ children }: { children: ReactNode }) {
  return <label className="mb-1 block text-xs font-medium text-neutral-400">{children}</label>
}

export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  wide?: boolean
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          className={clsx(
            'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-neutral-700 bg-neutral-850 bg-[#1f1f1f] shadow-2xl',
            'max-h-[85vh] overflow-auto',
            wide ? 'w-[640px]' : 'w-[440px]'
          )}
        >
          <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
            <Dialog.Title className="text-sm font-semibold">{title}</Dialog.Title>
            <Dialog.Close className="text-neutral-500 hover:text-neutral-200">
              <X size={16} />
            </Dialog.Close>
          </div>
          <div className="p-4">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function Spinner() {
  return (
    <div className="flex items-center justify-center py-16 text-neutral-500">
      <div className="size-5 animate-spin rounded-full border-2 border-neutral-700 border-t-brand" />
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-16 text-center text-[13px] text-neutral-500">{children}</div>
}
