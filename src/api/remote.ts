import { apiFetch } from '../lib/http/client';

// Phone-as-remote client. Every call goes through `apiFetch('bff', '/remote/...')`,
// which carries the same `connect.sid` session as the rest of the BFF-fronted
// backends. The BFF then relays to a small listener running INSIDE the
// PoisonFlix app on the projector.
//
// Deliberately not adb, even though the projector's 5555 is open: adb would
// mean a shell on the whole device behind this page. The app listener can only
// press buttons in that one app.
//
// Deliberately not a direct browser -> projector call either: this page is also
// served over HTTPS through the Tailscale funnel, and an HTTPS page cannot
// reach a plain-HTTP LAN address (mixed content), so the relay keeps one origin
// for both access paths.

/** The keys the D-pad exposes, in Android's `KEYCODE_*` naming minus the prefix. */
export type RemoteKey =
  | 'DPAD_UP'
  | 'DPAD_DOWN'
  | 'DPAD_LEFT'
  | 'DPAD_RIGHT'
  | 'DPAD_CENTER'
  | 'BACK'
  | 'HOME'
  | 'MEDIA_PLAY_PAUSE'
  | 'MEDIA_NEXT'
  | 'MEDIA_PREVIOUS'
  | 'VOLUME_UP'
  | 'VOLUME_DOWN'
  | 'DEL';

/** True when the projector answered — used to show whether the remote is live. */
export async function pingProjector(): Promise<boolean> {
  try {
    await apiFetch('bff', '/remote/ping');
    return true;
  } catch {
    return false;
  }
}

export async function sendKey(key: RemoteKey): Promise<void> {
  await apiFetch('bff', `/remote/key?code=${encodeURIComponent(key)}`);
}

/**
 * Types [text] on the projector.
 *
 * Sent as text rather than as one key per character from here: the app turns it
 * into real key events on its side, so anywhere in the app that already accepts
 * a physical keyboard accepts this too, with no screen needing to know the
 * remote exists.
 */
export async function sendText(text: string): Promise<void> {
  if (!text) return;
  await apiFetch('bff', `/remote/text?q=${encodeURIComponent(text)}`);
}
