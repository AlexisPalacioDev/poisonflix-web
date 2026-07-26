import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { reportPlaying, reportStopped } from '../../api/jellyfin';
import { MusicPlayerProvider } from './MusicPlayerProvider';
import { useMusicPlayer, type MusicTrack } from './musicPlayerCore';
import { reportPreviewPlay } from '../../api/music';
import { countsAsListen, useMusicScrobble } from './useMusicScrobble';

vi.mock('../../api/jellyfin', () => ({
  reportPlaying: vi.fn(),
  reportProgress: vi.fn(),
  reportStopped: vi.fn(),
}));
vi.mock('../../api/music', () => ({
  reportPreviewPlay: vi.fn(),
}));

const mockedReportPlaying = vi.mocked(reportPlaying);
const mockedReportStopped = vi.mocked(reportStopped);
const mockedReportPreviewPlay = vi.mocked(reportPreviewPlay);

const LIBRARY_TRACK: MusicTrack = {
  itemId: 'aud-1',
  title: 'Library Song',
  artist: 'The Band',
  coverUrl: null,
};

// A search hit streamed straight from YouTube: its "itemId" is a videoId that
// Jellyfin knows nothing about.
const PREVIEW_TRACK: MusicTrack = {
  itemId: 'vid-1',
  title: 'Preview Song',
  artist: 'The Band',
  coverUrl: null,
  videoId: 'vid-1',
  streamUrl: '/bff/music/stream?videoId=vid-1',
};

function Harness() {
  useMusicScrobble();
  const { playNow, current } = useMusicPlayer();
  return (
    <div>
      <button type="button" onClick={() => playNow([LIBRARY_TRACK])}>
        play library
      </button>
      <button type="button" onClick={() => playNow([PREVIEW_TRACK])}>
        play preview
      </button>
      <span>now: {current?.title ?? 'none'}</span>
    </div>
  );
}

function renderHarness() {
  setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MusicPlayerProvider>
          <Harness />
        </MusicPlayerProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('useMusicScrobble', () => {
  beforeEach(() => {
    mockedReportPlaying.mockResolvedValue(undefined);
    mockedReportStopped.mockResolvedValue(undefined);
  });

  afterEach(() => {
    clearSession();
    // mockClear, not mockReset: React unmounts the tree after this hook runs and
    // the cleanup still reports Stopped, which needs the resolved-promise impl.
    mockedReportPlaying.mockClear();
    mockedReportStopped.mockClear();
  });

  it('reports a library track to Jellyfin — the history the feed reads', async () => {
    renderHarness();
    fireEvent.click(screen.getByRole('button', { name: 'play library' }));

    await waitFor(() =>
      expect(mockedReportPlaying).toHaveBeenCalledWith(
        expect.objectContaining({ itemId: 'aud-1', positionTicks: 0 }),
      ),
    );
  });

  it('never reports a preview: it was not played from the library', async () => {
    renderHarness();
    fireEvent.click(screen.getByRole('button', { name: 'play preview' }));

    await screen.findByText('now: Preview Song');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mockedReportPlaying).not.toHaveBeenCalled();
  });

  it('closes the previous track before opening the next one', async () => {
    renderHarness();
    fireEvent.click(screen.getByRole('button', { name: 'play library' }));
    await waitFor(() => expect(mockedReportPlaying).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'play preview' }));
    // Stopped is what Jellyfin turns into a Played mark + PlayCount bump.
    await waitFor(() =>
      expect(mockedReportStopped).toHaveBeenCalledWith(
        expect.objectContaining({ itemId: 'aud-1' }),
      ),
    );
  });
});

describe('countsAsListen (preview tally threshold)', () => {
  it('does not count a track skipped through', () => {
    expect(countsAsListen(4, 210)).toBe(false);
    expect(countsAsListen(29, 210)).toBe(false);
  });

  it('counts a track once past 30s', () => {
    expect(countsAsListen(30, 210)).toBe(true);
    expect(countsAsListen(180, 210)).toBe(true);
  });

  it('uses half the length for tracks shorter than a minute, so they stay countable', () => {
    // A flat 30s threshold would make a 40s interlude impossible to ever count.
    expect(countsAsListen(21, 40)).toBe(true);
    expect(countsAsListen(19, 40)).toBe(false);
  });

  it('falls back to the flat threshold when the length is unknown', () => {
    expect(countsAsListen(29, 0)).toBe(false);
    expect(countsAsListen(31, 0)).toBe(true);
  });
});

describe('useMusicScrobble preview tally', () => {
  beforeEach(() => {
    mockedReportPreviewPlay.mockResolvedValue(undefined);
  });

  afterEach(() => {
    mockedReportPreviewPlay.mockReset();
  });

  it('does not count a preview that was never listened to', async () => {
    renderHarness();

    fireEvent.click(screen.getByRole('button', { name: 'play preview' }));
    await screen.findByText('now: Preview Song');

    // Position never advances here (jsdom drives no <audio>), which is exactly
    // the skipped-through case: switching away must count nothing.
    fireEvent.click(screen.getByRole('button', { name: 'play library' }));
    await screen.findByText('now: Library Song');

    await waitFor(() => expect(mockedReportPlaying).toHaveBeenCalled());
    expect(mockedReportPreviewPlay).not.toHaveBeenCalled();
  });
});
