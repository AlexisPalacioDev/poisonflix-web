// The PoisonFlix brand mark: a clapperboard with a mouth for the video side,
// a cassette with a mouth for the music side.
//
// Source of truth for the artwork is `public/brand-video.png` and
// `public/brand-music.png` - the two icons the owner supplied. The clapper one
// is also what `public/icon-32|180|192|512.png` (the PNG favicon and PWA
// launcher icons wired up in index.html) was rendered from, so do NOT delete
// either PNG. They are ~1 MB each and the clapper one is a 3D render, so
// neither is usable as an inline mark; what lives here is a flat, contoured
// re-draw of both.
//
// The variants are SIBLINGS, not the same drawing recoloured: they share the
// flat contour, the accent rim, the fang rows and the tongue, but each keeps
// its own object. The clapper is a triangular slate under a striped stick; the
// cassette is a wide rounded rectangle with two reels under a lid that lifts;
// the gamepad is a notched body with two grips, a d-pad and four buttons. An
// earlier pass reused one silhouette for two of them and the cassette just read
// as a green clapper - the silhouette IS the recognition, it cannot be shared.
//
// `public/favicon.svg` is a copy of the `default` variant's output (rendered
// with renderToStaticMarkup, plus width/height and minus `focusable`). If you
// change the clapper here, re-export it or the browser tab drifts.
//
// Everything is inline SVG on a 0 0 64 64 grid - no network request, no CSS
// features newer than Chrome 53 (the webOS 2018 TV target). Detail that would
// turn to mush at 28px (rivet rows, screw crosses, the full brick slate, the
// cassette's spool holes) is deliberately dropped rather than shrunk.

const INK = '#0A0C10'; // contour + mouth interior
const SHELL = '#23272F'; // body plastic, a touch lighter than the app background
const DECK = '#2C313A'; // the cassette's lower deck, one step off the shell
const BONE = '#F7F4EC'; // teeth
const CREAM = '#F5F1E4'; // clapper slate face / cassette label
const RED = '#E1152B'; // video accent
const GREEN = '#57C838'; // music accent
const VIOLET = '#8A5CF6'; // games accent
const METAL = '#4A4F58'; // rivets / screws

// --- Clapperboard geometry, in viewBox units --------------------------------
const VIDEO_HINGE = 'rotate(-24 13 27)';
const VIDEO_LIP = 'rotate(29.5 10 26)';
const VIDEO_BODY = 'M10 26 L56 52 L17 60 Z';
const VIDEO_MOUTH = 'M18.26 30.67 L55.44 14.12 L56 52 Z';

// --- Cassette geometry ------------------------------------------------------
// Drawn in its own frame - origin at the cassette's centre, +x along its long
// edge - so the shell stays an honest 44x27 rectangle and only the frame knows
// about the tilt. MUSIC_LID swings the top strip open around its left end.
const MUSIC_FRAME = 'translate(33.33 38.83) scale(1.12) rotate(-10)';
const MUSIC_LID = 'rotate(-18 -22 -5.5)';
const MUSIC_BODY = 'M-22 -5.5 L22 -5.5 L22 9.5 Q22 13.5 18 13.5 L-18 13.5 Q-22 13.5 -22 9.5 Z';
const MUSIC_TOP = 'M-18.5 -13.5 L18.5 -13.5 Q22 -13.5 22 -10 L22 -5.5 L-22 -5.5 L-22 -10 Q-22 -13.5 -18.5 -13.5 Z';
const MUSIC_MOUTH = 'M-22 -5.5 L19.85 -19.1 L22 -5.5 Z';

// --- Gamepad geometry -------------------------------------------------------
// Third sibling, built the same way as the cassette: its own frame, its own
// silhouette. A pad is recognised by the two grips hanging off a wide body -
// that notched underside is the whole read, so the body is a single path rather
// than the rounded rectangle the cassette gets. GAME_LID swings the top edge
// open around its left end, exactly like the cassette's.
const GAME_FRAME = 'translate(32 38.5) scale(1.02) rotate(-8)';
const GAME_LID = 'rotate(-19 -25 -6)';
const GAME_BODY =
  'M-25 -6 L25 -6 L25 2 Q25 12 18 14 Q12 15.5 9.5 10 L6.5 3.5 L-6.5 3.5 L-9.5 10 Q-12 15.5 -18 14 Q-25 12 -25 2 Z';
const GAME_TOP = 'M-19 -16 L19 -16 Q25 -16 25 -10 L25 -6 L-25 -6 L-25 -10 Q-25 -16 -19 -16 Z';
const GAME_MOUTH = 'M-25 -6 L22.27 -22.28 L25 -6 Z';
// D-pad cross and the four face buttons, in the same frame.
const GAME_DPAD =
  'M-14.5 -5 L-11.5 -5 L-11.5 -2 L-8.5 -2 L-8.5 1 L-11.5 1 L-11.5 4 L-14.5 4 L-14.5 1 L-17.5 1 L-17.5 -2 L-14.5 -2 Z';
