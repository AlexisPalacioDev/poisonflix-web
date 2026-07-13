import { useEffect, useState } from 'react';
import { isAdultUnlocked, subscribeAdultUnlocked } from '../lib/domain/adultSettings';

// Thin React wrapper over `adultSettings`'s subscribe/get pair (mirrors
// `useAuth.ts` re-exporting `AuthContext`'s session observation). Re-renders
// whenever `tryUnlock`/`lockAdult` change the flag, without any component
// needing to poll it.
export function useAdultUnlocked(): boolean {
  const [unlocked, setUnlocked] = useState(isAdultUnlocked);

  useEffect(() => subscribeAdultUnlocked(setUnlocked), []);

  return unlocked;
}
