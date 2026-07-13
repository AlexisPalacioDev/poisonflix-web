import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../lib/http/client';
import { setLanguage } from '../lib/domain/languageSettings';
import { discoverMovies, discoverTrending, discoverTv, search } from './jellyseerr';

// Asserts the ES⇄EN language toggle (lib/domain/languageSettings.ts) is
// actually threaded into the jellyseerr requests that carry a `language`
// query param (search/discoverTrending), and - per ADR-4 - stays completely
// absent from discover/movies|tv regardless of the toggle.

vi.mock('../lib/http/client', () => ({
  apiFetch: vi.fn().mockResolvedValue(undefined),
}));

const mockedApiFetch = vi.mocked(apiFetch);

describe('jellyseerr.ts language threading', () => {
  afterEach(() => {
    mockedApiFetch.mockClear();
    localStorage.removeItem('poisonflix:language');
  });

  it('search sends language=es-MX when the app language is "es" (default)', async () => {
    await search('breaking bad');

    const [, path] = mockedApiFetch.mock.calls[0];
    expect(path).toContain('language=es-MX');
  });

  it('search sends language=en when the app language is "en"', async () => {
    setLanguage('en');
    await search('breaking bad');

    const [, path] = mockedApiFetch.mock.calls[0];
    expect(path).toContain('language=en');
    expect(path).not.toContain('es-MX');
  });

  it('discoverTrending sends language=es-MX by default and language=en after toggling', async () => {
    await discoverTrending();
    expect(mockedApiFetch.mock.calls[0][1]).toContain('language=es-MX');

    mockedApiFetch.mockClear();
    setLanguage('en');
    await discoverTrending();
    expect(mockedApiFetch.mock.calls[0][1]).toContain('language=en');
  });

  it('discoverMovies sends NO language param regardless of the current app language (ADR-4)', async () => {
    await discoverMovies();
    expect(mockedApiFetch.mock.calls[0][1]).not.toContain('language');

    mockedApiFetch.mockClear();
    setLanguage('en');
    await discoverMovies();
    expect(mockedApiFetch.mock.calls[0][1]).not.toContain('language');
  });

  it('discoverTv sends NO language param regardless of the current app language (ADR-4)', async () => {
    await discoverTv();
    expect(mockedApiFetch.mock.calls[0][1]).not.toContain('language');

    mockedApiFetch.mockClear();
    setLanguage('en');
    await discoverTv();
    expect(mockedApiFetch.mock.calls[0][1]).not.toContain('language');
  });
});