const GAME_BUTTONS: readonly (readonly [number, number])[] = [
  [13, -4],
  [16.5, -0.5],
  [13, 3],
  [9.5, -0.5],
];

/** A row of fangs standing on `y`, pointing towards `tipY`. */
function Fangs({
  y,
  tipY,
  at,
  w,
}: {
  y: number;
  tipY: number;
  at: readonly number[];
  w: number;
}) {
  return (
    <g fill={BONE} stroke={INK} strokeWidth="1.3" strokeLinejoin="round">
      {at.map((x) => (
        <path key={x} d={`M${x} ${y} L${x + w} ${y} L${x + w / 2} ${tipY} Z`} />
      ))}
    </g>
  );
}

/** One tape reel: rim, toothed hub, spindle. Drawn in the cassette frame. */
function Reel({ cx }: { cx: number }) {
  return (
    <g data-part="reel">
      <circle cx={cx} cy={3.5} r={4.4} fill={BONE} stroke={INK} strokeWidth="1.3" />
      {/* The hub's teeth as a dashed ring - a real gear outline is invisible at
          28px, and this degrades to a plain thick ring instead of to noise. */}
      <circle
        cx={cx}
        cy={3.5}
        r={2.7}
        fill="none"
        stroke={INK}
        strokeWidth="1.6"
        strokeDasharray="1.15 1.15"
      />
      <circle cx={cx} cy={3.5} r={1.25} fill={INK} />
    </g>
  );
}

function Clapper() {
  return (
    <g>
      <g fill={RED} stroke={RED} strokeWidth="4.4" strokeLinejoin="round">
        <path d={VIDEO_BODY} />
        <g transform={VIDEO_HINGE}>
          <rect x="13" y="21.5" width="44" height="11" rx="3" />
        </g>
      </g>

      <path d={VIDEO_MOUTH} fill={INK} />
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

      <path d={VIDEO_BODY} fill={SHELL} stroke={INK} strokeWidth="1.8" strokeLinejoin="round" />
      <circle cx="22" cy="42" r="6.2" fill={CREAM} stroke={INK} strokeWidth="1.4" />
      <circle cx="23.6" cy="42" r="3.4" fill={INK} />
      {/* Slate lines. The full brick pattern turns into a white smear at 28px,
          so only the two long rules survive - the ties are dropped. */}
      <g stroke={CREAM} strokeWidth="1.7" strokeLinecap="round">
        <line x1="21" y1="52" x2="43" y2="47.5" />
        <line x1="22" y1="57.6" x2="46" y2="52.7" />
      </g>

      <g transform={VIDEO_HINGE}>
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
          <path data-part="stripe" d="M25 21.5 L32 21.5 L28 32.5 L21 32.5 Z" />
          <path data-part="stripe" d="M36 21.5 L43 21.5 L39 32.5 L32 32.5 Z" />
          <path data-part="stripe" d="M47 21.5 L54 21.5 L50 32.5 L43 32.5 Z" />
          <rect x="13" y="21.5" width="8" height="11" rx="3" />
        </g>
        <circle cx="15.6" cy="24.6" r="1.1" fill={METAL} />
        <circle cx="17.2" cy="30" r="1.1" fill={METAL} />
        <Fangs y={32.5} tipY={39.5} at={[30, 39, 48]} w={8} />
      </g>

      <g transform={VIDEO_LIP}>
        <Fangs y={26} tipY={19} at={[32, 41, 50]} w={8} />
      </g>
    </g>
  );
}

