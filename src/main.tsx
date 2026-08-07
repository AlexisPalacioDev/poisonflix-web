import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import { App } from './App';
import { installSpatialNavigation } from './lib/tv/spatialNavigation';
import { markFlexGapSupport } from './lib/tv/flexGapFallback';

// Must run before first paint: adds `no-flex-gap` to <html> on engines without
// flexbox gap (the 2018 LG TV), which activates the generated margin fallbacks.
markFlexGapSupport();

// TV remotes emit arrow keys, which no browser maps to focus movement, so on
// the LG TV the page merely scrolled and nothing was ever selectable. Global
// rather than per-screen: every screen is built from natively focusable
// elements already, so one listener covers screens written before and after.
installSpatialNavigation();

// This app registers no service worker, but an earlier build did, and a
// registered one survives every deploy that follows: its NavigationRoute
// answers navigations from its own cached index.html, so the device keeps
// running a months-old bundle while the server happily serves the new one.
// That is invisible from the repo and cost a full day of "I already deployed
// that" against an owner who was, correctly, still seeing the old app.
//
// Evicting whatever is registered — and dropping its caches, since an
// unregistered worker leaves them behind — makes the next load self-repairing.
// Remove this only when a service worker is deliberately wired up.
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker
    .getRegistrations()
    .then((registrations) => Promise.all(registrations.map((r) => r.unregister())))
    .then(async (results) => {
      if (!results.some(Boolean) || typeof caches === 'undefined') return;
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      // The page in front of the user is still the stale one this worker served.
      window.location.reload();
    })
    .catch(() => {
      // Best effort: never let cleanup keep the app from starting.
    });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
