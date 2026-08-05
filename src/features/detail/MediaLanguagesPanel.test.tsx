import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { JellyfinItem } from '../../api/schemas/jellyfin';
import { MediaLanguagesPanel } from './MediaLanguagesPanel';

function itemWithSubtitles(codes: string[]): JellyfinItem {
  return {
    Id: 'jf-1',
    Name: 'Item',
    MediaStreams: [
      { Type: 'Audio', Language: 'spa', IsDefault: true },
      ...codes.map((code) => ({ Type: 'Subtitle', Language: code })),
    ],
  } as unknown as JellyfinItem;
}

describe('MediaLanguagesPanel', () => {
  it('renders nothing when there is no data and it is not loading', () => {
    const { container } = render(<MediaLanguagesPanel item={null} isLoading={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a loading hint while isLoading', () => {
    render(<MediaLanguagesPanel item={null} isLoading />);
    expect(screen.getByText('Cargando idiomas…')).toBeInTheDocument();
  });

  it('shows no "+N" control when the subtitle list fits within the cap (4)', () => {
    const item = itemWithSubtitles(['spa', 'eng', 'fra']);
    render(<MediaLanguagesPanel item={item} isLoading={false} />);
    expect(screen.queryByRole('button', { name: /^\+\d+$/ })).not.toBeInTheDocument();
  });

  it('collapses a long subtitle list behind a "+N" control (24-track scenario, detail-request spec)', () => {
    // 24 distinct subtitle tracks - reuse plenty of ISO codes covered by languageNames.ts.
    const codes = [
      'spa', 'eng', 'fra', 'deu', 'ita', 'jpn', 'kor', 'zho', 'rus', 'ara',
      'nld', 'ces', 'dan', 'ell', 'fin', 'hun', 'nor', 'pol', 'ron', 'slk',
      'swe', 'tur', 'heb', 'hin',
    ];
    const item = itemWithSubtitles(codes);
    render(<MediaLanguagesPanel item={item} isLoading={false} />);

    const card = screen.getByRole('status');
    const subtitleRow = within(card).getByText('Subtítulos').closest('.pf-media-langs__row') as HTMLElement;
    const visibleChips = within(subtitleRow).getAllByRole('listitem');
    // 4 always-visible chips (spec cap) + the "+N" collapse control.
    expect(visibleChips).toHaveLength(4);
    expect(within(subtitleRow).getByRole('button', { name: '+20' })).toBeInTheDocument();
  });

  it('expands the collapsed subtitle list on activation, revealing resolved display names', async () => {
    const codes = [
      'spa', 'eng', 'fra', 'deu', 'ita', 'jpn', 'kor', 'zho', 'rus', 'ara',
      'nld', 'ces', 'dan', 'ell', 'fin', 'hun', 'nor', 'pol', 'ron', 'slk',
      'swe', 'tur', 'heb', 'hin',
    ];
    const item = itemWithSubtitles(codes);
    const user = userEvent.setup();
    render(<MediaLanguagesPanel item={item} isLoading={false} />);

    const card = screen.getByRole('status');
    const subtitleRow = within(card).getByText('Subtítulos').closest('.pf-media-langs__row') as HTMLElement;
    await user.click(within(subtitleRow).getByRole('button', { name: '+20' }));

    expect(within(subtitleRow).getAllByRole('listitem')).toHaveLength(24);
    expect(within(subtitleRow).getByText('Checo')).toBeInTheDocument();
    expect(within(subtitleRow).getByText('Húngaro')).toBeInTheDocument();
    expect(within(subtitleRow).queryByRole('button', { name: /^\+\d+$/ })).not.toBeInTheDocument();
  });

  it('prioritizes Español, Inglés and the file default among the always-visible chips', () => {
    const item: JellyfinItem = {
      Id: 'jf-2',
      Name: 'Item',
      MediaStreams: [
        { Type: 'Audio', Language: 'fra', IsDefault: true },
        { Type: 'Subtitle', Language: 'deu' },
        { Type: 'Subtitle', Language: 'ita' },
        { Type: 'Subtitle', Language: 'jpn' },
        { Type: 'Subtitle', Language: 'kor' },
        { Type: 'Subtitle', Language: 'spa' },
        { Type: 'Subtitle', Language: 'eng' },
        { Type: 'Subtitle', Language: 'fra' },
      ],
    } as unknown as JellyfinItem;
    render(<MediaLanguagesPanel item={item} isLoading={false} />);

    const card = screen.getByRole('status');
    const subtitleRow = within(card).getByText('Subtítulos').closest('.pf-media-langs__row') as HTMLElement;
    const visibleLabels = within(subtitleRow)
      .getAllByRole('listitem')
      .map((el) => el.textContent);
    expect(visibleLabels).toEqual(['Español', 'Inglés', 'Francés', 'Alemán']);
  });
});
