// +18 gate (projector-feature-map.md §3 "+18 / adult section", ported from
// `AppSettings.kt`'s `adultUnlocked`/`adultPin` split). Two independent
// pieces of state, deliberately NOT stored together:
//
// - `adultUnlocked` is in-memory ONLY (a module-level variable, never written
//   to localStorage) so a page reload always re-locks the section - mirrors
//   `_adultUnlocked` resetting to false on every cold start (AppSettings.kt:43-44).
// - the PIN itself DOES persist across reloads (localStorage), same as
//   `AppSettings.kt`'s `KEY_ADULT_PIN` SharedPreferences entry, so a
//   user-changed PIN survives a refresh.
//
// Mirrors `lib/session/store.ts`'s subscribe/notify shape so React can
// observe the unlock flag the same way `AuthContext` observes the session.

const STORAGE_KEY = 'poisonflix:adultPin';

/** Default +18 PIN, user-changeable, never hardcoded into the unlock flow itself. */
export const DEFAULT_ADULT_PIN = '6969';

type AdultUnlockListener = (unlocked: boolean) => void;
const listeners = new Set<AdultUnlockListener>();

// In-memory only - see file header. Resets to false on every module load,
// i.e. every page reload.
let adultUnlocked = false;

function notify(): void {
  for (const listener of listeners) listener(adultUnlocked);
}

export function subscribeAdultUnlocked(listener: AdultUnlockListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether the +18 section is unlocked for this page session. */
export function isAdultUnlocked(): boolean {
  return adultUnlocked;
}

/** Current +18 PIN (persisted; falls back to {@link DEFAULT_ADULT_PIN}). */
export function getAdultPin(): string {
  if (typeof localStorage === 'undefined') return DEFAULT_ADULT_PIN;
  return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_ADULT_PIN;
}

/** Persists a new +18 PIN (does not itself unlock or lock anything). */
export function setAdultPin(pin: string): void {
  localStorage.setItem(STORAGE_KEY, pin);
}

/** Returns true and unlocks the +18 section for this session if `pin` matches; false otherwise. */
export function tryUnlock(pin: string): boolean {
  const ok = pin === getAdultPin();
  if (ok) {
    adultUnlocked = true;
    notify();
  }
  return ok;
}

/** Re-locks the +18 section without a reload (e.g. a future explicit "lock" action). */
export function lockAdult(): void {
  adultUnlocked = false;
  notify();
}
