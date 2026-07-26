// Autoplay preference persistence. Mirrors `lib/session/store.ts`'s plain
// localStorage pattern (same `typeof localStorage === 'undefined'` guard for
// non-browser test environments) rather than adding a persistence mechanism.
//
// Autoplay is what keeps the music going once a queue runs out — the player
// pulls a radio of related tracks instead of falling silent. YouTube Music (and
// Spotify) ship this ON with a switch to turn it off, so that's the default.

const STORAGE_KEY = 'poisonflix:musicAutoplay';

export function getAutoplayPreference(): boolean {
  if (typeof localStorage === 'undefined') return true;
  // Only an explicit "0" disables it: an unset key means "never chosen" -> on.
  return localStorage.getItem(STORAGE_KEY) !== '0';
}

export function setAutoplayPreference(value: boolean): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
}
