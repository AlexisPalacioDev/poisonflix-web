import { useEffect } from 'react';
import { reportFailure } from '../../lib/obs/report';

// Why this exists: the defect only happens on the owner's iPhone, when he
// locks it. There is no iOS simulator on Linux, driving a real iPhone needs a
// Mac to sign the automation, and — the part that settles it — locking the
// screen is a physical act no debugger can trigger. The failure cannot be
// reproduced from here at all.
//
// So the phone reports instead. While something is playing, the interesting
// media events go into a small ring buffer; if the audio stops while the page
// is hidden — which is exactly "the music died when I locked it" — the buffer
// is shipped to /bff/client-log. One lock produces one trace, and the trace
// names the event that actually killed it rather than the one I guessed.
//
// Deliberately narrow: it records nothing while paused, ships nothing on a
// normal foreground pause, and holds at most a handful of entries.

const TRACE_MAX = 24;

/** Events worth knowing about. `suspend` and `emptied` are in the list because
 *  they are what a browser fires when it decides on its own to let go of the
 *  resource — the shape of failure a lock would produce. */
const MEDIA_EVENTS = [
  'play',
  'playing',
  'pause',
  'waiting',
  'stalled',
  'suspend',
  'emptied',
  'ended',
  'error',
  'ratechange',
] as const;

export function useLockDiagnostics(audioRef: { current: HTMLAudioElement | null }): void {
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || typeof document === 'undefined') return;

    const trace: Array<Record<string, unknown>> = [];
    const push = (what: string) => {
      trace.push({
        at: Date.now(),
        what,
        t: Number(audio.currentTime.toFixed(2)),
        paused: audio.paused,
        hidden: document.visibilityState === 'hidden',
        ready: audio.readyState,
        rate: audio.playbackRate,
      });
      if (trace.length > TRACE_MAX) trace.splice(0, trace.length - TRACE_MAX);
    };

    const ship = (reason: string) => {
      if (trace.length === 0) return;
      const snapshot = trace.slice();
      trace.length = 0;
      reportFailure('music.lock.trace', reason, snapshot);
    };

    const onMedia = (event: Event) => {
      push(event.type);
      // The moment that matters: playback stopped while the screen was off.
      // A pause the user made in the foreground is not interesting and is not
      // reported, so this stays quiet during normal use.
      if ((event.type === 'pause' || event.type === 'suspend' || event.type === 'emptied') &&
        document.visibilityState === 'hidden') {
        ship(`${event.type}-while-hidden`);
      }
    };

    const onVisibility = () => {
      push(`visibility:${document.visibilityState}`);
      // Coming back to a page whose audio died while away: ship what happened
      // in between, since the user is about to notice it anyway.
      if (document.visibilityState === 'visible' && audio.paused) ship('returned-to-silence');
    };

    for (const type of MEDIA_EVENTS) audio.addEventListener(type, onMedia);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      for (const type of MEDIA_EVENTS) audio.removeEventListener(type, onMedia);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [audioRef]);
}
