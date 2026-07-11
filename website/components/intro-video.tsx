import { cn } from '@/lib/utils'

/**
 * Cloudflare Stream intro video, embedded via the generic iframe player.
 * 16:9, framed like a Card. No client JS — the player loads lazily in its iframe.
 */
export function IntroVideo({
  videoId,
  title = 'tinbase intro',
  className,
}: {
  videoId: string
  title?: string
  className?: string
}) {
  return (
    <div
      className={cn(
        'relative aspect-video w-full overflow-hidden rounded-xl border border-border bg-surface-2 shadow-2xl shadow-black/5 ring-1 ring-black/5 dark:shadow-black/40',
        className
      )}
    >
      <iframe
        src={`https://iframe.videodelivery.net/${videoId}?letterboxColor=transparent`}
        title={title}
        loading="lazy"
        allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture;"
        allowFullScreen
        className="absolute inset-0 h-full w-full border-0"
      />
    </div>
  )
}
