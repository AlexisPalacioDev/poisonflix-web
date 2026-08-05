// The PoisonFlix brand mark: a clapperboard with a mouth for the video side,
// a cassette with a mouth for the music side.
//
// Source of truth for the artwork is `public/brand-video.png` and
// `public/brand-music.png` - the two icons the owner supplied. The clapper one
// is also what `public/icon-32|180|192|512.png` (the favicon and PWA launcher
// icons wired up in index.html) was rendered from, so do NOT delete either PNG
// even though no module imports them any more. Those PNGs are
// ~1 MB each and the clapper one is a 3D render, so neither is usable as an
// inline mark. What lives here instead is a flat, contoured re-draw of both:
// same silhouette, same teeth/tongue/eye read, no gradients or shadows, so the
// two variants look like siblings and stay sharp from 28px (header) to 160px.
//
// Everything is inline SVG on a 0 0 64 64 grid - no network request, no CSS
// features newer than Chrome 53 (the webOS 2018 TV target). Detail that would
// turn to mush at 28px (rivet rows, screw crosses, the full brick slate,
// the reel gear teeth) is deliberately dropped rather than shrunk.

const INK = '#0A0C10'; // contour + mouth interior
const SHELL = '#23272F'; // body plastic, a touch lighter than the app background
const BONE = '#F7F4EC'; // teeth
const CREAM = '#F5F1E4'; // clapper slate face / cassette label
const RED = '#E1152B'; // video accent
const GREEN = '#57C838'; // music accent
// The tongue is a shade down from the tape window: at 28px two identical
// greens a hair apart fuse into one blob and the mouth stops reading.
const GREEN_DEEP = '#33A521';
const METAL = '#4A4F58'; // rivets / screws

/** Where the upper jaw pivots, and how wide the mouth gapes, per variant. */
const VIDEO_HINGE = 'rotate(-24 13 27)';
const VIDEO_LIP = 'rotate(29.5 10 26)';
const VIDEO_BODY = 'M10 26 L56 52 L17 60 Z';
const VIDEO_MOUTH = 'M18.26 30.67 L55.44 14.12 L56 52 Z';

const MUSIC_HINGE = 'rotate(-24 13 30)';
const MUSIC_LIP = 'rotate(25 11 28)';
const MUSIC_BODY = 'M11 28 L56 49 L53 56 L17 60 Z';
const MUSIC_MOUTH = 'M20.77 32.56 L55.4 17.1 L56 49 Z';

/** A row of fangs hanging off `y`, pointing towards `tipY`. */
function Fangs({ y, tipY, at }: { y: number; tipY: number; at: readonly number[] }) {
  return (
    <g fill={BONE} stroke={INK} strokeWidth="1.3" strokeLinejoin="round">
      {at.map((x) => (
        <path key={x} d={`M${x} ${y} L${x + 8} ${y} L${x + 4} ${tipY} Z`} />
      ))}
    </g>
  );
}

/**
 * The PoisonFlix mark. `variant="music"` swaps the clapperboard for the
 * cassette so the brand visibly signals which half of the app you are in (the
 * Header swaps to it while on the /musica routes).
 */
