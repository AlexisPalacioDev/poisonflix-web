import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { PosterCard } from './PosterCard';

function DetailStub() {
  return <h1>Detail Stub</h1>;
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
});
