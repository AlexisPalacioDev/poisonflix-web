import { execSync } from 'node:child_process';
import { configDefaults, defineConfig } from 'vitest/config';
import type { ProxyOptions } from 'vite';

// Build stamp, injected at build time.
//
// Most of a long night was lost to not knowing which code was running: a
// deploy went to the wrong host, a bind mount kept serving a deleted
// directory, and every symptom looked like "the fix did not work" when the fix
// simply was not there. A visible build id turns that whole class of question
// into a glance.
function buildStamp() {
  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    /* not a git checkout (CI tarball, vendored copy) — the timestamp still identifies it */
  }
  return { commit, builtAt: new Date().toISOString() };
}
import react from '@vitejs/plugin-react';
import legacy from '@vitejs/plugin-legacy';
import { VitePWA } from 'vite-plugin-pwa';
import autoprefixer from 'autoprefixer';
import flexGapFallback from './postcss-flex-gap-fallback.mjs';

/**
 * Route a prefix at the deployed Caddy, keeping Origin and Host in agreement.
 *
 * `changeOrigin` rewrites Host to the target, but the browser keeps sending
 * `Origin: http://localhost:5173`. The BFF's CSRF check compares the two and
 * answers 403 `bad_origin` to every mutation. GETs are exempt, so SSE and
 * snapshots keep working and the symptom reads as a dead button rather than a
 * proxy problem — it cost an afternoon once. Rewriting Origin to match Host
 * restores the pair.
 *
 * Dev only: this is reachable solely through PF_PROXY_ORIGIN, and in production
 * Caddy serves the app and the BFF from one origin, where the check is real.
 */
