import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getItem, getPlaybackInfo } from '../api/jellyfin';
import { AuthProvider } from '../auth/AuthContext';
import { clearSession, setSession } from '../lib/session/store';
import { usePlaybackInfo } from './usePlaybackInfo';

vi.mock('../api/jellyfin', () => ({ getPlaybackInfo: vi.fn(), getItem: vi.fn() }));

const mockedGetPlaybackInfo = vi.mocked(getPlaybackInfo);
const mockedGetItem = vi.mocked(getItem);

// Jellyfin mints a fresh PlaySessionId on every PlaybackInfo call, and bakes
// it into TranscodingUrl - so a second response is never byte-identical to
// the first. That is precisely what made the refetch destructive.
function playbackInfoResponse(session: string) {
  return {
    MediaSources: [
      {
        Id: 'media-source-1',
        TranscodingUrl: `/videos/item-1/master.m3u8?PlaySessionId=${session}`,
        MediaStreams: [],
      },
    ],
    PlaySessionId: session,
  } as never;
}

function wrapper({ children }: { children: ReactNode }) {
  // No `refetchOnWindowFocus` override here on purpose: this mirrors
  // `src/App.tsx`'s bare `new QueryClient()`, so the hook's own opt-out is
  // what the assertions below are actually exercising.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

// The cast route (`/cast/:id`) resolves the SAME item under a DIFFERENT
// identity than the session one. Keyed by item alone, react-query would hand
// each route the other's resolved stream - a disabled query still serves
// cached data - and the page would render a source authenticated by a
// credential it never chose.
describe('usePlaybackInfo — a credential override must not share a cache with the session', () => {
  afterEach(() => {
    clearSession();
    mockedGetPlaybackInfo.mockReset();
    mockedGetItem.mockReset();
  });

  it('resolves the same item twice when the identity differs, instead of replaying the cache', async () => {
    setSession({ jellyfinToken: 'phone-tok', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    // DirectPlay (no TranscodingUrl) on purpose: that is the branch where the
    // token is baked into the URL as `api_key`, which is how the assertions
    // below can tell the two identities' streams apart at all.
    mockedGetPlaybackInfo.mockResolvedValue({
      MediaSources: [{ Id: 'media-source-1', Container: 'mp4', TranscodingUrl: null, MediaStreams: [] }],
      PlaySessionId: 'sess-1',
    } as never);
    mockedGetItem.mockResolvedValue({ Name: 'A Movie', Type: 'Movie', UserData: {} } as never);

    // ONE client for both hooks - the whole point is that a shared cache does
    // not let one identity's result stand in for the other's.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function sharedWrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <AuthProvider>{children}</AuthProvider>
        </QueryClientProvider>
      );
    }

    const session = renderHook(() => usePlaybackInfo('item-1'), { wrapper: sharedWrapper });
    await waitFor(() => expect(session.result.current.isSuccess).toBe(true));

    const cast = renderHook(() => usePlaybackInfo('item-1', { userId: 'user-2', token: 'tv-tok' }), {
      wrapper: sharedWrapper,
    });
    await waitFor(() => expect(cast.result.current.isSuccess).toBe(true));

    expect(mockedGetPlaybackInfo).toHaveBeenCalledTimes(2);
    expect(mockedGetPlaybackInfo).toHaveBeenNthCalledWith(
      1,
      'item-1',
      expect.objectContaining({ userId: 'user-1' }),
      { authToken: undefined },
    );
    expect(mockedGetPlaybackInfo).toHaveBeenNthCalledWith(
      2,
      'item-1',
      expect.objectContaining({ userId: 'user-2' }),
      { authToken: 'tv-tok' },
    );
    // And the stream each one carries is signed with its OWN token.
    expect(JSON.stringify(session.result.current.data?.resolved.source)).toContain('phone-tok');
    expect(JSON.stringify(cast.result.current.data?.resolved.source)).toContain('tv-tok');
  });
});

describe('usePlaybackInfo — regaining window focus must not re-resolve the stream', () => {
  afterEach(() => {
    clearSession();
    focusManager.setFocused(undefined);
    onlineManager.setOnline(true);
    mockedGetPlaybackInfo.mockReset();
    mockedGetItem.mockReset();
  });

  async function playing() {
    setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    mockedGetPlaybackInfo
      .mockResolvedValueOnce(playbackInfoResponse('session-first'))
      .mockResolvedValueOnce(playbackInfoResponse('session-second'));
    mockedGetItem.mockResolvedValue({ Name: 'A Movie', Type: 'Movie', UserData: {} } as never);

    const rendered = renderHook(() => usePlaybackInfo('item-1'), { wrapper });
    await waitFor(() => expect(rendered.result.current.isSuccess).toBe(true));
    expect(mockedGetPlaybackInfo).toHaveBeenCalledTimes(1);
    return rendered;
  }

  // Owner report, measured live against 192.168.1.50:8600: alt-tab away from
  // a movie at 43s and back, and the <video> emitted emptied -> loadstart ->
  // play -> waiting with currentTime back at 0. Root cause: this query is
  // `staleTime: 0`, so React Query's default focus refetch always fired; the
  // new PlaySessionId changed the stream URL, which changed VideoSurface's
  // `sourceKey`, which tore down hls.js and reloaded from scratch.
  it('does not refetch when the tab regains focus, so the resolved source stays identical', async () => {
    const { result } = await playing();
    const firstSource = result.current.data?.resolved.source;

    // Leave the tab and come back.
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await Promise.resolve();

    expect(mockedGetPlaybackInfo).toHaveBeenCalledTimes(1);
    expect(result.current.data?.resolved.source).toEqual(firstSource);
    expect(result.current.data?.resolved.playSessionId).toBe('session-first');
  });

  // Same teardown, different trigger: a wifi blip must not restart the movie
  // either. `VideoSurface` has no hls.js recovery path (a fatal error unmounts
  // it into the error screen), so nothing here was relying on the reconnect
  // refetch to revive a dead stream.
  it('does not refetch when the connection comes back', async () => {
    const { result } = await playing();
    const firstSource = result.current.data?.resolved.source;

    act(() => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    await Promise.resolve();

    expect(mockedGetPlaybackInfo).toHaveBeenCalledTimes(1);
    expect(result.current.data?.resolved.source).toEqual(firstSource);
  });
});
