import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadedScreen } from './DownloadedScreen';
import { MusicPlayerProvider } from './MusicPlayerProvider';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';
import { getItems, deleteItem } from '../../api/jellyfin';
import { COARSE_POINTER, ruleInMedia } from '../../test/cssRules';

// "Tu música descargada" — the apartado the library got after the owner said it
// should not sit among the browse tabs "como si fuera una lista de
// reproducción". These tests pin the two things that made it worth building: it
// is reachable on its own, and it shows everything rather than a rail's worth.

vi.mock('../../api/jellyfin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/jellyfin')>()),
  getItems: vi.fn(),
  deleteItem: vi.fn(),
}));

vi.mock('../../api/music', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/music')>()),
  getRatings: vi.fn().mockResolvedValue({}),
  setTrackRating: vi.fn().mockResolvedValue(undefined),
  getMusicJob: vi.fn().mockResolvedValue(null),
  requestDownload: vi.fn().mockResolvedValue({ jobId: 'job-1' }),
  reportPreviewPlay: vi.fn().mockResolvedValue(undefined),
}));

const mockedGetItems = vi.mocked(getItems);
const mockedDeleteItem = vi.mocked(deleteItem);

function audio(id: string, name: string, artist = 'Someone') {
  return { Id: id, Name: name, Artists: [artist], AlbumArtist: artist, ImageTags: null };
}

function library(count: number) {
  return {
    Items: Array.from({ length: count }, (_, i) => audio(`aud-${i}`, `Song ${i}`, `Artist ${i}`)),
    TotalRecordCount: count,
    StartIndex: 0,
  };
}

