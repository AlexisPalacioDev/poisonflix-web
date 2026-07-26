// PoisonOS's gold poison-drop mascot mark, ported 1:1 (same viewBox + paths)
// from the native app's `res/drawable/ic_poison_logo.xml` vector so the web
// onboarding reads as the same product (task: "recreate the PoisonFlix
// onboarding aesthetic"). Static mark only - the native app's time-of-day
// variants (`ic_poison_morning/afternoon/night`) are not ported; this is the
// stable brand mark used on the launcher/onboarding surfaces.
/**
 * The gold poison-drop mascot. `variant="music"` puts green headphones on it so
 * the brand visibly signals the app is in "music mode" (Header swaps to this
 * while on the /musica routes).
 */
export function PoisonMark({
  className,
  variant = 'default',
}: {
  className?: string;
  variant?: 'default' | 'music';
}) {
  const music = variant === 'music';
  return (
    <svg
      className={className}
      viewBox="0 0 108 108"
      role="img"
      aria-label={music ? 'PoisonFlix Música' : 'PoisonFlix'}
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform="translate(54 56) scale(1.55) translate(-54 -56)">
        <path
          fill={music ? '#1ED760' : '#F2C14E'}
          d="M54,26 C62,43 78,50 78,63 A24,24 0 1,1 30,63 C30,50 46,43 54,26 Z"
        />
        <circle cx="44" cy="60" r="7" fill="#0B0D12" />
        <circle cx="64" cy="60" r="7" fill="#0B0D12" />
        <path fill="#0B0D12" d="M54,66 L58,73 L50,73 Z" />
        <path
          fill="#0B0D12"
          d="M48,76 h2.4 v6 h-2.4 z M53,76 h2 v6.5 h-2 z M57.6,76 h2.4 v6 h-2.4 z"
        />
        <circle cx="44" cy="60" r="3" fill="#8CFF5A" />
        <circle cx="64" cy="60" r="3" fill="#8CFF5A" />
        {music && (
          <g>
            {/* headphones — bigger, gold to contrast the green mascot */}
            <path
              d="M27,63 A27,27 0 0 1 81,63"
              fill="none"
              stroke="#F2C14E"
              strokeWidth="7"
              strokeLinecap="round"
            />
            <rect x="21" y="53" width="12" height="20" rx="6" fill="#F2C14E" />
            <rect x="75" y="53" width="12" height="20" rx="6" fill="#F2C14E" />
          </g>
        )}
      </g>
    </svg>
  );
}