function proxyToDeployedOrigin(origin: string): ProxyOptions {
  return {
    target: origin,
    changeOrigin: true,
    configure: (proxy) => {
      proxy.on('proxyReq', (proxyReq) => {
        // Only when the browser sent one: adding an Origin to a request that
        // had none would turn a same-origin call into a cross-origin one.
        if (proxyReq.getHeader('origin')) proxyReq.setHeader('origin', origin);
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    __PF_BUILD__: JSON.stringify(buildStamp()),
  },
  css: {
    postcss: {
      plugins: [
        // Generates `.no-flex-gap ... > * + *` margin rules beside every flex
        // `gap`, for the 2018 TV browser that silently drops the property.
        // The class is only applied when runtime detection fails, so modern
        // browsers are unaffected. See postcss-flex-gap-fallback.mjs.
        flexGapFallback(),
        // Adds `-webkit-`/other vendor prefixes per the `browserslist` field
        // in package.json (chrome >= 53, safari >= 10) - e.g.
        // `-webkit-backdrop-filter`, `-webkit-mask-image`. This is PREFIXING
        // only, never a value rewrite - it does not solve `clamp()`/`gap`/
        // `:focus-visible` (design.md D2's corrections table on why
        // `postcss-preset-env` was rejected for that job).
        autoprefixer(),
      ],
    },
  },
  plugins: [
    react(),
    // The 2018 LG webOS 4.x TV browser is Chromium ~53, which predates
    // `<script type="module">` (Chrome 61+). Vite's default `modules` target
    // emits ONLY a module script, so that browser silently skipped it and
    // rendered a black screen - no error, nothing executed at all.
    //
    // This emits a parallel ES5 + SystemJS bundle tagged `nomodule`, which
    // module-aware browsers ignore and old ones load. Keep the targets low
    // enough to cover that TV; raising them re-breaks it silently, since the
    // failure mode is a blank page rather than a console error.
    legacy({
      targets: ['chrome >= 53', 'edge >= 15', 'safari >= 10'],
      // webOS 4's engine is missing more than syntax (Promise.allSettled,
      // Object.fromEntries, String.replaceAll...), so ship the polyfills the
      // legacy chunk needs instead of only transpiling.
      renderLegacyChunks: true,
      modernPolyfills: true,
    }),
    // PWA plugin present per design.md §9 but intentionally INACTIVE for MVP:
    // no service worker registration is wired up (injectRegister: null,
    // empty workbox globPatterns), so there's no offline caching / install
    // prompt yet. Deferred per tasks.md "Deferred" list. Wiring it live is
    // a later slice, not a retrofit of the plugin itself.
    //
    // `selfDestroying` matters because "we never register it" only describes
    // THIS build. An earlier one did, and a registered service worker outlives
    // every deploy that follows: its NavigationRoute answers each navigation
    // from its own cached index.html, so the owner kept seeing a months-old app
    // no matter what shipped. Nothing in the repo can reveal that — the stale
    // worker lives in the browser. This emits a worker that unregisters itself
    // and clears its caches, so the next visit repairs the device instead of
    // waiting for someone to know to clear site data.
    VitePWA({
      selfDestroying: true,
      registerType: 'prompt',
      injectRegister: null,
      manifest: {
        name: 'PoisonFlix',
        short_name: 'PoisonFlix',
        description: 'Thin same-origin PWA client for Jellyfin + Jellyseerr',
        theme_color: '#0a0c10',
        background_color: '#0a0c10',
        display: 'standalone',
        // Rendered from `public/brand-video.png`, the clapper artwork the owner
        // supplied - NOT from the PoisonMark component, whatever this comment
        // used to claim. PoisonMark is a flat re-draw of that same artwork, and
        // `public/favicon.svg` is exported from it, so the launcher icon and the
        // in-app mark share a source even though they are produced separately.
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: [],
      },
    }),
  ],
  server: {
    proxy: {
      // Mirrors infra/Caddyfile's `handle_path /jellyfin/*` (strips the
      // /jellyfin prefix before reverse-proxying to Jellyfin) so dev is
      // same-origin exactly like production. Targets are env-overridable so a
      // dev machine that reaches the backends on a LAN IP (e.g. 192.168.1.61)
      // instead of localhost can point the proxy without editing this file.
      '/jellyfin': {
        target: process.env.JELLYFIN_TARGET ?? 'http://localhost:8096',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/jellyfin/, ''),
      },
      // Mirrors infra/Caddyfile's `handle_path /jellyseerr/*`.
      '/jellyseerr': {
        target: process.env.JELLYSEERR_TARGET ?? 'http://localhost:5055',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/jellyseerr/, ''),
      },
      // Prowlarr manual search for the availability preview. The API key is
      // injected here (server-side) from PROWLARR_API_KEY so it never ships in
      // the client bundle — the browser calls /prowlarr/* with no credential.
      // Mirrors infra/Caddyfile's `handle_path /prowlarr/*` (header_up X-Api-Key).
      '/prowlarr': {
        target: process.env.PROWLARR_TARGET ?? 'http://localhost:9696',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/prowlarr/, ''),
        configure: (proxy) => {
          const key = process.env.PROWLARR_API_KEY;
          if (key) {
            proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('X-Api-Key', key));
          }
        },
      },
      // Radarr (movies) and Sonarr (series) power live download-% (queue),
      // library delete, and download cancel. Same server-side X-Api-Key
      // injection pattern as Prowlarr so the key never ships to the client.
      // Mirror these `handle_path` blocks in infra/Caddyfile for production.
      '/radarr': {
        target: process.env.RADARR_TARGET ?? 'http://localhost:7878',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/radarr/, ''),
        configure: (proxy) => {
          const key = process.env.RADARR_API_KEY;
          if (key) {
            proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('X-Api-Key', key));
          }
        },
      },
      '/sonarr': {
        target: process.env.SONARR_TARGET ?? 'http://localhost:8989',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/sonarr/, ''),
        configure: (proxy) => {
          const key = process.env.SONARR_API_KEY;
          if (key) {
            proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('X-Api-Key', key));
          }
        },
      },
      // Escape hatch for a dev box whose backends all live behind the deployed
      // Caddy (e.g. the media server on the tailnet). Caddy already owns every
      // `/jellyfin|/sonarr|/bff|...` prefix AND injects the X-Api-Key headers,
      // so this needs no per-service target and no API keys locally - but it
      // also must NOT strip the prefix, which is why it can't just be another
      // *_TARGET value. Spread LAST so it overrides the per-service entries
      // above (later keys win in an object literal). `/bff` only exists here:
      // in production Caddy serves it, and there is no local BFF to point at.
      //   PF_PROXY_ORIGIN=http://100.115.40.52:8600 npm run dev
      // `changeOrigin` rewrites Host to the target, but the browser keeps
      // sending `Origin: http://localhost:5173`. The BFF's CSRF check compares
      // those two and rejects every mutation with 403 `bad_origin` — GETs pass,
      // so SSE and snapshots work and it reads as a dead button rather than a
      // proxy problem. Rewriting Origin to match restores the pair. Dev only:
      // this whole branch needs PF_PROXY_ORIGIN, and in production Caddy serves
      // the app and the BFF from one origin, where the check is real.
      ...(process.env.PF_PROXY_ORIGIN
        ? Object.fromEntries(
            ['/jellyfin', '/jellyseerr', '/prowlarr', '/radarr', '/sonarr', '/bff'].map(
              (prefix) => [prefix, proxyToDeployedOrigin(process.env.PF_PROXY_ORIGIN as string)],
            ),
          )
        : {}),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // `infra/` holds the BFF and the music worker — separate services with
    // their own runners. The BFF's suite is written for `node --test` (that
    // server has no dependencies and is not going to grow one just to be
    // tested) and the worker's for Python's unittest. Vitest's default glob
    // picks up `infra/bff/*.test.mjs` and reports a passing suite as a
    // failure, so it is excluded here.
    //
    // Excluding infra rather than narrowing the include to `src/**`: two real
    // vitest suites live outside src (`postcss-flex-gap-fallback.test.mjs` and
    // `scripts/check-legacy-css.test.mjs`, 31 tests between them), and a
    // src-only include drops them silently — the run still says all green,
    // just about less.
    exclude: [...configDefaults.exclude, 'infra/**'],
  },
});
