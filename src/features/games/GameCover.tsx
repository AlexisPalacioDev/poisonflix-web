import { useEffect, useState } from 'react';
import { gameCoverUrl } from '../../api/games';

// The box art on a game card, and what stands in when there is none.
//
// A 404 from `/bff/games/cover` is the ordinary answer, not a failure: covers
// are whatever happens to be sitting next to the ROM, and most folders have
// nothing. So "no cover" has to land somewhere that still reads as a shelf —
// otherwise the catalogue is mostly broken-image glyphs, and the one screen
// meant to look like the film library instead looks like a failed page load.
//
// Same swap-on-error shape as Música's `CoverImage`, kept as its own component
// rather than reused because the fallback is different in kind: a song falls
// back to a ♪ glyph, a game falls back to its own name on a coloured box, so
// two adjacent placeholders are still told apart at a glance.

/**
 * A hue in [0, 360) derived from the title.
 *
 * Derived rather than random so a game keeps the same colour across reloads and
 * across the search box opening and closing — a placeholder that reshuffles its
 * colour on every render is a shelf that never looks like the same shelf twice.
 */
function titleHue(title: string): number {
  let hash = 0;
  for (let index = 0; index < title.length; index += 1) {
    // Reduced every step, so a long title cannot push the accumulator past the
    // safe-integer range and start losing precision.
    hash = (hash * 31 + title.charCodeAt(index)) % 360;
  }
  return hash;
}

export interface GameCoverProps {
  /** The opaque game id the cover endpoint takes. */
  id: string;
  /** Shown on the placeholder, and what its colour is derived from. */
  title: string;
}

export function GameCover({ id, title }: GameCoverProps) {
  const [failed, setFailed] = useState(false);

  // A different game in the same slot is a fresh attempt. The shelf keys its
  // cards by id today, so React unmounts rather than reuses and this never
  // fires — it is here so that stops being load-bearing: a caller that keys by
  // index (a virtualised rail, say) would otherwise leave one game's 404 stuck
  // over the next game's cover.
  useEffect(() => {
    setFailed(false);
  }, [id]);

  if (failed) {
    const hue = titleHue(title);
    return (
      // `aria-hidden`: the card already renders this exact title as text below
      // the art, and announcing it twice makes every link in the grid stutter.
      <span
        className="pf-games__cover-fallback"
        aria-hidden="true"
        style={{
          // Comma syntax on purpose — the space-separated hsl() form is CSS
          // Color 4 and the webOS 2018 browser drops the whole declaration.
          backgroundImage: `linear-gradient(155deg, hsl(${hue}, 52%, 34%) 0%, hsl(${hue}, 46%, 16%) 100%)`,
        }}
      >
        <span className="pf-games__cover-name">{title}</span>
      </span>
    );
  }

  return (
    // `alt=""` deliberately: the title sits right under the art inside the same
    // link, so a "Carátula de X" alt would make the link announce the game's
    // name twice. The art is decoration on top of a label that is already there.
    //
    // `loading="lazy"` is a hint, and only a modern browser takes it (Chrome
    // 76+): on the webOS 2018 television every cover on the shelf is still
    // requested at once. It is kept because it costs nothing and helps the
    // phones and laptops that are the common case — but the BFF must not
    // assume it, which is why `infra/bff/covers.mjs` owns its own rate limit
    // rather than trusting the client to arrive slowly.
    <img
      className="pf-games__cover-img"
      src={gameCoverUrl(id)}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