export function PoisonMark({
  className,
  variant = 'default',
}: {
  className?: string;
  variant?: 'default' | 'music';
}) {
  const music = variant === 'music';
  const rim = music ? GREEN : RED;
  const bodyPath = music ? MUSIC_BODY : VIDEO_BODY;

  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      role="img"
      aria-label={music ? 'PoisonFlix Música' : 'PoisonFlix'}
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Accent rim: the same silhouette drawn fat underneath. On a dark app
          background a black-outlined black device has no readable edge, so the
          brand colour doubles as the contour. */}
      <g fill={rim} stroke={rim} strokeWidth="4.4" strokeLinejoin="round">
        <path d={bodyPath} />
        <g transform={music ? MUSIC_HINGE : VIDEO_HINGE}>
          <rect x="13" y={music ? 24.5 : 21.5} width="44" height="11" rx="3" />
        </g>
      </g>

      {/* Mouth interior, then the tongue - both sit behind the jaws. */}
      <path d={music ? MUSIC_MOUTH : VIDEO_MOUTH} fill={INK} />
      {music ? (
        <ellipse
          cx="41"
          cy="33.5"
          rx="10.4"
          ry="7.6"
          fill={GREEN_DEEP}
          stroke={INK}
          strokeWidth="1.6"
          transform="rotate(-12 41 33.5)"
        />
      ) : (
        <ellipse
          cx="40"
          cy="33"
          rx="11.4"
          ry="8.5"
          fill={RED}
          stroke={INK}
          strokeWidth="1.4"
          transform="rotate(-12 40 33)"
        />
      )}

      {/* Lower jaw. */}
      <path d={bodyPath} fill={SHELL} stroke={INK} strokeWidth="1.8" strokeLinejoin="round" />

      {music ? (
        <g>
          {/* Tape window + reel. */}
          <path
            d="M17 33.5 L36 42.5 L34.5 48.5 L19 49.5 Z"
            fill={GREEN}
            stroke={INK}
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <circle cx="25" cy="43" r="5.2" fill={BONE} stroke={INK} strokeWidth="1.4" />
          <circle cx="25" cy="43" r="2.5" fill={INK} />
          {/* Bottom deck with its two spool holes. */}
          <path d="M22 51 L47 49 L48 55 L23 57 Z" fill="#2C313A" />
          <circle cx="30" cy="53.6" r="1.6" fill={INK} />
          <circle cx="40" cy="52" r="1.6" fill={INK} />
        </g>
      ) : (
        <g>
          {/* Eye. */}
          <circle cx="22" cy="42" r="6.2" fill={CREAM} stroke={INK} strokeWidth="1.4" />
          <circle cx="23.6" cy="42" r="3.4" fill={INK} />
          {/* Slate lines. The full brick pattern turns into a white smear at
              28px, so only the two long rules survive - the ties are dropped. */}
          <g stroke={CREAM} strokeWidth="1.7" strokeLinecap="round">
            <line x1="21" y1="52" x2="43" y2="47.5" />
            <line x1="22" y1="57.6" x2="46" y2="52.7" />
          </g>
        </g>
      )}

      {/* Upper jaw: the clapper stick, or the cassette's labelled top shell. */}
      <g transform={music ? MUSIC_HINGE : VIDEO_HINGE}>
        {music ? (
          <g>
            <rect
              x="13"
              y="24.5"
              width="44"
              height="11"
              rx="3"
              fill={SHELL}
              stroke={INK}
              strokeWidth="1.6"
            />
            <rect x="19.5" y="26.4" width="33" height="5.6" rx="2.4" fill={CREAM} />
            <rect x="19.5" y="32.8" width="33" height="2.2" fill={GREEN} />
            <circle cx="16.4" cy="30" r="1.5" fill={METAL} />
            <circle cx="54.6" cy="30" r="1.5" fill={METAL} />
          </g>
        ) : (
          <g>
            <rect
              x="13"
              y="21.5"
              width="44"
              height="11"
              rx="3"
              fill={CREAM}
              stroke={INK}
              strokeWidth="1.6"
            />
            <g fill={INK}>
              <path d="M25 21.5 L32 21.5 L28 32.5 L21 32.5 Z" />
              <path d="M36 21.5 L43 21.5 L39 32.5 L32 32.5 Z" />
              <path d="M47 21.5 L54 21.5 L50 32.5 L43 32.5 Z" />
              <rect x="13" y="21.5" width="8" height="11" rx="3" />
            </g>
            <circle cx="15.6" cy="24.6" r="1.1" fill={METAL} />
            <circle cx="17.2" cy="30" r="1.1" fill={METAL} />
          </g>
        )}
        <Fangs y={music ? 35.5 : 32.5} tipY={music ? 42.5 : 39.5} at={[30, 39, 48]} />
      </g>

      {/* Lower fangs, riding the lip line. */}
      <g transform={music ? MUSIC_LIP : VIDEO_LIP}>
        <Fangs
          y={music ? 28 : 26}
          tipY={music ? 21 : 19}
          at={music ? [33, 42, 51] : [32, 41, 50]}
        />
      </g>
    </svg>
  );
}