function Cassette() {
  return (
    <g transform={MUSIC_FRAME}>
      <g fill={GREEN} stroke={GREEN} strokeWidth="4.1" strokeLinejoin="round">
        <path d={MUSIC_BODY} />
        <g transform={MUSIC_LID}>
          <path d={MUSIC_TOP} />
        </g>
      </g>

      <path d={MUSIC_MOUTH} fill={INK} />
      <ellipse
        cx="10"
        cy="-10"
        rx="10"
        ry="4.4"
        fill={GREEN}
        stroke={INK}
        strokeWidth="1.4"
        transform="rotate(-18 10 -10)"
      />

      {/* Shell: a wide rounded rectangle, which is most of what makes it read
          as a cassette rather than as a green clapperboard. */}
      <path d={MUSIC_BODY} fill={SHELL} stroke={INK} strokeWidth="1.7" strokeLinejoin="round" />
      <rect
        x="-15.5"
        y="-1"
        width="31"
        height="10"
        rx="2"
        fill={GREEN}
        stroke={INK}
        strokeWidth="1.2"
      />
      <Reel cx={-7.5} />
      <Reel cx={7.5} />
      <rect x="-13" y="10" width="26" height="3" rx="1.4" fill={DECK} />
      <circle cx="-19.5" cy="11" r="1.3" fill={METAL} />
      <circle cx="19.5" cy="11" r="1.3" fill={METAL} />

      <g transform={MUSIC_LID}>
        <path d={MUSIC_TOP} fill={SHELL} stroke={INK} strokeWidth="1.7" strokeLinejoin="round" />
        <rect x="-18" y="-12" width="36" height="5.2" rx="1.8" fill={CREAM} />
        <g stroke={INK} strokeWidth="0.7" strokeLinecap="round">
          <line x1="-15" y1="-10.6" x2="15" y2="-10.6" />
          <line x1="-15" y1="-8.9" x2="15" y2="-8.9" />
        </g>
        <circle cx="-20" cy="-9.5" r="1.3" fill={METAL} />
        <circle cx="20" cy="-9.5" r="1.3" fill={METAL} />
        <Fangs y={-5.5} tipY={0.5} at={[0, 7.5, 15]} w={7} />
      </g>

      <Fangs y={-5.5} tipY={-10.5} at={[3, 10, 16]} w={6} />
    </g>
  );
}

function Gamepad() {
  return (
    <g transform={GAME_FRAME}>
      <g fill={VIOLET} stroke={VIOLET} strokeWidth="4.1" strokeLinejoin="round">
        <path d={GAME_BODY} />
        <g transform={GAME_LID}>
          <path d={GAME_TOP} />
        </g>
      </g>

      <path d={GAME_MOUTH} fill={INK} />
      <ellipse
        cx="11"
        cy="-12"
        rx="10.5"
        ry="4.4"
        fill={VIOLET}
        stroke={INK}
        strokeWidth="1.4"
        transform="rotate(-19 11 -12)"
      />

      {/* Shell: the notched underside with the two grips, which is what makes
          it read as a pad rather than as a violet cassette. */}
      <path d={GAME_BODY} fill={SHELL} stroke={INK} strokeWidth="1.7" strokeLinejoin="round" />
      <path d={GAME_DPAD} fill={CREAM} stroke={INK} strokeWidth="1.2" strokeLinejoin="round" />
      <g fill={VIOLET} stroke={INK} strokeWidth="1.1">
        {GAME_BUTTONS.map(([cx, cy]) => (
          <circle key={`${cx},${cy}`} cx={cx} cy={cy} r="1.9" />
        ))}
      </g>
      <rect x="-3.5" y="-2" width="7" height="3" rx="1.4" fill={DECK} />
      <circle cx="-20.5" cy="9.5" r="1.3" fill={METAL} />
      <circle cx="20.5" cy="9.5" r="1.3" fill={METAL} />

      <g transform={GAME_LID}>
        <path d={GAME_TOP} fill={SHELL} stroke={INK} strokeWidth="1.7" strokeLinejoin="round" />
        {/* The shoulder buttons, flattened into two bars - at 28px anything
            more turns into a smear, same call as the clapper's slate lines. */}
        <rect x="-19" y="-14.5" width="12" height="4.4" rx="2" fill={CREAM} />
        <rect x="7" y="-14.5" width="12" height="4.4" rx="2" fill={CREAM} />
        <circle cx="-21.5" cy="-9" r="1.3" fill={METAL} />
        <circle cx="21.5" cy="-9" r="1.3" fill={METAL} />
        <Fangs y={-6} tipY={0.5} at={[0, 8, 16]} w={7} />
      </g>

      <Fangs y={-6} tipY={-11} at={[3, 11, 18]} w={6} />
    </g>
  );
}

/** Which object the mark draws. Siblings, not one silhouette recoloured. */
export type PoisonMarkVariant = 'default' | 'music' | 'games';

const MARK_LABEL: Record<PoisonMarkVariant, string> = {
  default: 'PoisonFlix',
  music: 'PoisonFlix Música',
  games: 'PoisonFlix Juegos',
};

/**
 * The PoisonFlix mark. The variant swaps the clapperboard for the cassette or
 * the gamepad, so the brand visibly signals which section of the app you are in
 * (the Header swaps it on the /musica and /juegos routes).
 */
export function PoisonMark({
  className,
  variant = 'default',
}: {
  className?: string;
  variant?: PoisonMarkVariant;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      role="img"
      aria-label={MARK_LABEL[variant]}
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      {variant === 'music' ? <Cassette /> : variant === 'games' ? <Gamepad /> : <Clapper />}
    </svg>
  );
}
