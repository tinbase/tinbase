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
    theme: 'github-dark-default',
    colorReplacements: { '#0d1117': 'transparent' },
  })
  return (
    <div
      className={cn(
        'overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900 p-5 font-mono text-[13px] leading-relaxed [&_pre]:!bg-transparent',
        className
      )}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
