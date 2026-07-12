import { describe, expect, it } from 'vitest';
import { displayTitle } from './displayTitle';

describe('displayTitle (presentational Jellyfin name cleaner)', () => {
  it('cleans a scene-release folder name down to the title', () => {
    expect(
      displayTitle('GalaxyRG265 - The.Matrix.1999.1080p.BluRay.DDP5.1.x265.10bit-GalaxyRG265'),
    ).toBe('The Matrix');
  });

  it('handles dotted names without a group prefix', () => {
    expect(displayTitle('Night.of.the.Living.Dead.1968.720p.BluRay.x264')).toBe(
      'Night of the Living Dead',
    );
  });

  it('leaves an ordinary clean title untouched', () => {
    expect(displayTitle('La noche de los muertos vivientes')).toBe('La noche de los muertos vivientes');
  });

  it('does not mangle a legitimate title with a dash and colon', () => {
    expect(displayTitle('Mission: Impossible - Dead Reckoning')).toBe(
      'Mission: Impossible - Dead Reckoning',
    );
  });

  it('trims surrounding whitespace on pass-through', () => {
    expect(displayTitle('  Moana  ')).toBe('Moana');
  });
});
