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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
