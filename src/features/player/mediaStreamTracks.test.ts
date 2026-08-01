import { describe, expect, it } from 'vitest';
import { bestAudioPerLanguage, type MediaStreamTrack } from './mediaStreamTracks';

const audio = (
  index: number,
  language: string,
  displayTitle: string,
  isDefault = false,
): MediaStreamTrack => ({
  index,
  kind: 'Audio',
  language,
  displayTitle,
  isDefault,
  isForced: false,
});

describe('bestAudioPerLanguage', () => {
  it('collapses the four English tracks of a remux into one', () => {
    // El Drama's real shape: TrueHD 7.1 (default), AC3 5.1, AC3 stereo, AC3 5.1.
    // The menu used to list these as "Inglés", "Inglés 2", "Inglés 3", "Inglés 4".
    const result = bestAudioPerLanguage([
      audio(1, 'eng', 'Surround 7.1 - English - Dolby TrueHD', true),
      audio(2, 'eng', 'Surround 5.1 - English - Dolby Digital'),
      audio(3, 'eng', 'Stereo - English - Dolby Digital'),
      audio(4, 'eng', 'Surround 5.1 - English - Dolby Digital'),
    ]);

    expect(result).toHaveLength(1);
    // The file's own default survives, which is the load-bearing part:
    // collapsing the menu must not change which track actually plays.
    expect(result[0].index).toBe(1);
  });

  it('keeps one entry per distinct language', () => {
    const result = bestAudioPerLanguage([
      audio(1, 'eng', 'English', true),
      audio(2, 'eng', 'English'),
      audio(3, 'spa', 'Spanish'),
    ]);

    expect(result).toHaveLength(2);
    expect(result.map((track) => track.language).sort()).toEqual(['eng', 'spa']);
  });

  it('falls back to the lowest index when nothing is flagged default', () => {
    const result = bestAudioPerLanguage([audio(5, 'eng', 'English'), audio(2, 'eng', 'English')]);

    expect(result).toHaveLength(1);
    expect(result[0].index).toBe(2);
  });

  it('leaves a single-track file untouched', () => {
    const only = audio(1, 'spa', 'Spanish', true);
    expect(bestAudioPerLanguage([only])).toEqual([only]);
  });
});
