import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AdultPinOverlay } from '../../components/AdultPinOverlay';
import { PosterCard, type PosterItem } from '../../components/PosterCard';
import { Row } from '../../components/Row';
import { useAdultRow, type AdultRowItem } from '../../hooks/useAdultRow';
import { useAdultUnlocked } from '../../hooks/useAdultUnlocked';
import './AdultSection.css';

// Home's +18 section (projector-feature-map.md §3 "+18 / adult section",
// walkthrough §8-11) - the LAST section on Home, standalone so
// `useAdultUnlocked`/`useAdultRow`'s hooks stay off `HomeScreen.tsx` itself
// (same "one component per conditionally-shaped row" rationale as
// `GenreRow.tsx`). Locked by default: only a single gated tile renders, never
// a full shelf - the unlocked state (search pill + real row) only appears
// after `AdultPinOverlay` unlocks the session (never persisted, see
// `lib/domain/adultSettings.ts`).

function toAdultPosterItem(entry: AdultRowItem): PosterItem {
  return {
    id: entry.title,
    title: entry.title,
    imageUrl: entry.posterUrl,
  };
}

export function AdultSection() {
  const unlocked = useAdultUnlocked();
  const [pinOpen, setPinOpen] = useState(false);
  // Called unconditionally (rules of hooks) - the hook itself gates its
  // query on `unlocked`, so nothing fires while locked.
  const adultRow = useAdultRow();

  if (!unlocked) {
    return (
      <div className="pf-adult-section">
        <button
          type="button"
          className="pf-adult-locked"
          onClick={() => setPinOpen(true)}
          aria-label="+18 contenido bloqueado"
        >
          <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true" focusable="false">
            <rect x="5" y="11" width="14" height="9" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
          <span className="pf-adult-locked__label">+18</span>
          <span className="pf-adult-locked__sublabel">BLOQUEADO</span>
        </button>

        <AdultPinOverlay open={pinOpen} onClose={() => setPinOpen(false)} />
      </div>
    );
  }

  const items = (adultRow.data ?? []).map(toAdultPosterItem);

  return (
    <div className="pf-adult-section">
      <Link to="/search_adult" className="pf-adult-search-pill">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
          <circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
          <line x1="15" y1="15" x2="21" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        BUSCAR EN +18
      </Link>

      <Row
        title="+18"
        items={adultRow.isSuccess ? items : undefined}
        isLoading={adultRow.isLoading}
        isError={adultRow.isError}
        onRetry={() => adultRow.refetch()}
        // No per-item adult detail route (out of scope - see AdultSearchScreen's
        // note): every +18 poster on Home opens the adult search screen instead.
        renderItem={(item) => <PosterCard key={item.id} item={item} to="/search_adult" />}
        emptyMessage="No hay títulos +18 para mostrar ahora mismo."
      />
    </div>
  );
}
