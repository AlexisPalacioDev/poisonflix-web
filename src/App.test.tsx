import { render, screen } from '@testing-library/react';
import { createMemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { routes } from './routes';

describe('App', () => {
  it('renders the app shell without crashing', async () => {
    // createMemoryRouter (not the real browser router) because jsdom's fetch
    // polyfill doesn't fully match the data router's AbortSignal usage.
    // Land directly on a matched route (no <Navigate> redirect involved) —
    // v6 data routers run redirect navigation through an internal fetch-like
    // path that isn't jsdom-safe; that's covered by Slice 3's RouteGuard
    // tests with a proper polyfill, not this Slice 0 smoke test.
    const router = createMemoryRouter(routes, { initialEntries: ['/onboarding'] });
    render(<App router={router} />);

    expect(await screen.findByText(/onboarding screen placeholder/i)).toBeInTheDocument();
  });
});