function renderScreen() {
  setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <MemoryRouter initialEntries={['/musica/descargas']}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MusicPlayerProvider>
            <DownloadedScreen />
          </MusicPlayerProvider>
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('DownloadedScreen — tu música descargada', () => {
  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    clearSession();
    mockedGetItems.mockReset();
    mockedDeleteItem.mockReset();
  });

  it('names the section and counts what is actually on the server', async () => {
    mockedGetItems.mockResolvedValue(library(3) as never);
    renderScreen();

    expect(
      screen.getByRole('heading', { name: 'Tu música descargada', level: 1 }),
    ).toBeInTheDocument();
    expect(await screen.findByText('3 canciones guardadas, listas para sonar.')).toBeInTheDocument();
  });

  it('reads the whole library, not a rail-sized slice of it', async () => {
    mockedGetItems.mockResolvedValue(library(140) as never);
    renderScreen();

    expect(await screen.findByText('Song 139')).toBeInTheDocument();
    // 100 was fine while this was a preview list; on a page promising "all your
    // downloads" it would silently hide the rest.
    const params = mockedGetItems.mock.calls[0][1] as { limit?: number };
    expect(params.limit).toBeGreaterThanOrEqual(500);
  });

  it('plays a song from its cover, by click and from the keyboard', async () => {
    mockedGetItems.mockResolvedValue(library(2) as never);
    renderScreen();

    const cover = await screen.findByRole('button', { name: 'Reproducir Song 0' });
    expect(cover.tagName).toBe('BUTTON');

    fireEvent.click(cover);
    // Playing flips the label to Pausar, which is only true if the click reached
    // the player rather than dying on the artwork.
    expect(await screen.findByRole('button', { name: 'Pausar' })).toBeInTheDocument();

    // And the same surface is operable from the keyboard.
    const second = screen.getByRole('button', { name: 'Reproducir Song 1' });
    second.focus();
    expect(second).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Reproducir Song 0' })).toBeInTheDocument();
  });

  it('keeps the title a link to the track and the ⋮ out of playback', async () => {
    mockedGetItems.mockResolvedValue(library(2) as never);
    renderScreen();

    expect(await screen.findByRole('link', { name: 'Ver Song 0' })).toHaveAttribute(
      'href',
      '/musica/track/aud-0',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Más opciones para Song 0' }));

    expect(screen.getByRole('menu', { name: 'Opciones para Song 0' })).toBeInTheDocument();
    // Opening the menu must not have started the song underneath it.
    expect(screen.queryByRole('button', { name: 'Pausar' })).not.toBeInTheDocument();
  });

  it('plays the whole library from one button', async () => {
    mockedGetItems.mockResolvedValue(library(3) as never);
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'Reproducir todo' }));

    // The first track is the one sounding; the queue holds the rest.
    expect(await screen.findByRole('button', { name: 'Pausar' })).toBeInTheDocument();
  });

  it('filters in place once the library is big enough to need it', async () => {
    mockedGetItems.mockResolvedValue(library(20) as never);
    renderScreen();

    const filter = await screen.findByRole('searchbox', {
      name: 'Filtrar tu música descargada',
    });
    fireEvent.change(filter, { target: { value: 'Artist 7' } });

    expect(screen.getByRole('link', { name: 'Ver Song 7' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ver Song 6' })).not.toBeInTheDocument();

    fireEvent.change(filter, { target: { value: 'zzz' } });
    expect(screen.getByText('Nada coincide con "zzz".')).toBeInTheDocument();
  });

  it('hides the filter on a library small enough to just look at', async () => {
    mockedGetItems.mockResolvedValue(library(4) as never);
    renderScreen();

    await screen.findByRole('link', { name: 'Ver Song 0' });
    expect(
      screen.queryByRole('searchbox', { name: 'Filtrar tu música descargada' }),
    ).not.toBeInTheDocument();
  });

  it('sends an empty library back to search instead of a dead end', async () => {
    mockedGetItems.mockResolvedValue({ Items: [], TotalRecordCount: 0, StartIndex: 0 } as never);
    renderScreen();

    expect(await screen.findByText(/todavía no descargaste música/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Buscá una canción' })).toHaveAttribute(
      'href',
      '/musica',
    );
    // Nothing to play, so no play-all button pretending otherwise.
    expect(screen.queryByRole('button', { name: 'Reproducir todo' })).not.toBeInTheDocument();
  });

  it('offers a retry when the library cannot be read', async () => {
    mockedGetItems.mockRejectedValue(new Error('boom'));
    renderScreen();

    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo leer tu música.');
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
  });

  // A page titled "Tu música descargada" that says 700 over a grid of 500 is
  // not a rounding error, it is a page lying about its own subject: the missing
  // 200 could not be played by "Reproducir todo" and the filter answered "Nada
  // coincide" for every one of them. One request is still the normal case; the
  // walk is what keeps the promise when one request is not enough.
  it('pages past the request cap so the grid really is the whole library', async () => {
    mockedGetItems.mockImplementation(async (_userId, params) => {
      const start = params?.startIndex ?? 0;
      const limit = params?.limit ?? 0;
      return {
        Items: Array.from({ length: Math.max(0, Math.min(limit, 700 - start)) }, (_, i) =>
          audio(`aud-${start + i}`, `Song ${start + i}`, `Artist ${start + i}`),
        ),
        TotalRecordCount: 700,
        StartIndex: start,
      } as never;
    });
    const { container } = renderScreen();

    // Selector queries, not `findByText`/`getByRole`: at this size a single
    // accessibility-tree scan costs more than the render and pushes the test
    // past its timeout when the suite runs under load.
    await waitFor(() => expect(container.querySelectorAll('.pf-music__lib-card')).toHaveLength(700));

    // The caption counts rendered songs, so it can only read 700 if all 700
    // really are on the page.
    expect(container.querySelector('.pf-music__lib-count')?.textContent).toBe(
      '700 canciones guardadas, listas para sonar.',
    );
    expect(container.querySelector('a[href="/musica/track/aud-699"]')).not.toBeNull();
    expect(mockedGetItems.mock.calls.map((call) => call[1]?.startIndex)).toEqual([0, 500]);
  }, 20_000);

  // The response schema defaults `TotalRecordCount` to 0 when the server omits
  // it, so a walk that trusted the count to tell it when to stop would stop at
  // once (`500 >= 0`) and call half a library "everything you downloaded".
  it('keeps paging when the server sends no total at all', async () => {
    mockedGetItems.mockImplementation(async (_userId, params) => {
      const start = params?.startIndex ?? 0;
      const limit = params?.limit ?? 0;
      return {
        Items: Array.from({ length: Math.max(0, Math.min(limit, 600 - start)) }, (_, i) =>
          audio(`aud-${start + i}`, `Song ${start + i}`, `Artist ${start + i}`),
        ),
        TotalRecordCount: 0,
        StartIndex: start,
      } as never;
    });
    const { container } = renderScreen();

    await waitFor(() => expect(container.querySelectorAll('.pf-music__lib-card')).toHaveLength(600));

    expect(container.querySelector('.pf-music__lib-count')?.textContent).toBe(
      '600 canciones guardadas, listas para sonar.',
    );
    // A short page — not the count — is what ends the walk.
    expect(mockedGetItems.mock.calls.map((call) => call[1]?.startIndex)).toEqual([0, 500]);
  }, 20_000);

  // The old "Canciones" tab this grid replaced drew an always-visible green
  // disc on every row. The cover card it borrows instead hides its disc until
  // hover, which on the owner's phone means forever.
  it('shows the play disc on a pointer that cannot hover', async () => {
    mockedGetItems.mockResolvedValue(library(2) as never);
    const { container } = renderScreen();
    await screen.findByRole('button', { name: 'Reproducir Song 0' });

    const css = readFileSync(resolve(__dirname, 'music.css'), 'utf8');
    const rule = ruleInMedia(css, COARSE_POINTER, '.pf-music__rec-btn');
    expect(rule, 'the coarse-pointer rule for the play disc is gone').not.toBeNull();

    const btn = container.querySelector('.pf-music__rec-btn') as HTMLElement;
    expect(btn.matches(rule?.selector ?? '')).toBe(true);
    expect(rule?.declarations).toMatch(/opacity:\s*1\s*;/);
  });
});
