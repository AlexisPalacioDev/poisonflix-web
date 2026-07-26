import { useEffect, useState } from 'react';

// A cover/thumbnail image that degrades to the ♪ placeholder instead of the
// browser's broken-image glyph. The fallback chain (`resolveCoverUrl`: song →
// album → artist) can still hand us a URL whose actual image request 404s
// (stale image tag, deleted file) — and YouTube thumbnails 404 too. When the
// underlying <img> fires `error`, we swap it for the same ♪ placeholder markup
// used when there's no `src` at all, so a failed load looks identical to "no
// cover" rather than a broken square.
//
// Renders ONLY the inner content (either the <img> or the placeholder <span>),
// never a wrapper element — every call site already provides its own sized
// wrapper div (`.pf-music__art`, `.pf-music__card-art`, `.pf-nowplaying__art`,
// …), and some reuse the same node inside two different wrappers.

export interface CoverImageProps {
  /** The cover URL, or null/undefined when there is no cover to show. */
  src: string | null | undefined;
  /** Optional class for the <img> (wrappers usually own the sizing). */
  className?: string;
  /** Class for the ♪ placeholder <span>, matching each context's look. */
  placeholderClassName?: string;
  /** Native lazy/eager loading hint, forwarded to the <img>. */
  loading?: 'lazy' | 'eager';
  /** Alt text — decorative by default (the title sits next to the cover). */
  alt?: string;
}

export function CoverImage({
  src,
  className,
  placeholderClassName,
  loading,
  alt = '',
}: CoverImageProps) {
  const [failed, setFailed] = useState(false);

  // A new src is a fresh attempt: clear a previous failure so a re-used slot
  // (e.g. the now-playing cover when the track changes, or a virtualised row)
  // tries to load the new image instead of staying stuck on the placeholder.
  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!src || failed) {
    return (
      <span className={placeholderClassName} aria-hidden="true">
        ♪
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading={loading}
      onError={() => setFailed(true)}
    />
  );
}
