import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PosterCard } from './PosterCard';

function DetailStub() {
  return <h1>Detail Stub</h1>;
}

function PlayerStub() {
  return <h1>Player Stub</h1>;
}

describe('PosterCard', () => {
  it('navigates to /detail/:id when clicked (task: clicking a poster navigates to detail)', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={<PosterCard item={{ id: '42', title: 'The Matrix', imageUrl: null }} />}
          />
          <Route path="/detail/:id" element={<DetailStub />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: /the matrix/i }));

    expect(await screen.findByRole('heading', { name: /detail stub/i })).toBeInTheDocument();
  });

  it('is keyboard-focusable and activatable via Enter (ADR-6: real focus, no mouse-only handlers)', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={<PosterCard item={{ id: '7', title: 'Night of the Living Dead', imageUrl: null }} />}
          />
          <Route path="/detail/:id" element={<DetailStub />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.tab();
    expect(screen.getByRole('button', { name: /night of the living dead/i })).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: /detail stub/i })).toBeInTheDocument();
  });

  it('renders a placeholder letter when there is no imageUrl', () => {
    render(
      <MemoryRouter>
        <PosterCard item={{ id: '1', title: 'Zebra', imageUrl: null }} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Z')).toBeInTheDocument();
  });

  it('renders a progress bar sized to the given progressPercent', () => {
    const { container } = render(
      <MemoryRouter>
        <PosterCard item={{ id: '2', title: 'Alien', imageUrl: null, progressPercent: 42 }} />
      </MemoryRouter>,
    );
    const fill = container.querySelector('.pf-poster-card__progress-fill');
    expect(fill).toHaveStyle({ width: '42%' });
  });

  it('renders the badge slot when provided', () => {
    render(
      <MemoryRouter>
        <PosterCard
          item={{ id: '3', title: 'Predator', imageUrl: null, badge: <span>PEDIR</span> }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('PEDIR')).toBeInTheDocument();
  });

  it('the `to` prop overrides the default /detail/:id navigation (Continue Watching direct-play)', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={
              <PosterCard
                item={{ id: 'jf-1', title: 'Solo Leveling', imageUrl: null }}
                to="/player/jf-1"
              />
            }
          />
          <Route path="/detail/:id" element={<DetailStub />} />
          <Route path="/player/:id" element={<PlayerStub />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: /solo leveling/i }));

    expect(await screen.findByRole('heading', { name: /player stub/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /detail stub/i })).not.toBeInTheDocument();
  });

  describe('onLongClick (press-and-hold)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('fires onLongClick on a ~500ms press-and-hold, swallowing the trailing click/navigation', () => {
      vi.useFakeTimers();
      const onLongClick = vi.fn();
      render(
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route
              path="/"
              element={
                <PosterCard
                  item={{ id: '4', title: 'The Thing', imageUrl: null }}
                  onLongClick={onLongClick}
                />
              }
            />
            <Route path="/detail/:id" element={<DetailStub />} />
          </Routes>
        </MemoryRouter>,
      );

      const button = screen.getByRole('button', { name: /the thing/i });
      fireEvent.pointerDown(button);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      fireEvent.pointerUp(button);
      // Browsers still dispatch a click after pointerup even for a held press.
      fireEvent.click(button);

      expect(onLongClick).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('heading', { name: /detail stub/i })).not.toBeInTheDocument();
    });

    it('still fires the normal click/navigation on a short press', async () => {
      const onLongClick = vi.fn();
      const user = userEvent.setup();
      render(
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route
              path="/"
              element={
                <PosterCard
                  item={{ id: '5', title: 'They Live', imageUrl: null }}
                  onLongClick={onLongClick}
                />
              }
            />
            <Route path="/detail/:id" element={<DetailStub />} />
          </Routes>
        </MemoryRouter>,
      );

      await user.click(screen.getByRole('button', { name: /they live/i }));

      expect(onLongClick).not.toHaveBeenCalled();
      expect(await screen.findByRole('heading', { name: /detail stub/i })).toBeInTheDocument();
    });

    it('a short Enter press (released before 500ms) navigates and does not call onLongClick', () => {
      vi.useFakeTimers();
      const onLongClick = vi.fn();
      render(
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route
              path="/"
              element={
                <PosterCard
                  item={{ id: '6', title: 'Chopping Mall', imageUrl: null }}
                  onLongClick={onLongClick}
                />
              }
            />
            <Route path="/detail/:id" element={<DetailStub />} />
          </Routes>
        </MemoryRouter>,
      );

      const button = screen.getByRole('button', { name: /chopping mall/i });
      fireEvent.keyDown(button, { key: 'Enter' });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      fireEvent.keyUp(button, { key: 'Enter' });

      expect(onLongClick).not.toHaveBeenCalled();
      expect(screen.getByRole('heading', { name: /detail stub/i })).toBeInTheDocument();
    });

    it('a held Enter (>=500ms) calls onLongClick and does not navigate', () => {
      vi.useFakeTimers();
      const onLongClick = vi.fn();
      render(
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route
              path="/"
              element={
                <PosterCard
                  item={{ id: '8', title: 'Basket Case', imageUrl: null }}
                  onLongClick={onLongClick}
                />
              }
            />
            <Route path="/detail/:id" element={<DetailStub />} />
          </Routes>
        </MemoryRouter>,
      );

      const button = screen.getByRole('button', { name: /basket case/i });
      fireEvent.keyDown(button, { key: 'Enter' });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      fireEvent.keyUp(button, { key: 'Enter' });

      expect(onLongClick).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('heading', { name: /detail stub/i })).not.toBeInTheDocument();
    });

    it('a card without onLongClick still navigates on Enter (native activation unchanged)', async () => {
      const user = userEvent.setup();
      render(
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route
              path="/"
              element={<PosterCard item={{ id: '9', title: 'Re-Animator', imageUrl: null }} />}
            />
            <Route path="/detail/:id" element={<DetailStub />} />
          </Routes>
        </MemoryRouter>,
      );

      await user.tab();
      await user.keyboard('{Enter}');

      expect(await screen.findByRole('heading', { name: /detail stub/i })).toBeInTheDocument();
    });
  });
});
