import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Row } from './Row';

const noop = () => {};
const renderString = (s: string) => <div key={s}>{s}</div>;

function baseProps() {
  return {
    items: ['A'],
    isLoading: false,
    isError: false,
    onRetry: noop,
    renderItem: renderString,
    emptyMessage: 'vacío',
  };
}

describe('Row', () => {
  it('renders the title as a link to titleTo, with a "Ver todo" affordance', () => {
    render(
      <MemoryRouter>
        <Row title="Acción" titleTo="/category/action" {...baseProps()} />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: /acción/i });
    expect(link).toHaveAttribute('href', '/category/action');
    expect(link).toHaveTextContent(/ver todo/i);
  });

  it('renders a plain, non-interactive heading when titleTo is omitted', () => {
    render(
      <MemoryRouter>
        <Row title="Acción" {...baseProps()} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Acción' })).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
