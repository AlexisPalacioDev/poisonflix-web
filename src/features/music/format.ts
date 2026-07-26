import type { MusicJobState } from '../../api/schemas/music';

// Shared formatting for the Música surfaces so search results, recommendations
// and library rows label durations and download states identically.

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function downloadLabel(state: MusicJobState | undefined): string {
  switch (state) {
    case 'queued':
      return 'En cola…';
    case 'downloading':
      return 'Descargando…';
    case 'scanning':
      return 'Procesando…';
    case 'done':
      return 'Descargado';
    case 'failed':
      return 'Reintentar';
    default:
      return 'Descargar';
  }
}

export function isBusyState(state: MusicJobState | undefined): boolean {
  return state === 'queued' || state === 'downloading' || state === 'scanning';
}

// "12 temas" — the track-count label shown on album / playlist cards. Returns
// null when the worker didn't report a usable count so the label is omitted.
export function trackCountLabel(count: number | null | undefined): string | null {
  if (count == null || !Number.isFinite(count) || count <= 0) return null;
  return `${count} ${count === 1 ? 'tema' : 'temas'}`;
}
