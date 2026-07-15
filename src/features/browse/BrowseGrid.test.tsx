import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext';
import { BrowseGrid } from './BrowseGrid';

// BrowseGrid is a screen template (it renders the app Header), so it's wrapped
// with the same QueryClient + Router + Auth providers Header.test uses.
function renderGrid(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AuthProvider>{ui}</AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const noop = () => {};
const renderString = (s: string) => <div key={s}>{s}</div>;

describe('BrowseGrid', () => {
  it('renders every item once content has loaded', () => {
    renderGrid(
      <BrowseGrid
        title="Acción"
        items={['Mad Max', 'John Wick']}
        isLoading={false}
        isError={false}
        onRetry={noop}
        renderItem={renderString}
        emptyMessage="vacío"
      />,
    );

    expect(screen.getByRole('heading', { name: 'Acción' })).toBeInTheDocument();
    expect(screen.getByText('Mad Max')).toBeInTheDocument();
    expect(screen.getByText('John Wick')).toBeInTheDocument();
  });

  it('shows the empty message when the (successful) item list is empty', () => {
    renderGrid(
      <BrowseGrid
        title="Acción"
        items={[]}
        isLoading={false}
        isError={false}
        onRetry={noop}
        renderItem={renderString}
        emptyMessage="No hay títulos de acción."
      />,
    );

    expect(screen.getByText('No hay títulos de acción.')).toBeInTheDocument();
  });

  it('surfaces an error with a retry button that calls onRetry (row isolation, per screen)', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    renderGrid(
      <BrowseGrid
        title="Acción"
        items={undefined}
        isLoading={false}
        isError
        onRetry={onRetry}
        renderItem={renderString}
        emptyMessage="vacío"
      />,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /reintentar/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders neither content nor empty message while loading', () => {
    renderGrid(
      <BrowseGrid
        title="Acción"
        items={undefined}
        isLoading
        isError={false}
        onRetry={noop}
        renderItem={renderString}
        emptyMessage="vacío"
      />,
    );

    expect(screen.queryByText('vacío')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
