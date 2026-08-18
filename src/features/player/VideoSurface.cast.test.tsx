/**
 * @vitest-environment-options { "url": "http://192.168.1.50:8600/player/item-1" }
 */
import { createRef } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoSurface } from './VideoSurface';
import { CastButton } from '../cast/CastButton';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { fetchCastDevices } from '../../api/cast';
import type { CastDevice } from '../../api/schemas/cast';

// The cast sheet rendered where it actually lives: inside the player's own
// control bar. Nothing else in the suite puts the two together, and the two
// bugs this file pins are only visible in that combination.

vi.mock('../../api/cast', () => ({
  fetchCastDevices: vi.fn(),
  playOnDevice: vi.fn(),
  stopDevice: vi.fn(),
}));

const mockedFetchCastDevices = vi.mocked(fetchCastDevices);

const DEVICE: CastDevice = {
  id: 'ssap:192.168.1.20',
  name: 'LG del living',
  address: '192.168.1.20',
  protocol: 'ssap',
  capability: 'app',
};

function noop() {
  /* test double */
}

const INERT_PROPS = {
  itemId: 'item-1',
  audioTracks: [],
  subtitleTracks: [],
  selectedAudioIndex: null,
  selectedSubtitleIndex: null,
  onAudioApplied: noop,
  onAudioSwitchUnavailable: noop,
  onSubtitleApplied: noop,
  selectedSecondSubtitleIndex: null,
  onSecondSubtitleApplied: noop,
  subtitleDeliveryMethods: {},
  onSubtitleSwitchUnavailable: noop,
  buildSubtitleUrl: () => '',
  isEpisode: false,
  episodes: [],
  currentEpisodeId: '',
  onSelectEpisode: noop,
};

function renderPlayerWithCast() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const videoRef = createRef<HTMLVideoElement>();
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <VideoSurface
          videoRef={videoRef}
          {...INERT_PROPS}
          source={{ kind: 'DirectPlay', url: '/jellyfin/Videos/item-1/stream.mp4' }}
          resumeSeconds={0}
          title="Duna"
          onBack={noop}
          onPlay={noop}
          onPause={noop}
          onEnded={noop}
          onError={noop}
          onUnsupported={noop}
          headerActions={
            <CastButton
              itemId="item-1"
              title="Duna"
              streamUrl="/jellyfin/Videos/item-1/stream.mkv?api_key=tok"
            />
          }
        />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('VideoSurface + CastButton', () => {
  beforeEach(() => {
    setSession({ jellyfinToken: 'tok', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
    mockedFetchCastDevices.mockResolvedValue([DEVICE]);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(noop);
  });

  afterEach(() => {
    clearSession();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('puts the cast trigger in the player top bar, beside the back button', async () => {
    renderPlayerWithCast();

    expect(screen.getByRole('button', { name: 'Enviar a la TV' })).toBeInTheDocument();
  });

  // The sheet is portalled into the player surface (its `[data-overlay-host]`)
  // and NOT into `document.body`: real Fullscreen paints nothing outside
  // `fullscreenElement`, and the iOS pseudo-fullscreen surface sits at
  // z-index 9999 over anything left on the body.
  it('portals the sheet inside the player surface, where fullscreen can paint it', async () => {
    const user = userEvent.setup();
    renderPlayerWithCast();

    await user.click(screen.getByRole('button', { name: 'Enviar a la TV' }));

    const dialog = await screen.findByRole('dialog', { name: 'Enviar a la TV' });
    const surface = document.querySelector('.pf-player-surface');
    expect(surface).not.toBeNull();
    expect(surface?.contains(dialog)).toBe(true);
  });

  // The sheet renders INSIDE the player's controls, so its key events bubble
  // through `VideoSurface`'s own handler on the React tree. Space there used
  // to pause the movie underneath while the viewer was choosing a television.
  it('does not let a key pressed inside the sheet drive the player', async () => {
    const user = userEvent.setup();
    renderPlayerWithCast();
    await user.click(screen.getByRole('button', { name: 'Enviar a la TV' }));
    const device = await screen.findByRole('button', { name: /LG del living/ });
    vi.mocked(HTMLMediaElement.prototype.play).mockClear();
    vi.mocked(HTMLMediaElement.prototype.pause).mockClear();

    fireEvent.keyDown(device, { key: ' ' });
    fireEvent.keyDown(device, { key: 'ArrowRight' });

    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
  });

  // …and it must achieve that WITHOUT stopping propagation, which would also
  // stop the native event and take the app's document-level D-pad navigation
  // with it - leaving a TV remote unable to move between the rows it is
  // looking at. This is the assertion that keeps the fix on the right side of
  // that trade.
  it('still lets the key reach document, so the TV D-pad keeps working', async () => {
    const user = userEvent.setup();
    renderPlayerWithCast();
    await user.click(screen.getByRole('button', { name: 'Enviar a la TV' }));
    const device = await screen.findByRole('button', { name: /LG del living/ });

    const onDocumentKey = vi.fn();
    document.addEventListener('keydown', onDocumentKey);
    try {
      fireEvent.keyDown(device, { key: 'ArrowDown' });
    } finally {
      document.removeEventListener('keydown', onDocumentKey);
    }

    expect(onDocumentKey).toHaveBeenCalledTimes(1);
  });

  it('keeps driving the player from keys pressed outside the sheet', async () => {
    renderPlayerWithCast();
    const surface = document.querySelector('.pf-player-surface') as HTMLElement;
    vi.mocked(HTMLMediaElement.prototype.play).mockClear();

    fireEvent.keyDown(surface, { key: ' ' });

    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });
});
