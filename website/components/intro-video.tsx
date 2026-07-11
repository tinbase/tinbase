import { cn } from '@/lib/utils'

/**
 * Cloudflare Stream intro video, embedded via the generic iframe player.
 * Framed like a Card, no client JS — the player loads lazily in its iframe.
 *
 * The frame is sized to the video's *exact* native aspect ratio (width/height),
 * and both the frame background and the player's letterbox color are pinned to
 * the recording's own near-black edge (#0a0a0a). The player still rounds the
 * video box to 16:9 internally and pillarboxes by a hair; matching that color
 * to the footage (which is dark in either site theme) makes the sliver vanish,
 * whereas a transparent letterbox would reveal the lighter frame surface as a
 * faint grey line on each side.
 */
export function IntroVideo({
  videoId,
  title = 'tinbase intro',
  width = 3554,
  height = 2000,
  className,
}: {
  videoId: string
  title?: string
  width?: number
  height?: number
  className?: string
}) {
  return (
    <div
      style={{ aspectRatio: `${width} / ${height}` }}
      className={cn(
        'relative w-full overflow-hidden rounded-xl border border-border bg-[#0a0a0a] shadow-2xl shadow-black/5 ring-1 ring-black/5 dark:shadow-black/40',
        className
      )}
    >
      <iframe
        src={`https://iframe.videodelivery.net/${videoId}?letterboxColor=%230a0a0a`}
        title={title}
        loading="lazy"
        allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture;"
        allowFullScreen
        className="absolute inset-0 h-full w-full border-0"
      />
    </div>
  )
}
