import './StatusBadge.css';

// Focus-friendly status primitive (design.md §2 `components/StatusBadge.tsx`,
// Decision 3 seam). Not wired into Home's MVP rows - the InLibrary/
// Requesting/Requestable join comes from `lib/domain/libraryIndex.ts`
// correlating a search result against the library + Jellyseerr request
// state, which is Search's job (design.md §4.4, tasks.md Slice 5). Built now
// as a standalone reusable component so Search can consume it directly.
export type StatusBadgeVariant = 'in-library' | 'requesting' | 'requestable';

interface StatusBadgeProps {
  variant: StatusBadgeVariant;
  label: string;
}

export function StatusBadge({ variant, label }: StatusBadgeProps) {
  return <span className={`pf-status-badge pf-status-badge--${variant}`}>{label}</span>;
}
