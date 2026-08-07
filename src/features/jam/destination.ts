import { useSyncExternalStore } from 'react';

// Where playback goes.
//
// This is the model the owner asked for, and it is the one that makes Jam make
// sense: a Jam is not a room you carry songs into one at a time, it is an
// OUTPUT — the same idea as picking a speaker in Spotify Connect or AirPlay.
// Choose a Jam and everything you press play on lands there, from anywhere in
// the app. The room's queue fills itself with what you are listening to.
//
// Everything the previous model needed — a menu item on every song, a button
// inside the room, an explanation of where to find either — disappears.
//
// Persisted in localStorage, like `musicPrefs`: an output you chose is a
// setting, not a thing you should have to re-pick after every reload.

const STORAGE_KEY = 'poisonflix:jamDestination';

let current: string | null = read();
const listeners = new Set<() => void>();

function read(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private mode and disabled storage both throw here. Playing locally is
    // the right fallback: silently routing someone's music into a shared room
    // they cannot see they selected would be worse than forgetting.
    return null;
  }
}

/** The Jam id playback is being sent to, or null for this device. */
export function jamDestination(): string | null {
  return current;
}

export function setJamDestination(jamId: string | null): void {
  if (current === jamId) return;
  current = jamId;
  try {
    if (jamId) window.localStorage.setItem(STORAGE_KEY, jamId);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* not persisting is survivable; not updating the app is not */
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders on change, including from another component. */
export function useJamDestination(): string | null {
  return useSyncExternalStore(subscribe, jamDestination, () => null);
}
