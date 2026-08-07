import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MusicRowMenu } from './MusicRowMenu';
import { AuthProvider } from '../../auth/AuthContext';
import { clearSession, setSession } from '../../lib/session/store';

// The universal "⋮" overflow menu. Was one of the four overlays that already
// worked on touch (a real `<button>` catcher + a separately positioned panel,
// not a `document` listener) - migrated to `OverlayShell` per design D
// (`sdd/mobile-music-overhaul`) to drop the divergent pattern while keeping
// exactly the same DOM shape (transparent click-catcher + anchored panel).

function renderMenu(overrides: Partial<React.ComponentProps<typeof MusicRowMenu>> = {}) {
  setSession({ jellyfinToken: 'tok-1', jellyfinUserId: 'user-1', jellyseerrCookiePresent: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MusicRowMenu title="My Track" itemId="item-1" {...overrides} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('MusicRowMenu shared dismissal', () => {
  afterEach(() => {
    clearSession();
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.width = '';
  });

  it('opens the menu on kebab click', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Más opciones para My Track' }));
    expect(screen.getByRole('menu', { name: 'Opciones para My Track' })).toBeInTheDocument();
  });

  it('closes on Escape', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Más opciones para My Track' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes when clicking the backdrop', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Más opciones para My Track' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cerrar menú' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('locks body scroll while open and releases it on close', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Más opciones para My Track' }));
    expect(document.body.style.position).toBe('fixed');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.body.style.position).toBe('');
  });

  it('returns focus to the kebab trigger once closed', () => {
    renderMenu();
    const trigger = screen.getByRole('button', { name: 'Más opciones para My Track' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(trigger).toHaveFocus();
  });

  it('has role="menu" on the panel (not role="dialog")', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Más opciones para My Track' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  // Unconfirmed suspicion from the same real-Chrome audit that found the
  // Header blocker: `.pf-music__row:hover` applies a `transform`, which
  // creates its OWN stacking context for the whole row - including this
  // menu's anchored panel, a normal-flow descendant of that row. A backdrop
  // portalled straight to `document.body` (escaping the row entirely) would
  // then out-rank the ENTIRE row (transform-created contexts behave as
  // z-index: 0) regardless of the panel's own z-index, hiding every menu
  // item behind the backdrop while the row is hovered - the same class of
  // bug as the Header blocker. Portalling backdrop + panel TOGETHER (this
  // component's fix) makes the panel escape the row's local context too, so
  // it can no longer be trapped there.
  //
  // jsdom applies no CSS at all (no `transform`, no stacking, no paint), so
  // it cannot reproduce the hover state or prove the visual fix - this is a
  // structural proxy: the panel must not be a DOM descendant of this
  // component's own local wrapper, which is as far as this test file can
  // observe without a `.pf-music__row` ancestor (that lives in the caller,
  // `MusicResultRow.tsx`). Real verification is an on-device acceptance step.
  it('portals the anchored panel outside its own local wrapper (immune to an ancestor stacking context)', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Más opciones para My Track' }));

    const panel = screen.getByRole('menu', { name: 'Opciones para My Track' });
    const localWrapper = screen.getByRole('button', { name: 'Más opciones para My Track' }).closest('.pf-music__addpl');

    expect(localWrapper).not.toBeNull();
    expect(localWrapper?.contains(panel)).toBe(false);
    expect(panel.parentElement?.parentElement).toBe(document.body);
  });
});
