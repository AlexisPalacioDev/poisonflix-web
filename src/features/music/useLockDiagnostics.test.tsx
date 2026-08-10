import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MusicPlayerProvider } from './MusicPlayerProvider';
import { useMusicPlayer, type MusicPlayerContextValue, type MusicTrack } from './musicPlayerCore';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { clearRecordedFailures, recordedFailures } from '../../lib/obs/report';

// `useLockDiagnostics` ships a trace when playback dies while the page is
// hidden — the only way to see what a real locked-phone hang looked like,
// since it can't be reproduced from a dev machine (see the hook's own
// docstring). This suite closes the two gaps described in the diagnosis:
// 31 real traces had to be cross-referenced against server logs by clock
// proximity alone because no sample said which track it was about, and
// `paused`/`mediaSessionState` were both blind to a silent stall that never
// stopped `paused` from being false.

const track: MusicTrack = {
  itemId: 'item-1',
  title: 'Song',
  artist: 'Artist',
  coverUrl: null,
  videoId: 'video-1',
};

let api: MusicPlayerContextValue;
function Capture() {
  api = useMusicPlayer();
  return null;
}

function renderProvider() {
  setSession({ jellyfinToken: 'tok', jellyfinUserId: 'user', jellyseerrCookiePresent: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AuthProvider>
          <MusicPlayerProvider>
            <Capture />
          </MusicPlayerProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function audioEl(): HTMLAudioElement {
  return document.querySelector('audio') as HTMLAudioElement;
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: hidden ? 'hidden' : 'visible',
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  clearRecordedFailures();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearSession();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

describe('useLockDiagnostics — trace content', () => {
  it('stamps every sample with the track it is about (itemId/videoId), not just proximity in time', async () => {
    renderProvider();
    await act(async () => {
      api.playNow([track], 0);
    });

    setHidden(true);
    // A pause while hidden is the shipping trigger — see the hook's own
    // "the moment that matters" comment.
    act(() => fireEvent.pause(audioEl()));

    const shipped = recordedFailures().find((f) => f.scope === 'music.lock.trace');
    expect(shipped).toBeDefined();
    const trace = shipped?.detail as Array<Record<string, unknown>>;
    expect(trace.length).toBeGreaterThan(0);
    for (const sample of trace) {
      expect(sample.itemId).toBe('item-1');
      expect(sample.videoId).toBe('video-1');
    }
  });

  it('samples `buffered`s end through the shared null-safe guard — the signal `paused` cannot give', async () => {
    renderProvider();
    await act(async () => {
      api.playNow([track], 0);
    });
    const audio = audioEl();
    // jsdom's default TimeRanges are empty — exercises the exact case
    // `timeRangeEnd` guards against (`.end(0)` throws IndexSizeError on an
    // empty range).
    setHidden(true);
    act(() => fireEvent.pause(audio));

    const shipped = recordedFailures().find((f) => f.scope === 'music.lock.trace');
    const trace = shipped?.detail as Array<Record<string, unknown>>;
    expect(trace.some((s) => 'bufferedEnd' in s)).toBe(true);
    // Empty buffered range -> null, never a thrown error reaching this point.
    expect(trace.every((s) => s.bufferedEnd === null || typeof s.bufferedEnd === 'number')).toBe(
      true,
    );
  });

  it('re-subscribes to the newly-active element after a double-buffering promotion, without losing itemId tracking', async () => {
    // A preview track (has `streamUrl`) is required for the preload path to
    // engage at all — see MusicPlayerProvider's preload effect.
    const previewA: MusicTrack = {
      itemId: 'vid-a',
      title: 'A',
      artist: null,
      coverUrl: null,
      videoId: 'vid-a',
      streamUrl: '/bff/music/stream?videoId=vid-a',
    };
    const previewB: MusicTrack = {
      itemId: 'vid-b',
      title: 'B',
      artist: null,
      coverUrl: null,
      videoId: 'vid-b',
      streamUrl: '/bff/music/stream?videoId=vid-b',
    };
    renderProvider();
    await act(async () => {
      api.playNow([previewA, previewB], 0);
    });

    // A sample recorded on track A, BEFORE the promotion — this is the
    // lead-up context a hang starting right at a track boundary would need.
    act(() => fireEvent.play(document.querySelectorAll('audio')[0]));

    // Advance via the raw `ended` dispatch, the same way the auto-advance
    // regression suite does, so this promotes the preloaded second element.
    const first = document.querySelectorAll('audio')[0];
    first.dispatchEvent(new Event('ended'));
    await act(async () => {});
    expect(api.currentIndex).toBe(1);

    setHidden(true);
    // A pause on whichever element is NOW active must still ship a trace
    // stamped with track B — proving the listeners followed the promotion.
    const active = document.querySelectorAll('audio')[1];
    act(() => fireEvent.pause(active));

    const shipped = recordedFailures()
      .filter((f) => f.scope === 'music.lock.trace')
      .at(-1);
    expect(shipped).toBeDefined();
    const trace = shipped?.detail as Array<Record<string, unknown>>;
    expect(trace.some((s) => s.itemId === 'vid-b')).toBe(true);

    // Regression test for a bug adversarial review caught: an earlier version
    // declared the trace buffer INSIDE the effect body, so resubscribing on
    // promotion silently emptied it — losing the lead-up context at exactly
    // the track boundary this hook exists to explain. The pre-promotion
    // sample recorded on track A above must still be present here.
    expect(trace.some((s) => s.itemId === 'vid-a')).toBe(true);
  });
});
