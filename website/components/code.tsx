import { codeToHtml } from 'shiki'
import { cn } from '@/lib/utils'

/** Server-rendered syntax-highlighted code block (shiki, zero client JS). */
export async function Code({
  code,
  lang = 'ts',
  className,
}: {
  code: string
  lang?: string
  className?: string
}) {
  const html = await codeToHtml(code, {
    lang,
    themes: { light: 'github-light-default', dark: 'github-dark-default' },
  })
  return (
    <div
      className={cn(
        'overflow-x-auto rounded-xl border border-border bg-surface-2 p-5 font-mono text-[13px] leading-relaxed [&_pre]:!bg-transparent',
        className
      )}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
